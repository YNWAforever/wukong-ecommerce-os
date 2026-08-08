import type { AssetStore } from "./asset-store.js";

type ListingImageAsset = {
  id: string;
  workspaceId: string;
  listingId: string | null;
  kind: string;
  storageKey: string;
};

export type ResolveListingImageUrlsInput = {
  workspaceId: string;
  draftId: string;
  imageAssetIds: readonly string[];
  sourceAssets: {
    getByIds(ids: string[]): Promise<ListingImageAsset[]>;
  };
  assetStore: Pick<AssetStore, "createReadUrl">;
  /** Omitted for in-app reads; set only for URLs leaving the app in a file. */
  readTtlMs?: number;
};

export class ImageResolutionError extends Error {
  constructor() {
    super("Listing images are unavailable for delivery");
    this.name = "ImageResolutionError";
  }
}

export async function resolveListingImageUrls({
  workspaceId,
  draftId,
  imageAssetIds,
  sourceAssets,
  assetStore,
  readTtlMs,
}: ResolveListingImageUrlsInput): Promise<string[]> {
  const requestedIds = [...imageAssetIds];
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new ImageResolutionError();
  }
  if (requestedIds.length === 0) return [];

  const assets = await sourceAssets.getByIds(requestedIds);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const orderedAssets = requestedIds.map((id) => {
    const asset = byId.get(id);
    if (
      !asset ||
      asset.workspaceId !== workspaceId ||
      asset.listingId !== draftId ||
      !asset.kind.startsWith("image/")
    ) {
      throw new ImageResolutionError();
    }
    return asset;
  });

  return Promise.all(
    orderedAssets.map(
      async (asset) =>
        (
          await assetStore.createReadUrl(workspaceId, asset.storageKey, {
            expiresInMs: readTtlMs,
          })
        ).url,
    ),
  );
}
