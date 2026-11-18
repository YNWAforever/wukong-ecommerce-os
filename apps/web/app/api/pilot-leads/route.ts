import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

import type { PilotLeadInput, PilotLeadReceipt } from "@wukong/db";

import { getDatabase } from "../../../lib/intake-runtime";
import {
  ApiError,
  createRouteDiagnostics,
  jsonResponse,
  withRouteErrors,
} from "../../../lib/route-support";

const MAX_BODY_BYTES = 16_384;

const platforms = [
  "shopline",
  "shopify",
  "carousell",
  "hktvmall",
  "other",
] as const;
const skuVolumes = ["under_100", "100_500", "500_2000", "over_2000"] as const;

/**
 * Fields the public marketing form is allowed to send. Unknown keys are
 * rejected so a future client cannot quietly start collecting extra personal
 * data that the privacy notice does not cover.
 */
const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.preprocess(
      (value) =>
        typeof value === "string" ? value.trim().toLowerCase() : value,
      z.email().max(254),
    ),
    company: z.string().trim().min(1).max(160),
    platforms: z
      .array(z.enum(platforms))
      .max(6)
      .refine((value) => new Set(value).size === value.length, {
        message: "platforms must be unique",
      })
      .default([]),
    skuVolume: z.enum(skuVolumes).optional(),
    message: z.string().trim().max(2_000).optional(),
    locale: z.enum(["en", "zh-Hant"]).default("en"),
    source: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .default("marketing"),
    consent: z.literal(true),
    // Cloudflare Turnstile token from the marketing form. Never persisted.
    turnstileToken: z.string().trim().max(4_096).optional(),
    // Honeypot: real users never fill this hidden field. It is not persisted.
    website: z.string().max(200).optional().default(""),
  })
  .strict();

export type PilotLeadStore = {
  createPilotLead(input: PilotLeadInput): Promise<PilotLeadReceipt | null>;
};

/** Injected in tests; runtime uses Cloudflare's siteverify endpoint. */
export type TurnstileCheck = (input: {
  token: string;
  remoteIp: string | null;
}) => Promise<boolean>;

export type PilotLeadPostDeps = {
  store: PilotLeadStore;
  /** When absent, no IP is stored and limiting falls back to the email only. */
  ipSalt?: string;
  allowedOrigins?: readonly string[];
  /** When absent, the endpoint relies on the honeypot and rolling limit. */
  turnstile?: TurnstileCheck;
  now?: () => Date;
};

function requestIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  const candidate = (forwarded ?? request.headers.get("x-real-ip"))?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

function normalizeOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function allowedOrigin(
  request: Request,
  origins: readonly string[],
): string | null {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return null;
  return origins.includes(origin) ? origin : null;
}

function applyCors(
  response: Response,
  origin: string | null,
  request: Request,
): Response {
  response.headers.set("Vary", "Origin");
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set(
      "Access-Control-Allow-Methods",
      request.method === "OPTIONS" ? "POST, OPTIONS" : "POST",
    );
    response.headers.set("Access-Control-Allow-Headers", "content-type");
    response.headers.set("Access-Control-Max-Age", "600");
  }
  return response;
}

function requestIpHash(request: Request, salt: string | undefined) {
  if (!salt) return null;
  const candidate = requestIp(request);
  if (!candidate) return null;
  return createHash("sha256").update(`${salt}:${candidate}`).digest("hex");
}

async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "Request body is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "Request body is invalid.");
  }
}

export function createPilotLeadPostHandler(deps: PilotLeadPostDeps) {
  return async function pilotLeadPost(request: Request): Promise<Response> {
    const origin = allowedOrigin(request, deps.allowedOrigins ?? []);
    const response = await withRouteErrors(async () => {
      const input = bodySchema.parse(await readBody(request));
      if (input.website.length > 0) {
        throw new ApiError(400, "invalid_request", "Request body is invalid.");
      }
      if (deps.turnstile) {
        const token = input.turnstileToken;
        const verified =
          token !== undefined &&
          (await deps.turnstile({ token, remoteIp: requestIp(request) }));
        if (!verified) {
          throw new ApiError(
            403,
            "bot_check_failed",
            "Bot verification failed.",
          );
        }
      }
      const lead = await deps.store.createPilotLead({
        name: input.name,
        email: input.email,
        company: input.company,
        platforms: input.platforms,
        skuVolume: input.skuVolume ?? null,
        message:
          input.message && input.message.length > 0 ? input.message : null,
        locale: input.locale,
        source: input.source,
        consentAt: deps.now ? deps.now() : new Date(),
        requestIpHash: requestIpHash(request, deps.ipSalt),
        userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      });
      if (!lead) {
        const limited = jsonResponse(429, {
          code: "rate_limited",
          message: "Too many requests. Try again later.",
        });
        limited.headers.set("Retry-After", "600");
        return limited;
      }
      return jsonResponse(201, {
        ok: true,
        id: lead.id,
        receivedAt: lead.createdAt.toISOString(),
      });
    }, createRouteDiagnostics());
    return applyCors(response, origin, request);
  };
}

export function createPilotLeadOptionsHandler(deps: {
  allowedOrigins?: readonly string[];
}) {
  return function pilotLeadOptions(request: Request): Response {
    const origin = allowedOrigin(request, deps.allowedOrigins ?? []);
    return applyCors(new Response(null, { status: 204 }), origin, request);
  };
}

function cloudflareTurnstile(secret: string): TurnstileCheck {
  return async ({ token, remoteIp }) => {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    try {
      const response = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) return false;
      const result = (await response.json()) as { success?: unknown };
      return result.success === true;
    } catch {
      // Fail closed: an unavailable verifier must not turn into an open form.
      return false;
    }
  };
}

function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter((origin): origin is string => origin !== null);
}

const allowedOrigins = parseAllowedOrigins(
  process.env.PILOT_LEAD_ALLOWED_ORIGINS,
);

export const POST = createPilotLeadPostHandler({
  store: {
    createPilotLead: (input) => getDatabase().createPilotLead(input),
  },
  ipSalt: process.env.PILOT_LEAD_IP_SALT,
  allowedOrigins,
  turnstile: process.env.PILOT_LEAD_TURNSTILE_SECRET
    ? cloudflareTurnstile(process.env.PILOT_LEAD_TURNSTILE_SECRET)
    : undefined,
});

export const OPTIONS = createPilotLeadOptionsHandler({ allowedOrigins });
