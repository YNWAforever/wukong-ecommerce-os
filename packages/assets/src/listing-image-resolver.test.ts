import { describe, expect, it } from "vitest";

import { ASSET_EXPORT_READ_TTL_MS } from "./asset-store.js";
import { resolveListingImageUrls } from "./listing-image-resolver.js";

const workspaceId = "ws_opak";
const draftId = "draft_1";
const asset = {
  id: "asset_a",
  workspaceId,
  listingId: draftId,
  kind: "image/webp",
  storageKey: "ws/ws_opak/sources/asset-a/a.webp",
};

function harness() {
  const seen: Array<{ expiresInMs?: number } | undefined> = [];
  return {
    seen,
    input: {
      workspaceId,
      draftId,
      imageAssetIds: [asset.id],
      sourceAssets: {
        async getByIds() {
          return [asset];
        },
      },
      assetStore: {
        async createReadUrl(
          _workspaceId: string,
          _key: string,
          options?: { expiresInMs?: number },
        ) {
          seen.push(options);
          return {
            url: "https://signed.example/a.webp",
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          };
        },
      },
    },
  };
}

describe("resolveListingImageUrls", () => {
  it("passes the requested lifetime to the asset store", async () => {
    const { seen, input } = harness();

    await resolveListingImageUrls({
      ...input,
      readTtlMs: ASSET_EXPORT_READ_TTL_MS,
    });

    expect(seen).toEqual([{ expiresInMs: ASSET_EXPORT_READ_TTL_MS }]);
  });

  it("leaves the lifetime to the store when the caller asks for none", async () => {
    const { seen, input } = harness();

    await resolveListingImageUrls(input);

    expect(seen).toEqual([{ expiresInMs: undefined }]);
  });
});

it("uses only approved publication URLs and never signs a source in the new workflow", async () => {
  const { input, seen } = harness();
  const calls: unknown[] = [];
  expect(
    await resolveListingImageUrls({
      ...input,
      publication: {
        versionId: "v1",
        resolveApprovedProductImage: async (value) => {
          calls.push(value);
          return "https://images.example/image.jpg";
        },
      },
    }),
  ).toEqual(["https://images.example/image.jpg"]);
  expect(calls).toEqual([
    { workspaceId, listingId: draftId, versionId: "v1", assetId: asset.id },
  ]);
  expect(seen).toEqual([]);
});
it("blocks empty images and unavailable publications without raw fallback", async () => {
  const { input, seen } = harness();
  const publication = {
    versionId: "v1",
    resolveApprovedProductImage: async () => {
      throw new Error("Approve the product image before exporting");
    },
  };
  await expect(
    resolveListingImageUrls({ ...input, publication }),
  ).rejects.toThrow("Approve");
  await expect(
    resolveListingImageUrls({ ...input, imageAssetIds: [], publication }),
  ).rejects.toThrow();
  expect(seen).toEqual([]);
});
