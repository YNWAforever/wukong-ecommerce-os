import { createPublishedImageHandler } from "../../../lib/product-image-publication";
import { getDatabase, getAssetStore } from "../../../lib/intake-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createPublishedImageHandler({
  lookupPublishedImage: (token) => getDatabase().lookupPublishedImage(token),
  readObject: (workspaceId, key) =>
    getAssetStore().readObject(workspaceId, key),
});
export const HEAD = GET;
