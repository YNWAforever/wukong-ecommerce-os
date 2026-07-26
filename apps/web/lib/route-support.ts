import { ZodError } from "zod";

import {
  SessionContextUnavailableError,
  type SessionContext,
  type SessionContextPort,
} from "./session-context-port";

type RuntimeConfigurationFailure = Error & { variable: string };

// Matched by name rather than instanceof. This helper is imported by every
// route, so it should not pull a package dependency in just to own a class
// identity, and that identity does not survive every bundling boundary.
function asRuntimeConfigurationError(
  error: unknown,
): RuntimeConfigurationFailure | null {
  if (!(error instanceof Error) || error.name !== "RuntimeConfigurationError") {
    return null;
  }
  const { variable } = error as { variable?: unknown };
  return typeof variable === "string"
    ? (error as RuntimeConfigurationFailure)
    : null;
}

function report(reason: string, detail: Record<string, string>): void {
  console.error(
    JSON.stringify({
      event: "route_error",
      outcome: "failure",
      reason,
      ...detail,
    }),
  );
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return Response.json(body, { status });
}

export async function requireSessionContext(
  port: SessionContextPort,
): Promise<SessionContext> {
  const context = await port.resolve();
  if (!context) {
    throw new ApiError(401, "unauthorized", "Authentication is required.");
  }
  return context;
}

export async function withRouteErrors(
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse(error.status, {
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return jsonResponse(400, {
        code: "invalid_request",
        message: "Request body is invalid.",
      });
    }
    if (error instanceof SessionContextUnavailableError) {
      return jsonResponse(503, {
        code: "authentication_unavailable",
        message: "Authentication is not configured.",
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      return jsonResponse(409, {
        code: "conflict",
        message: "The resource already exists.",
      });
    }
    const configurationFailure = asRuntimeConfigurationError(error);
    if (configurationFailure) {
      // The variable name is safe to log -- it is already listed in
      // .env.example. The value never is.
      report("runtime_not_configured", {
        variable: configurationFailure.variable,
      });
      return jsonResponse(503, {
        code: "runtime_unavailable",
        message: "This feature is not configured.",
      });
    }

    // Name only, never the message: an unexpected error can carry a connection
    // string or a signed URL, and the readiness gate scans runtime logs.
    report("internal_error", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return jsonResponse(500, {
      code: "internal_error",
      message: "The request could not be completed.",
    });
  }
}
