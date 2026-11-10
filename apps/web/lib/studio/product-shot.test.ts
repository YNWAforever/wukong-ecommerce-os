import { describe, expect, it } from "vitest";

import {
  PRODUCT_SHOT_SOURCE_CONTENT_TYPES,
  productShotAttemptFacts,
  productShotHandoffFromContext,
  productShotLimitations,
  splitProductShotAssets,
  type ProductShotPrepareContext,
} from "./product-shot";

const context: ProductShotPrepareContext = {
  listingId: "listing-a",
  listingTitle: "Margaux 2019",
  eligibleAssetIds: ["asset-1", "asset-2"],
  derivedAssetCount: 1,
  ineligibleAssetCount: 0,
  state: "candidate_ready",
  candidateReady: true,
  ready: true,
};

describe("splitProductShotAssets", () => {
  it("keeps only source images as eligible and counts derived and unusable assets", () => {
    const split = splitProductShotAssets([
      { assetId: "png", contentType: "image/png", role: "source" },
      { assetId: "jpeg", contentType: "image/jpeg", role: "source" },
      { assetId: "webp", contentType: "image/webp", role: "source" },
      { assetId: "cutout", contentType: "image/png", role: "derived" },
      { assetId: "pdf", contentType: "application/pdf", role: "source" },
      { assetId: "text", contentType: "text/plain", role: "source" },
    ]);
    expect(split).toEqual({
      eligibleAssetIds: ["png", "jpeg", "webp"],
      derivedAssetCount: 1,
      ineligibleAssetCount: 2,
    });
    expect(PRODUCT_SHOT_SOURCE_CONTENT_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
  });

  it("bounds the handoff to the reviewed eight source assets", () => {
    const split = splitProductShotAssets(
      Array.from({ length: 12 }, (_, index) => ({
        assetId: `asset-${index}`,
        contentType: "image/png",
        role: "source" as const,
      })),
    );
    expect(split.eligibleAssetIds).toHaveLength(8);
    expect(split.derivedAssetCount).toBe(0);
    expect(split.ineligibleAssetCount).toBe(0);
  });
});

describe("productShotAttemptFacts", () => {
  it("keeps a missing attempt unknown instead of inventing a state", () => {
    expect(productShotAttemptFacts(null)).toEqual({
      state: null,
      candidateReady: false,
    });
    expect(
      productShotAttemptFacts({
        state: "queued",
        sourceAssetId: "a",
        candidateReady: false,
      }),
    ).toEqual({ state: "queued", candidateReady: false });
  });
});

describe("productShotHandoffFromContext", () => {
  it("records the prepared handoff without minting anything", () => {
    expect(productShotHandoffFromContext(context)).toEqual({
      kind: "product_shot_handoff",
      listingId: "listing-a",
      assetIds: ["asset-1", "asset-2"],
      state: "candidate_ready",
      ready: true,
    });
    // The handoff is a copy: later pack mutation cannot change a persisted turn.
    const handoff = productShotHandoffFromContext(context);
    context.eligibleAssetIds.push("asset-3");
    expect(handoff.assetIds).toEqual(["asset-1", "asset-2"]);
  });
});

describe("productShotLimitations", () => {
  it("always says the handoff happens in the existing screen", () => {
    expect(
      productShotLimitations({
        listingAvailable: true,
        assetsReadable: true,
        stateKnown: true,
        eligibleAssets: 2,
      }).map((line) => line.key),
    ).toEqual(["studio.limit.product_shot_handoff"]);
  });

  it("names each honest reason without substituting a zero", () => {
    expect(
      productShotLimitations({
        listingAvailable: false,
        assetsReadable: false,
        stateKnown: false,
        eligibleAssets: 0,
      }).map((line) => line.key),
    ).toEqual([
      "studio.limit.product_shot_handoff",
      "studio.limit.product_shot_listing_unavailable",
      "studio.limit.product_shot_state_unknown",
    ]);
    expect(
      productShotLimitations({
        listingAvailable: true,
        assetsReadable: false,
        stateKnown: true,
        eligibleAssets: 0,
      }).map((line) => line.key),
    ).toContain("studio.limit.product_shot_assets_unavailable");
    expect(
      productShotLimitations({
        listingAvailable: true,
        assetsReadable: true,
        stateKnown: true,
        eligibleAssets: 0,
      }).map((line) => line.key),
    ).toContain("studio.limit.product_shot_no_source");
  });
});
