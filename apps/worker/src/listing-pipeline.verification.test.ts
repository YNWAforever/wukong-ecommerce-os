import { expect, it, vi } from "vitest";
import {
  CHECK_FIELDS,
  CHECK_IDS,
  QUESTION_SET_VERSION,
  type VerificationResult,
} from "@wukong/ai";
import { runListingPipeline } from "./listing-pipeline.js";
import {
  makeHarness,
  makeTransactionAwareHarness,
  workspaceId,
  draftId,
  listing,
  facts,
  evidence,
} from "./pipeline-test-support.js";
import { sha256 } from "./listing-verification-support.js";
const input = { workspaceId, draftId, activeVersionSequence: 0 };
export const successfulVerification: VerificationResult = {
  schemaVersion: 1,
  questionSetVersion: QUESTION_SET_VERSION,
  mode: "advisory",
  outcome: "completed",
  reason: null,
  requestedModel: "alias",
  actualModel: "actual",
  checkedAt: "2026-09-22T00:00:00Z",
  checks: CHECK_IDS.map((id) => ({
    id,
    fields: CHECK_FIELDS[id],
    assessment: "assessed",
    probability: 0.9,
  })),
  numericDifferences: [],
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    estimatedCostUsd: null,
    pricingVersion: null,
    latencyMs: 2,
    requestAttempted: true,
  },
};
it("off creates no verification row", async () => {
  const { deps, state } = makeHarness();
  await runListingPipeline(input, deps);
  expect(state.verificationRuns).toEqual([]);
});
it("keeps failure advisory and reuses completed work", async () => {
  const { deps, state } = makeHarness();
  const verify = vi
    .fn()
    .mockRejectedValue(new Error("private provider detail"));
  deps.verifier = { verify };
  const first = await runListingPipeline(input, deps);
  expect(first.status).toBe("in_review");
  expect(state.verificationRuns[0]?.record).toMatchObject({
    outcome: "unavailable",
    listingVersionId: first.versionId,
  });
  await expect(runListingPipeline(input, deps)).resolves.toEqual(first);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(state.verificationRuns).toHaveLength(1);
});
it("records success against the version with independent digests outside transactions", async () => {
  const { deps, state } = makeHarness();
  let inTransaction = false;
  const original = deps.withWorkspace;
  deps.withWorkspace = async (id, work) => {
    inTransaction = true;
    try {
      return await original(id, work);
    } finally {
      inTransaction = false;
    }
  };
  deps.verifier = {
    verify: vi.fn(async () => {
      expect(inTransaction).toBe(false);
      return successfulVerification;
    }),
  };
  const result = await runListingPipeline(input, deps);
  expect(state.verificationRuns[0]).toMatchObject({
    idempotencyKey: expect.stringContaining(":verify:" + QUESTION_SET_VERSION),
    record: {
      ...successfulVerification,
      listingVersionId: result.versionId,
      contentDigest: await sha256(listing),
      evidenceDigest: await sha256({ facts, evidence, note: "SKU OPAK-001" }),
    },
  });
  expect(state.audits).toContain("listing.verification_recorded");
  expect(result.status).toBe("in_review");
});
it("cached generated recovery does not repeat verification", async () => {
  const { deps, state } = makeHarness();
  const verify = vi.fn().mockResolvedValue(successfulVerification);
  deps.verifier = { verify };
  await runListingPipeline(input, deps);
  state.completed = undefined;
  await runListingPipeline(input, deps);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(state.verificationRuns).toHaveLength(1);
});
it.each(["write", "audit"])(
  "rolls back verification %s errors and allows retry",
  async (kind) => {
    const { deps, state } = makeTransactionAwareHarness();
    deps.verifier = {
      verify: vi.fn().mockResolvedValue(successfulVerification),
    };
    const original = deps.withWorkspace;
    let fail = true;
    deps.withWorkspace = (id, work) =>
      original(id, (repos) =>
        work({
          ...repos,
          aiRuns: {
            ...repos.aiRuns,
            appendVerification: async (run) => {
              await repos.aiRuns.appendVerification(run);
              if (fail && kind === "write")
                throw new Error("database write failed");
            },
          },
          audit: {
            write: async (event) => {
              await repos.audit.write(event);
              if (
                fail &&
                kind === "audit" &&
                event.action === "listing.verification_recorded"
              )
                throw new Error("audit failed");
            },
          },
        }),
      );
    await expect(runListingPipeline(input, deps)).rejects.toThrow();
    expect(state.versions).toEqual([]);
    expect(state.verificationRuns).toEqual([]);
    expect(state.audits).not.toContain("listing.verification_recorded");
    fail = false;
    expect((await runListingPipeline(input, deps)).status).toBe("in_review");
    expect(state.verificationRuns).toHaveLength(1);
  },
);

it("preserves deterministic flags and review status despite high advisory probabilities", async () => {
  const baseline = makeHarness();
  const enabled = makeHarness();
  enabled.deps.verifier = {
    verify: vi.fn().mockResolvedValue(successfulVerification),
  };
  const baselineFlags: unknown[] = [];
  const enabledFlags: unknown[] = [];
  for (const [harness, captured] of [
    [baseline, baselineFlags],
    [enabled, enabledFlags],
  ] as const) {
    const original = harness.deps.withWorkspace;
    harness.deps.withWorkspace = (id, work) =>
      original(id, (repos) =>
        work({
          ...repos,
          listings: {
            ...repos.listings,
            replaceFlags: async (version, flags) => {
              captured.push(flags);
              await repos.listings.replaceFlags(version, flags);
            },
          },
        }),
      );
  }
  expect(await runListingPipeline(input, enabled.deps)).toEqual(
    await runListingPipeline(input, baseline.deps),
  );
  expect(enabledFlags).toEqual(baselineFlags);
});
it("completion rollback permits repeating provider work while persisting one record", async () => {
  const { deps, state } = makeTransactionAwareHarness({
    completeErrorOnce: new Error("complete failed"),
  });
  const verify = vi.fn().mockResolvedValue(successfulVerification);
  deps.verifier = { verify };
  await expect(runListingPipeline(input, deps)).rejects.toThrow(
    "complete failed",
  );
  expect(state.verificationRuns).toHaveLength(0);
  await runListingPipeline(input, deps);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(state.verificationRuns).toHaveLength(1);
});
