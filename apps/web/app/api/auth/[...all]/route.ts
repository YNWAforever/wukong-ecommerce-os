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
]);
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
  if (WRAPPED_AUTH_POST_PATHS.has(new URL(request.url).pathname)) {
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
