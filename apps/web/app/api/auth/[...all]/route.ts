import { toNextJsHandler } from "better-auth/next-js";

import {
  AuthConfigurationUnavailableError,
  auth,
  isAuthConfigured,
  operatorAuth,
} from "../../../../auth";

export const runtime = "nodejs";

const betterAuthHandlers = toNextJsHandler(auth);
const operatorAuthHandlers = toNextJsHandler(operatorAuth);

const WRAPPED_AUTH_POST_PATHS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/magic-link",
  "/api/auth/request-password-reset",
  "/api/auth/sign-up/email",
  "/api/auth/send-verification-email",
]);

/**
 * Magic-link verification is the one GET that may create a workspace-free
 * operator account. Routing it through the operator instance is safe because
 * the app only mints those links after the exact `OPS_LEAD_EMAILS` check; the
 * catch-all POST below keeps the invite-only endpoints closed.
 */
const OPERATOR_AUTH_GET_PATHS = new Set(["/api/auth/magic-link/verify"]);
function canonicalAuthPath(request: Request): string | null {
  let path = new URL(request.url).pathname;
  if (path.length > 4096) return null;
  for (let pass = 0; pass < 4; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    path = decoded;
  }
  if (/%[0-9a-f]{2}/i.test(path)) return null;
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

function unavailable(): Response {
  return Response.json(
    {
      code: "authentication_unavailable",
      message: "Authentication is not configured.",
    },
    { status: 503 },
  );
}

function isConfigurationError(error: unknown): boolean {
  return (
    error instanceof AuthConfigurationUnavailableError ||
    (error instanceof Error &&
      error.name === "AuthConfigurationUnavailableError")
  );
}

export const GET = createAuthGetHandler({
  configured: isAuthConfigured,
  standard: betterAuthHandlers.GET,
  operator: operatorAuthHandlers.GET,
});

export type AuthGetHandlerDeps = {
  configured(): boolean;
  standard(request: Request): Promise<Response>;
  operator(request: Request): Promise<Response>;
};

export function createAuthGetHandler(deps: AuthGetHandlerDeps) {
  return async function authGet(request: Request): Promise<Response> {
    if (!deps.configured()) return unavailable();
    const path = canonicalAuthPath(request);
    const handler =
      path && OPERATOR_AUTH_GET_PATHS.has(path) ? deps.operator : deps.standard;
    try {
      return await handler(request);
    } catch (error) {
      if (isConfigurationError(error)) return unavailable();
      throw error;
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const path = canonicalAuthPath(request);
  if (path === null || WRAPPED_AUTH_POST_PATHS.has(path)) {
    return Response.json(
      {
        code: "not_found",
        message: "Unable to complete this request.",
      },
      { status: 404 },
    );
  }
  if (!isAuthConfigured()) return unavailable();
  try {
    return await betterAuthHandlers.POST(request);
  } catch (error) {
    if (isConfigurationError(error)) return unavailable();
    throw error;
  }
}
