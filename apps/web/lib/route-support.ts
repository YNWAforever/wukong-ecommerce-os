import { ZodError } from "zod";

import {
  SessionContextUnavailableError,
  type SessionContext,
  type SessionContextPort,
} from "./session-context-port";

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
      return jsonResponse(error.status, { code: error.code, message: error.message });
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
    return jsonResponse(500, {
      code: "internal_error",
      message: "The request could not be completed.",
    });
  }
}
