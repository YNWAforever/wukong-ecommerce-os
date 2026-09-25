import type { VerificationResult } from "@wukong/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256, verifyAdvisory } from "./listing-verification-support.js";
import { listing, facts, evidence } from "./pipeline-test-support.js";
const input = { listing, facts, evidence, note: null };
afterEach(() => vi.useRealTimers());
describe("advisory boundary", () => {
  it("hashes canonical keys and distinguishes full content and evidence", async () => {
    expect(await sha256({ b: 2, a: { d: 4, c: 3 } })).toBe(
      await sha256({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(await sha256(listing)).not.toBe(
      await sha256({ ...listing, tags: ["new"] }),
    );
    expect(await sha256({ facts, evidence, note: null })).not.toBe(
      await sha256({ facts, evidence: [], note: null }),
    );
  });
  it("sanitizes throws", async () => {
    const result = await verifyAdvisory(input, {
      verify: vi.fn().mockRejectedValue(new Error("private provider detail")),
    });
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "network",
      actualModel: null,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("sanitizes malformed returns while preserving validated usage", async () => {
    const result = await verifyAdvisory(input, {
      verify: vi.fn().mockResolvedValue({
        private: "secret",
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          estimatedCostUsd: null,
          pricingVersion: null,
          latencyMs: 1,
          requestAttempted: true,
        },
      }),
    });
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "invalid_response",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("bounds injected verifiers to five seconds", async () => {
    vi.useFakeTimers();
    const verify = vi.fn(() => new Promise<never>(() => {}));
    const pending = verifyAdvisory(input, { verify });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({
      outcome: "unavailable",
      reason: "timeout",
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

it("keeps validated usage when returned verifier work exceeds the deadline", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const result = await verifyAdvisory(input, {
    verify: vi.fn(async (): Promise<VerificationResult> => {
      vi.setSystemTime(start + 5001);
      return {
        schemaVersion: 1,
        questionSetVersion: "jev-listing-v1",
        mode: "advisory",
        outcome: "unavailable",
        reason: "http",
        requestedModel: "alias",
        actualModel: null,
        checkedAt: new Date().toISOString(),
        checks: [],
        numericDifferences: [],
        usage: {
          inputTokens: 13,
          outputTokens: 8,
          estimatedCostUsd: 0.0042,
          pricingVersion: "2026-09-01",
          latencyMs: 5001,
          requestAttempted: true,
        },
      };
    }),
  });
  expect(result).toMatchObject({
    outcome: "unavailable",
    reason: "timeout",
    usage: {
      inputTokens: 13,
      outputTokens: 8,
      estimatedCostUsd: 0.0042,
      pricingVersion: "2026-09-01",
      latencyMs: 5001,
      requestAttempted: true,
    },
  });
});

it("does not preserve malformed usage from an over-budget verifier result", async () => {
  vi.useFakeTimers();
  const start = Date.now();
  const result = await verifyAdvisory(input, {
    verify: vi.fn(async (): Promise<VerificationResult> => {
      vi.setSystemTime(start + 5001);
      return {
        usage: {
          inputTokens: -1,
          outputTokens: "private",
          estimatedCostUsd: Number.NaN,
          pricingVersion: { private: "secret" },
          latencyMs: -4,
          requestAttempted: true,
        },
      } as unknown as VerificationResult;
    }),
  });
  expect(result).toMatchObject({
    outcome: "unavailable",
    reason: "timeout",
    usage: {
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      pricingVersion: null,
      latencyMs: 5001,
      requestAttempted: true,
    },
  });
  expect(JSON.stringify(result)).not.toContain("private");
});
