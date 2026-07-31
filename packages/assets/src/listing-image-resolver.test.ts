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
