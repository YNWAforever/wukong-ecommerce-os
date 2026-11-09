import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

import { getDatabase } from "../../../../../../lib/intake-runtime";
import { ApiError, withRouteErrors } from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import { canonicalJson } from "../../../../../../lib/studio/output-service";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../../lib/studio/turn-service";
import { buildStudioOutputPdf } from "./pdf-export";

/**
 * `GET /api/studio/outputs/[id]/export` (plan Task 11 + B2).
 *
 * Returns a signed-by-digest export of a persisted Studio artifact. The caller
 * passes the `digest` it previewed (the version's `contentDigest` from
 * `GET /api/studio/outputs/[id]`), and a mismatch is a 409 rather than serving
 * content that changed since the operator looked.
 *
 * `format=json` (the default, unchanged) is the canonical `sorted-json-v1`
 * packet with `payloadSha256` outside the payload. `format=pdf` renders the
 * same packet server-side with `pdf-lib` for a human-readable printout. Both
 * formats run after the exact same checks:
 *
 *  - only a `saved` or `signed_off` artifact is exportable;
 *  - the persisted payload is re-hashed and must match its stored digest;
 *  - a foreign or disabled-Studio id is the same 404 as any other artifact;
 *  - an unsupported or missing-value format is a 400.
 */

const digestQuerySchema = z.object({
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .max(64),
});

const EXPORT_FORMATS = ["json", "pdf"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

const EXPORTABLE_STATUSES = new Set(["saved", "signed_off"]);
const SCHEMA_VERSION = "wukong-studio-output-export/v1";

/**
 * Optional HMAC-SHA256 export receipt (B3).
 *
 * When `STUDIO_EXPORT_SIGNING_KEY` is configured, the canonical JSON packet
 * carries a `receipt` over a small, fixed message. The key is read from the
 * server environment only, never returned; `STUDIO_EXPORT_SIGNING_KEY_ID` is
 * the only key identity that appears in the packet. Without the key the packet
 * says `signed: false` and has no `receipt` object — no fake signature is ever
 * emitted. PDF exports are unchanged: they rely on the payload digest header.
 */
export type StudioExportReceipt = {
  alg: "HMAC-SHA256";
  keyId: string;
  signedAt: string;
  payloadSha256: string;
  signature: string;
};

export type StudioExportReceiptInput = {
  schemaVersion: string;
  payloadSha256: string;
  outputId: string;
  revision: number;
  asOf: string;
  keyId: string;
};

/** The exact bytes a verifier must feed to HMAC. Exported for tests/docs. */
export function exportReceiptMessage(input: StudioExportReceiptInput): string {
  return canonicalJson({
    schemaVersion: input.schemaVersion,
    payloadSha256: input.payloadSha256,
    outputId: input.outputId,
    revision: input.revision,
    asOf: input.asOf,
    keyId: input.keyId,
  });
}

export function signStudioExportReceipt(
  key: Buffer,
  input: StudioExportReceiptInput & { signedAt: string },
): StudioExportReceipt {
  return {
    alg: "HMAC-SHA256",
    keyId: input.keyId,
    signedAt: input.signedAt,
    payloadSha256: input.payloadSha256,
    signature: createHmac("sha256", key)
      .update(exportReceiptMessage(input))
      .digest("hex"),
  };
}

/** Decode a hex or base64 signing key; `null` when absent, `false` invalid. */
export function decodeExportSigningKey(
  raw: string | undefined,
): Buffer | false | null {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return null;
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "base64");
  } else {
    return false;
  }
  // 16 bytes is the shortest key that can be considered a secret rather than a
  // typo; HMAC-SHA256 itself accepts any length, so this is a config guard.
  return key.length >= 16 ? key : false;
}

function signingConfig(env: NodeJS.ProcessEnv): {
  key: Buffer;
  keyId: string;
} | null {
  const key = decodeExportSigningKey(env.STUDIO_EXPORT_SIGNING_KEY);
  if (key === null) return null;
  if (key === false)
    throw new ApiError(
      500,
      "export_signing_misconfigured",
      "The export signing key is not available.",
    );
  const rawKeyId = (env.STUDIO_EXPORT_SIGNING_KEY_ID ?? "").trim();
  const keyId = rawKeyId.length === 0 ? "v1" : rawKeyId;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(keyId))
    throw new ApiError(
      500,
      "export_signing_misconfigured",
      "The export signing key id is not available.",
    );
  return { key, keyId };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseFormat(url: URL): ExportFormat {
  const raw = url.searchParams.get("format");
  // Absent means the original JSON contract; an explicit but unknown value is
  // a client error rather than a silent fallback to a different format.
  if (raw === null) return "json";
  if (raw === "json" || raw === "pdf") return raw;
  throw new ApiError(
    400,
    "invalid_request",
    `Export format must be one of: ${EXPORT_FORMATS.join(", ")}.`,
  );
}

export function createStudioOutputExportHandler(deps: StudioRouteDeps) {
  const service = () => createStudioService(studioServiceDeps(deps));
  return async function exportOutput(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    return withRouteErrors(async () => {
      const { id } = await context.params;
      const url = new URL(request.url);
      const format = parseFormat(url);
      const digest = digestQuerySchema.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (!digest.success)
        throw new ApiError(
          400,
          "invalid_request",
          "A preview digest is required.",
        );

      // getOutput applies the Studio gate, workspace scoping and a foreign-id
      // 404 before anything below reads a payload.
      const bundle = await service().getOutput(id);
      if (!EXPORTABLE_STATUSES.has(bundle.output.status))
        throw new ApiError(
          409,
          "output_not_saved",
          "Save the artifact before exporting it.",
        );

      const latest = bundle.versions.reduce((current, version) =>
        version.revision > current.revision ? version : current,
      );
      if (latest.contentDigest !== digest.data.digest)
        throw new ApiError(
          409,
          "output_changed",
          "The artifact changed since this preview.",
        );
      if (sha256(canonicalJson(latest.payload)) !== latest.contentDigest)
        throw new ApiError(
          409,
          "output_changed",
          "The persisted artifact content no longer matches its digest.",
        );

      const packet = {
        schemaVersion: SCHEMA_VERSION,
        canonicalization: "sorted-json-v1" as const,
        output: {
          outputId: bundle.output.outputId,
          kind: bundle.output.kind,
          title: bundle.output.title,
          status: bundle.output.status,
          revision: latest.revision,
          asOf: latest.asOf,
          scope: latest.scope,
        },
        payload: latest.payload,
        payloadSha256: latest.contentDigest,
      };

      if (format === "pdf") {
        const pdfBytes = await buildStudioOutputPdf({
          outputId: packet.output.outputId,
          kind: packet.output.kind,
          title: packet.output.title,
          status: packet.output.status,
          revision: packet.output.revision,
          asOf: packet.output.asOf,
          scope: packet.output.scope,
          payload: packet.payload,
          payloadSha256: packet.payloadSha256,
        });
        // Copy into an owned buffer so the body is a plain ArrayBuffer-backed
        // `Uint8Array` for `Response`.
        const bytes = Uint8Array.from(pdfBytes);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": `attachment; filename="studio-output-${packet.output.outputId}-r${latest.revision}.pdf"`,
            "cache-control": "no-store",
            "content-length": String(bytes.byteLength),
          },
        });
      }

      // A signing problem is reported before any export bytes are served and
      // never falls back to an unsigned packet while a key is configured.
      const signing = signingConfig(deps.env ?? process.env);
      const receipt = signing
        ? signStudioExportReceipt(signing.key, {
            schemaVersion: SCHEMA_VERSION,
            payloadSha256: packet.payloadSha256,
            outputId: packet.output.outputId,
            revision: latest.revision,
            asOf: packet.output.asOf,
            keyId: signing.keyId,
            signedAt: (deps.now?.() ?? new Date()).toISOString(),
          })
        : null;
      const jsonPacket = receipt
        ? { ...packet, signed: true as const, receipt }
        : { ...packet, signed: false as const };
      const json = canonicalJson(jsonPacket);
      return new Response(json, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="studio-output-${bundle.output.outputId}-r${latest.revision}.json"`,
          "cache-control": "no-store",
        },
      });
    });
  };
}

const handler = createStudioOutputExportHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handler;
