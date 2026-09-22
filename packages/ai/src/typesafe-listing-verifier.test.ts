import { afterEach, describe, expect, it, vi } from "vitest";
import { verificationFixture } from "./listing-verification-fixture.js";
import { createTypeSafeListingVerifier } from "./typesafe-listing-verifier.js";

function payload(request: { questions: Record<string, unknown> }) {
  return {
    model: "jev-1.13.0",
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { type: "noul", noul: 0.2 },
      ]),
    ),
    usage: { input_tokens: 1_000, output_tokens: 20 },
  };
}
function jsonFetch(
  transform: (value: ReturnType<typeof payload>) => unknown = (v) => v,
) {
  return vi.fn<typeof fetch>(async (_url, init) =>
    Response.json(transform(payload(JSON.parse(String(init?.body))))),
  );
}
afterEach(() => vi.useRealTimers());

describe("createTypeSafeListingVerifier", () => {
  it("sends one bounded request and returns all nine checks", async () => {
    const fakeFetch = jsonFetch();
    const input = structuredClone(verificationFixture);
    input.note = null;
    input.evidence = [];
    input.facts.vintage = null;
    const result = await createTypeSafeListingVerifier({
      apiKey: "test-only",
      model: "jev-1.13.0",
      fetch: fakeFetch,
    }).verify(input);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch.mock.calls[0]?.[0]).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    expect(fakeFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(result.outcome).toBe("completed");
    expect(result.checks).toHaveLength(9);
    expect(
      result.checks.find((check) => check.id === "vintage")?.assessment,
    ).toBe("insufficient_evidence");
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.000042, 9);
  });

  it.each([401, 429, 529])("does not retry HTTP %s", async (status) => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response("private", { status }),
    );
    const result = await createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: fakeFetch,
    }).verify(verificationFixture);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "http",
      actualModel: null,
      usage: {
        requestAttempted: true,
        inputTokens: null,
        estimatedCostUsd: null,
      },
    });
  });

  it.each([
    ["invalid JSON", vi.fn<typeof fetch>(async () => new Response("{"))],
    [
      "extra answer",
      jsonFetch((p) => ({
        ...p,
        answers: { ...p.answers, extra: { type: "noul", noul: 0.1 } },
      })),
    ],
    [
      "missing answer",
      jsonFetch((p) => ({
        ...p,
        answers: Object.fromEntries(Object.entries(p.answers).slice(1)),
      })),
    ],
    [
      "invalid probability",
      jsonFetch((p) => ({
        ...p,
        answers: {
          ...p.answers,
          [Object.keys(p.answers)[0]!]: { type: "noul", noul: 2 },
        },
      })),
    ],
    [
      "wrong type",
      jsonFetch((p) => ({
        ...p,
        answers: {
          ...p.answers,
          [Object.keys(p.answers)[0]!]: { type: "choice", noul: 0.2 },
        },
      })),
    ],
    ["blank model", jsonFetch((p) => ({ ...p, model: "  " }))],
  ])("rejects %s", async (_name, fakeFetch) => {
    const result = await createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: fakeFetch,
    }).verify(verificationFixture);
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "invalid_response",
      actualModel: null,
    });
  });

  it("preserves valid usage when answers are malformed", async () => {
    const result = await createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: jsonFetch((p) => ({ ...p, answers: {} })),
    }).verify(verificationFixture);
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "invalid_response",
      usage: {
        inputTokens: 1_000,
        outputTokens: 20,
        estimatedCostUsd: 0.000042,
      },
    });
  });

  it("completes without usage and leaves cost unknown", async () => {
    const result = await createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: jsonFetch(({ usage: _usage, ...p }) => p),
    }).verify(verificationFixture);
    expect(result).toMatchObject({
      outcome: "completed",
      usage: { inputTokens: null, outputTokens: null, estimatedCostUsd: null },
    });
  });

  it("leaves cost unknown for an unpriced actual model", async () => {
    const result = await createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-latest",
      fetch: jsonFetch((p) => ({ ...p, model: "jev-future" })),
    }).verify(verificationFixture);
    expect(result).toMatchObject({
      outcome: "completed",
      actualModel: "jev-future",
      usage: { inputTokens: 1_000, estimatedCostUsd: null },
    });
  });

  it("rejects a response over 64 KiB", async () => {
    const result = await createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: async () => new Response("x".repeat(65_537)),
    }).verify(verificationFixture);
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "invalid_response",
    });
  });

  it("times out fetch and aborts after five seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>(() => {});
    });
    const pending = createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: fakeFetch,
    }).verify(verificationFixture);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "timeout",
      usage: { requestAttempted: true, estimatedCostUsd: null },
    });
  });

  it("times out a hanging body under the same deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = createTypeSafeListingVerifier({
      apiKey: "key",
      model: "jev-1.13.0",
      fetch: async () => new Response(stream),
    }).verify(verificationFixture);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(cancelled).toBe(true);
    expect(result.reason).toBe("timeout");
  });

  it("makes zero calls for skips and missing configuration", async () => {
    const fakeFetch = jsonFetch();
    const invalid = structuredClone(verificationFixture);
    invalid.listing.abvPercent = Number.NaN;
    const oversized = structuredClone(verificationFixture);
    oversized.note = "酒".repeat(12_000);
    for (const [options, input, reason] of [
      [{ apiKey: "key", model: "jev-1.13.0" }, invalid, "invalid_input"],
      [{ apiKey: "key", model: "jev-1.13.0" }, oversized, "input_too_large"],
      [{ apiKey: "", model: "" }, verificationFixture, "configuration"],
    ] as const) {
      const result = await createTypeSafeListingVerifier({
        ...options,
        fetch: fakeFetch,
      }).verify(input);
      expect(result.reason).toBe(reason);
      expect(result.usage).toMatchObject({
        requestAttempted: false,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
      expect(result.requestedModel.length).toBeGreaterThan(0);
    }
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("does not log secrets or source content on network failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const input = structuredClone(verificationFixture);
    input.note = "private-source";
    const result = await createTypeSafeListingVerifier({
      apiKey: "secret-key",
      model: "jev-1.13.0",
      fetch: async () => {
        throw new Error("transport");
      },
    }).verify(input);
    expect(result.reason).toBe("network");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
