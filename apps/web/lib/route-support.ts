import { ZodError } from "zod";

import {
  SessionContextUnavailableError,
  type SessionContext,
  type SessionContextPort,
} from "./session-context-port";

export type DiagnosticStage =
  | "session"
  | "listing"
  | "review"
  | "sources"
  | "assets"
  | "activity"
  | "unknown";
export type RouteDiagnostics = { requestId: string; stage?: DiagnosticStage };

class RouteStageError extends Error {
  constructor(
    readonly stage: DiagnosticStage,
    readonly original: unknown,
  ) {
    super("route stage failed");
  }
}

export function createRouteDiagnostics(): RouteDiagnostics {
  return { requestId: crypto.randomUUID() };
}

// The stage travels with the failure, rather than a shared mutable variable:
// concurrent row reads cannot overwrite the failing row's stage.
export async function atRouteStage<T>(
  stage: DiagnosticStage,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RouteStageError) throw error;
    throw new RouteStageError(stage, error);
  }
}

function diagnosticCode(error: unknown): string {
  const codes: Record<string, string> = {
    "42501": "permission_denied",
    "42P01": "schema_unavailable",
    "42703": "schema_unavailable",
    "25P02": "transaction_unavailable",
    "08006": "database_unavailable",
    "08001": "database_unavailable",
    "53300": "database_unavailable",
    "57P01": "database_unavailable",
    ECONNREFUSED: "database_unavailable",
    ECONNRESET: "database_unavailable",
    ETIMEDOUT: "database_unavailable",
  };
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) break;
    if (
      "code" in current &&
      typeof current.code === "string" &&
      codes[current.code]
    )
      return codes[current.code]!;
    if ("name" in current && current.name === "ListingDataError")
      return "invalid_record";
    current = "cause" in current ? current.cause : null;
  }
  return "unknown";
}

function deploymentIdentity() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.BUILD_SHA;
  const deployment = process.env.VERCEL_DEPLOYMENT_ID;
  return {
    commitSha: sha && /^[a-f0-9]{40}$/i.test(sha) ? sha : "unknown",
    deploymentId:
      deployment && /^dpl_[a-zA-Z0-9]{1,80}$/.test(deployment)
        ? deployment
        : "unknown",
  };
}

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

type QueueIngressFailure = Error & { reason: string };

function asQueueIngressError(error: unknown): QueueIngressFailure | null {
  if (!(error instanceof Error) || error.name !== "QueueIngressError") {
    return null;
  }
  const { reason } = error as { reason?: unknown };
  return typeof reason === "string" ? (error as QueueIngressFailure) : null;
}

// For the enqueue sites that deliberately do not fail the request. They still
// have to say why the queue was unavailable, and detection belongs in one
// place rather than being re-implemented per route.
export function queueIngressReason(error: unknown): string | null {
  return asQueueIngressError(error)?.reason ?? null;
}

type MembershipGuardFailure = Error & { reason: string };

// Matched by name rather than instanceof, for the same reason as
// asRuntimeConfigurationError/asQueueIngressError above: this helper is
// imported by every membership route, so it should not pull in @wukong/db
// just to own a class identity, and that identity does not survive every
// bundling boundary.
function asMembershipGuardViolation(
  error: unknown,
): MembershipGuardFailure | null {
  if (!(error instanceof Error) || error.name !== "MembershipGuardViolation") {
    return null;
  }
  const { reason } = error as { reason?: unknown };
  return typeof reason === "string" ? (error as MembershipGuardFailure) : null;
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

/**
 * Where an unexpected error was thrown -- never what it said.
 *
 * `errorName: "Error"` on its own is undiagnosable: every plain `Error` in the
 * codebase reports identically, so a 500 in CI gives a reader nothing to go on
 * but the route. A stack frame is our own source location, so it carries no
 * connection string, signed URL, prompt or customer content, and stays inside
 * the rule the caller documents.
 */
function throwSite(error: unknown): string {
  const stack = error instanceof Error ? error.stack : undefined;
  if (typeof stack !== "string") return "unknown";
  for (const line of stack.split("\n").slice(1)) {
    const frame = /([\w.-]+[/\\][\w.-]+:\d+:\d+)/.exec(line);
    if (frame?.[1]) return frame[1];
  }
  return "unknown";
}

/**
 * Logs an error no handler classified. Name and throw site only, never the
 * message: an unexpected error can carry a connection string or a signed URL,
 * and the readiness gate scans runtime logs. `detail` must hold IDs only.
 */
export function reportUnexpectedError(
  error: unknown,
  detail: Record<string, string> = {},
): void {
  report("internal_error", {
    ...detail,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorSite: throwSite(error),
  });
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
  diagnostics?: RouteDiagnostics,
): Promise<Response> {
  const requestId = diagnostics
    ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        diagnostics.requestId,
      )
      ? diagnostics.requestId
      : crypto.randomUUID()
    : undefined;
  const errorResponse = (status: number, body: Record<string, unknown>) => {
    const response = jsonResponse(status, {
      ...body,
      ...(requestId ? { requestId } : {}),
    });
    if (requestId) response.headers.set("x-request-id", requestId);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  try {
    const response = await work();
    if (requestId) {
      response.headers.set("x-request-id", requestId);
      response.headers.set("Cache-Control", "no-store");
    }
    return response;
  } catch (caught) {
    const error = caught instanceof RouteStageError ? caught.original : caught;
    const detail = requestId
      ? {
          requestId,
          stage:
            caught instanceof RouteStageError
              ? caught.stage
              : (diagnostics?.stage ?? "unknown"),
          code: diagnosticCode(error),
          ...deploymentIdentity(),
        }
      : {};
    if (error instanceof ApiError) {
      return errorResponse(error.status, {
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return errorResponse(400, {
        code: "invalid_request",
        message: "Request body is invalid.",
      });
    }
    if (error instanceof SessionContextUnavailableError) {
      return errorResponse(503, {
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
      return errorResponse(409, {
        code: "conflict",
        message: "The resource already exists.",
      });
    }
    const membershipGuardFailure = asMembershipGuardViolation(error);
    if (membershipGuardFailure) {
      return errorResponse(409, {
        code: membershipGuardFailure.reason,
        message: membershipGuardFailure.message,
      });
    }
    const configurationFailure = asRuntimeConfigurationError(error);
    if (configurationFailure) {
      // The variable name is safe to log -- it is already listed in
      // .env.example. The value never is.
      report("runtime_not_configured", {
        variable: configurationFailure.variable,
        ...detail,
      });
      return errorResponse(503, {
        code: "runtime_unavailable",
        message: "This feature is not configured.",
      });
    }

    const queueFailure = asQueueIngressError(error);
    if (queueFailure) {
      report("queue_unavailable", {
        queueReason: queueFailure.reason,
        ...detail,
      });
      return errorResponse(503, {
        code: "queue_unavailable",
        message: "The processing queue is unavailable.",
      });
    }

    // Name only, never the message: an unexpected error can carry a connection
    // string or a signed URL, and the readiness gate scans runtime logs.
    report("internal_error", {
      ...(diagnostics
        ? {}
        : {
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorSite: throwSite(error),
          }),
      ...detail,
    });
    return errorResponse(500, {
      code: "internal_error",
      message: "The request could not be completed.",
    });
  }
}
