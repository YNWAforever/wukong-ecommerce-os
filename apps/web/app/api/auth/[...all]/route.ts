import { toNextJsHandler } from "better-auth/next-js";

import {
  AuthConfigurationUnavailableError,
  auth,
  isAuthConfigured,
} from "../../../../auth";

export const runtime = "nodejs";

const betterAuthHandlers = toNextJsHandler(auth);

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
  if (!isAuthConfigured()) return unavailable();
  try {
    return await betterAuthHandlers.POST(request);
  } catch (error) {
    if (isConfigurationError(error)) return unavailable();
    throw error;
  }
}
