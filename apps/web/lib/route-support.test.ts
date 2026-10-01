import { describe, expect, it, vi } from "vitest";

import { ApiError, atRouteStage, withRouteErrors } from "./route-support";

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
  it("keeps each concurrent failure's original stage and rejects untrusted correlation IDs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const responses = await Promise.all(
        ["review", "sources"].map((stage) =>
          withRouteErrors(
            () =>
              atRouteStage(stage as "review" | "sources", async () => {
                await Promise.resolve();
                throw Object.assign(new Error("secret"), { code: "42P01" });
              }),
            { requestId: "untrusted\nlog injection" },
          ),
        ),
      );
      for (const response of responses)
        expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
      expect(
        spy.mock.calls.map(([line]) => JSON.parse(String(line)).stage).sort(),
      ).toEqual(["review", "sources"]);
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|injection/);
    } finally {
      spy.mockRestore();
    }
  });
  it("correlates an instrumented failure without exposing the exception or deployment secrets", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const requestId = "00000000-0000-4000-8000-000000000123";
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_synthetic123");
    try {
      const response = await withRouteErrors(
        async () => {
          throw Object.assign(
            new Error("SQL and customer prompt postgres://secret"),
            {
              cause: Object.assign(new Error("private query"), {
                code: "42501",
              }),
            },
          );
        },
        { requestId, stage: "sources" },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: "internal_error",
        message: "The request could not be completed.",
        requestId,
      });
      expect(response.headers.get("x-request-id")).toBe(requestId);
      expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
        requestId,
        stage: "sources",
        code: "permission_denied",
        commitSha: "a".repeat(40),
        deploymentId: "dpl_synthetic123",
      });
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(
        /customer|prompt|postgres|secret|private query/,
      );
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("retains authorization errors with an opaque support ID on instrumented routes", async () => {
    const requestId = "00000000-0000-4000-8000-000000000124";
    const response = await withRouteErrors(
      async () => {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      },
      { requestId, stage: "session" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "insufficient_role",
      message: "Operator access is required.",
      requestId,
    });
  });

  it("never logs arbitrary error names or multiline message locations on instrumented routes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fault = new Error(
        "synthetic failure\n synthetic/customer-secret:12:34",
      );
      fault.name = "synthetic_customer_secret";
      const response = await withRouteErrors(
        async () => {
          throw fault;
        },
        { requestId: "00000000-0000-4000-8000-000000000125", stage: "listing" },
      );
      expect(response.status).toBe(500);
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(
        /synthetic_customer_secret|customer-secret|errorName|errorSite/,
      );
      expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
        stage: "listing",
        code: "unknown",
      });
    } finally {
      spy.mockRestore();
    }
  });

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
    const [logged] = lines;
    expect(JSON.parse(logged!)).toMatchObject({
      event: "route_error",
      outcome: "failure",
      reason: "internal_error",
      errorName: "ConnectionError",
      // A source location, so the reader can tell one plain `Error` from
      // another. Asserted as a shape rather than a literal because the frame
      // moves whenever this test file does.
      errorSite: expect.stringMatching(
        /^[\w.-]+[/\\][\w.-]+:\d+:\d+$|^unknown$/,
      ),
    });
    for (const line of lines) {
      expect(line).not.toContain("hunter2");
      expect(line).not.toContain("db.example.com");
      expect(line).not.toContain("postgres://");
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
