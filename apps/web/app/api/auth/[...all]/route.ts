import { toNextJsHandler } from "better-auth/next-js";

import {
  AuthConfigurationUnavailableError,
  auth,
  isAuthConfigured,
} from "../../../../auth";

export const runtime = "nodejs";

const betterAuthHandlers = toNextJsHandler(auth);

const WRAPPED_AUTH_POST_PATHS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/magic-link",
  "/api/auth/request-password-reset",
  "/api/auth/sign-up/email",
  "/api/auth/send-verification-email",
]);
function canonicalAuthPostPath(request: Request): string | null {
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

export async function GET(request: Request): Promise<Response> {
  if (!isAuthConfigured()) return unavailable();
  try {
    return await betterAuthHandlers.GET(request);
  } catch (error) {
    if (isConfigurationError(error)) return unavailable();
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  const path = canonicalAuthPostPath(request);
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
