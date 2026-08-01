import { describe, expect, it, vi } from "vitest";

import {
  ImageResolutionError,
  resolveListingImageUrls,
} from "./image-resolver.js";

const workspaceId = "ws_opak";
const draftId = "draft_1";
const assetA = {
  id: "asset_a",
  workspaceId,
  listingId: draftId,
  kind: "image/png",
  storageKey: "ws/ws_opak/sources/asset-a/a.png",
};
const assetB = {
  id: "asset_b",
  workspaceId,
  listingId: draftId,
  kind: "image/webp",
  storageKey: "ws/ws_opak/sources/asset-b/b.webp",
};

function harness(
  assets: Array<typeof assetA | (typeof assetA & { listingId: null })>,
) {
  const getByIds = vi.fn(async () => assets);
  const createReadUrl = vi.fn(
    async (_workspaceId: string, storageKey: string) => ({
      url: `https://signed.example/${encodeURIComponent(storageKey)}`,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }),
  );
  return {
    sourceAssets: { getByIds },
    assetStore: { createReadUrl },
    getByIds,
    createReadUrl,
  };
}

describe("resolveListingImageUrls", () => {
  it("preserves requested order and signs only database-derived storage keys", async () => {
    const deps = harness([assetA, assetB]);

    const urls = await resolveListingImageUrls({
      workspaceId,
      draftId,
      imageAssetIds: [assetB.id, assetA.id],
      sourceAssets: deps.sourceAssets,
      assetStore: deps.assetStore,
    });

    expect(deps.getByIds).toHaveBeenCalledWith([assetB.id, assetA.id]);
    expect(deps.createReadUrl.mock.calls).toEqual([
      [workspaceId, assetB.storageKey, { expiresInMs: undefined }],
      [workspaceId, assetA.storageKey, { expiresInMs: undefined }],
    ]);
    expect(urls).toEqual([
      `https://signed.example/${encodeURIComponent(assetB.storageKey)}`,
      `https://signed.example/${encodeURIComponent(assetA.storageKey)}`,
    ]);
  });

  it("rejects duplicate IDs before repository access", async () => {
    const deps = harness([assetA]);

    await expect(
      resolveListingImageUrls({
        workspaceId,
        draftId,
        imageAssetIds: [assetA.id, assetA.id],
        sourceAssets: deps.sourceAssets,
        assetStore: deps.assetStore,
      }),
    ).rejects.toBeInstanceOf(ImageResolutionError);

    expect(deps.getByIds).not.toHaveBeenCalled();
    expect(deps.createReadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", [assetA], [assetA.id, "asset_missing"]],
    [
      "foreign workspace",
      [{ ...assetA, workspaceId: "ws_other" }],
      [assetA.id],
    ],
    ["unattached", [{ ...assetA, listingId: null }], [assetA.id]],
    ["another draft", [{ ...assetA, listingId: "draft_other" }], [assetA.id]],
    ["non-image", [{ ...assetA, kind: "application/pdf" }], [assetA.id]],
  ])(
    "rejects %s assets before signing",
    async (_case, assets, imageAssetIds) => {
      const deps = harness(assets as Parameters<typeof harness>[0]);

      await expect(
        resolveListingImageUrls({
          workspaceId,
          draftId,
          imageAssetIds,
          sourceAssets: deps.sourceAssets,
          assetStore: deps.assetStore,
        }),
      ).rejects.toBeInstanceOf(ImageResolutionError);

      expect(deps.createReadUrl).not.toHaveBeenCalled();
    },
  );
});
