import { describe, expect, it } from "vitest";
import { runListingPipeline } from "./listing-pipeline.js";
import { draftId, facts, listing, makeHarness, usage, workspaceId } from "./pipeline-test-support.js";

describe("runListingPipeline", () => {
  it("moves an evidence-backed draft into review and logs both AI steps", async () => {
    const { deps, state } = makeHarness();
    const result = await runListingPipeline({ workspaceId, draftId, activeVersionSequence: 0 }, deps);
    expect(result).toEqual({ status: "in_review", versionId: "version_1" });
    expect(state.audits).toContain("listing.submitted_for_review");
    expect(state.aiRuns).toHaveLength(2);
    expect(state.aiRuns).toEqual(expect.arrayContaining([expect.objectContaining({ task: "extract", idempotencyKey: `listing:${workspaceId}:${draftId}:0` }), expect.objectContaining({ task: "generate", idempotencyKey: `listing:${workspaceId}:${draftId}:0` })]));
    expect(usage.inputTokens).toBe(12);
    expect(facts.priceHkd).toBe(288);
    expect(listing.imageAssetIds).toEqual(["asset_1"]);
  });

  it("requests protected information without generating an invalid canonical listing", async () => {
    const { deps, state } = makeHarness({ missingFields: ["priceHkd"] });
    await expect(runListingPipeline({ workspaceId, draftId, activeVersionSequence: 0 }, deps)).resolves.toEqual({ status: "needs_info", versionId: null });
    expect(state.aiRuns).toHaveLength(1);
    expect(state.audits).toContain("listing.info_requested");
  });

  it("returns the completed revision without duplicate side effects", async () => {
    const { deps, state } = makeHarness();
    const input = { workspaceId, draftId, activeVersionSequence: 0 };
    const first = await runListingPipeline(input, deps);
    const counts = { ai: state.aiRuns.length, versions: state.versions.length, audits: state.audits.length };
    await expect(runListingPipeline(input, deps)).resolves.toEqual(first);
    expect({ ai: state.aiRuns.length, versions: state.versions.length, audits: state.audits.length }).toEqual(counts);
  });
});