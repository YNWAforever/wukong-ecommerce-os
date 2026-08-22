import { describe, expect, it, vi } from "vitest";

import { ApiError, withRouteErrors } from "./route-support";

function configurationError(variable: string): Error {
  const error = new Error(`${variable} is required`);
  error.name = "RuntimeConfigurationError";
  return Object.assign(error, { variable });
}

async function captureErrorLogs(
  work: () => Promise<Response>,
): Promise<{ response: Response; lines: string[] }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await withRouteErrors(work);
    return { response, lines: spy.mock.calls.map(([line]) => String(line)) };
  } finally {
    spy.mockRestore();
  }
}

describe("withRouteErrors", () => {
  it("reports absent runtime configuration as 503 and names the variable", async () => {
    const { response, lines } = await captureErrorLogs(() => {
      throw configurationError("S3_BUCKET");
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "runtime_unavailable",
      message: "This feature is not configured.",
    });
    expect(lines).toContain(
      JSON.stringify({
        event: "route_error",
        outcome: "failure",
        reason: "runtime_not_configured",
        variable: "S3_BUCKET",
      }),
    );
  });

  it("logs an unexpected failure by name only, never its message", async () => {
    const leaky = new Error("postgres://user:hunter2@db.example.com/wukong");
    leaky.name = "ConnectionError";
    const { response, lines } = await captureErrorLogs(() => {
      throw leaky;
    });

    expect(response.status).toBe(500);
    expect(lines).toContain(
      JSON.stringify({
        event: "route_error",
        outcome: "failure",
        reason: "internal_error",
        errorName: "ConnectionError",
      }),
    );
    for (const line of lines) {
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("db.example.com");
    }
  });

  it("leaves a deliberate ApiError untouched and unlogged", async () => {
    const { response, lines } = await captureErrorLogs(() => {
      throw new ApiError(
        403,
        "insufficient_role",
        "Operator access is required.",
      );
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "insufficient_role",
      message: "Operator access is required.",
    });
    expect(lines).toEqual([]);
  });

  it("reports an unavailable queue as 503 and names which failure it was", async () => {
    const error = new Error("queue_unavailable");
    error.name = "QueueIngressError";
    const { response, lines } = await captureErrorLogs(() => {
      throw Object.assign(error, { reason: "not_configured" });
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "queue_unavailable",
      message: "The processing queue is unavailable.",
    });
    expect(lines).toContain(
      JSON.stringify({
        event: "route_error",
        outcome: "failure",
        reason: "queue_unavailable",
        queueReason: "not_configured",
      }),
    );
  });

  it("does not mistake an ordinary error for missing configuration", async () => {
    const impostor = new Error("nope");
    impostor.name = "RuntimeConfigurationError";
    const { response } = await captureErrorLogs(() => {
      throw impostor;
    });

    expect(response.status).toBe(500);
  });

  it("maps a MembershipGuardViolation-shaped error to 409 with its reason as the code", async () => {
    const error = new Error(
      "A workspace must keep at least one admin or owner.",
    );
    error.name = "MembershipGuardViolation";
    const { response, lines } = await captureErrorLogs(() => {
      throw Object.assign(error, { reason: "last_admin" });
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "last_admin",
      message: "A workspace must keep at least one admin or owner.",
    });
    expect(lines).toEqual([]);
  });

  it("does not mistake an ordinary error for a MembershipGuardViolation", async () => {
    const impostor = new Error("nope");
    impostor.name = "MembershipGuardViolation";
    const { response } = await captureErrorLogs(() => {
      throw impostor;
    });

    expect(response.status).toBe(500);
  });
});
