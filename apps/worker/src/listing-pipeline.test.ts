import { describe, expect, it } from "vitest";
import { runListingPipeline } from "./listing-pipeline.js";
import {
  draftId,
  facts,
  listing,
  makeHarness,
  usage,
  workspaceId,
} from "./pipeline-test-support.js";

describe("runListingPipeline", () => {
  it("moves an evidence-backed draft into review and logs both AI steps", async () => {
    const { deps, state } = makeHarness();
    const result = await runListingPipeline(
      { workspaceId, draftId, activeVersionSequence: 0 },
      deps,
    );
    expect(result).toEqual({ status: "in_review", versionId: "version_1" });
    expect(state.audits).toContain("listing.submitted_for_review");
    expect(state.aiRuns).toHaveLength(2);
    expect(state.aiRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task: "extract",
          idempotencyKey: `listing:${workspaceId}:${draftId}:0`,
        }),
        expect.objectContaining({
          task: "generate",
          idempotencyKey: `listing:${workspaceId}:${draftId}:0`,
        }),
      ]),
    );
    expect(usage.inputTokens).toBe(12);
    expect(facts.priceHkd).toBe(288);
    expect(listing.imageAssetIds).toEqual(["asset_1"]);
  });

  it("requests protected information without generating an invalid canonical listing", async () => {
    const { deps, state } = makeHarness({ missingFields: ["priceHkd"] });
    await expect(
      runListingPipeline(
        { workspaceId, draftId, activeVersionSequence: 0 },
        deps,
      ),
    ).resolves.toEqual({ status: "needs_info", versionId: null });
    expect(state.aiRuns).toHaveLength(1);
    expect(state.audits).toContain("listing.info_requested");
  });

  it("returns the completed revision without duplicate side effects", async () => {
    const { deps, state } = makeHarness();
    const input = { workspaceId, draftId, activeVersionSequence: 0 };
    const first = await runListingPipeline(input, deps);
    const counts = {
      ai: state.aiRuns.length,
      versions: state.versions.length,
      audits: state.audits.length,
    };
    await expect(runListingPipeline(input, deps)).resolves.toEqual(first);
    expect({
      ai: state.aiRuns.length,
      versions: state.versions.length,
      audits: state.audits.length,
    }).toEqual(counts);
  });

  it("stores a product shot cutout and logs its cost when a productShot provider is configured", async () => {
    const writtenObjects: Array<{
      key: string;
      body: Uint8Array;
      mimeType: string;
    }> = [];
    const { deps, state } = makeHarness({
      productShot: {
        async generateProductShot() {
          return {
            cutoutPng: new TextEncoder().encode("cutout-bytes"),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: 0.02,
              latencyMs: 8,
              model: "fake-listing-provider",
              promptVersion: "1.0.0",
            },
          };
        },
      },
      assetStore: {
        createAssetKey({ workspaceId: ws, fileName }) {
          return `ws/${ws}/sources/00000000-0000-4000-8000-000000000099/${fileName}`;
        },
        async writeObject(_workspaceId, key, body, mimeType) {
          writtenObjects.push({ key, body, mimeType });
          return { size: body.byteLength, mimeType };
        },
      },
    });

    const result = await runListingPipeline(
      { workspaceId, draftId, activeVersionSequence: 0 },
      deps,
    );

    expect(result).toEqual({ status: "in_review", versionId: "version_1" });
    expect(state.sourceAssetsCreated).toHaveLength(1);
    expect(state.sourceAssetsCreated[0]).toMatchObject({
      kind: "image/png",
      metadata: { role: "product_shot_cutout" },
    });
    expect(writtenObjects).toHaveLength(1);
    expect(writtenObjects[0]?.mimeType).toBe("image/png");
    expect(state.aiRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: "product_shot" }),
      ]),
    );
    expect(state.sourceAssetsAttached).toEqual([
      { listingId: draftId, assetIds: ["asset_shot_1"] },
    ]);
    expect(state.audits).toContain("asset.product_shot_created");
  });

  it("skips product shot generation entirely when no productShot provider is configured (unchanged existing behavior)", async () => {
    const { deps, state } = makeHarness();
    const result = await runListingPipeline(
      { workspaceId, draftId, activeVersionSequence: 0 },
      deps,
    );
    expect(result).toEqual({ status: "in_review", versionId: "version_1" });
    expect(state.sourceAssetsCreated).toEqual([]);
    expect(state.aiRuns).toHaveLength(2);
  });
});
