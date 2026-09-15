import { describe, expect, it } from "vitest";

import {
  ProviderApiError,
  providerFailureDiagnostic,
  type PhysicalInvocationObserver,
} from "./listing-provider-errors.js";

describe("provider failure diagnostics", () => {
  it.each([
    [
      { status: 429, code: "rate_limit_exceeded", request_id: "req_abc-123" },
      "rate_limited",
    ],
    [{ status: 503, code: "server_error" }, "provider_unavailable"],
    [new DOMException("secret", "AbortError"), "timeout"],
    [{ status: 400, code: "invalid_image" }, "invalid_media"],
    [{ status: 401, code: "invalid_api_key" }, "missing_configuration"],
  ] as const)("classifies allowlisted metadata %#", (error, category) => {
    expect(providerFailureDiagnostic(error)).toMatchObject({ category });
  });

  it("drops provider messages, unsafe codes, and unsafe request IDs", () => {
    expect(
      providerFailureDiagnostic({
        status: 500,
        code: "SECRET_CODE",
        request_id: "https://private.invalid/?token=SECRET",
        message: "SECRET prompt and payload",
      }),
    ).toEqual({
      category: "provider_unavailable",
      retryable: true,
      httpStatus: 500,
      providerCode: null,
      requestId: null,
    });
  });

  it("carries unknown usage as null rather than successful zero", () => {
    const error = new ProviderApiError("AI provider request failed", {
      ...providerFailureDiagnostic(new Error("socket closed")),
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        certainty: "unknown",
      },
    });

    expect(error.diagnostic.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      certainty: "unknown",
    });
    expect(JSON.stringify(error)).not.toContain("socket closed");
  });

  it("defines one callback record per physical invocation", () => {
    const records: Parameters<PhysicalInvocationObserver>[0][] = [];
    const observer: PhysicalInvocationObserver = (record) =>
      records.push(record);
    observer({
      ordinal: 1,
      phase: "request",
      outcome: "invalid_output",
      diagnostic: {
        category: "invalid_output",
        retryable: false,
        httpStatus: 200,
        providerCode: null,
        requestId: "req_safe",
      },
      usage: {
        inputTokens: 42,
        outputTokens: 7,
        costUsd: null,
        certainty: "unknown",
      },
    });
    expect(records).toHaveLength(1);
  });
});
