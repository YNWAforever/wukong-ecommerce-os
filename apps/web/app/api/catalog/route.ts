import type { Database } from "@wukong/db";
import type { ListingStatus } from "@wukong/core";

import {
  type CatalogItem,
  summarizeCatalog,
} from "../../../lib/catalog-contract";
import { getDatabase } from "../../../lib/intake-runtime";
import {
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

const ATTENTION_STATUSES = new Set<ListingStatus>([
  "needs_info",
  "publish_failed",
  "failed",
]);

const REVIEW_STATUSES = new Set<ListingStatus>(["in_review", "reopened"]);

type CatalogRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createCatalogHandler(deps: CatalogRouteDeps) {
  return async function catalog(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const items = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const products = await repositories.platformProducts.listRecent(100);
          const listingIds = [
            ...new Set(
              products
                .map((product) => product.listingId)
                .filter((id): id is string => id !== null),
            ),
          ];
          const statuses =
            await repositories.listings.statusesByIds(listingIds);
          const recentListings = await repositories.listings.listRecent(100);
          const recentListingById = new Map(
            recentListings.map((listing) => [listing.id, listing]),
          );

          return products.map((product): CatalogItem => {
            const recentListing = product.listingId
              ? recentListingById.get(product.listingId)
              : undefined;
            const listingStatus = product.listingId
              ? (statuses[product.listingId] ?? null)
              : null;
            const openBlockingFlagCount =
              recentListing?.openBlockingFlagCount ?? null;
            const title =
              recentListing?.activeVersion?.content.title["zh-Hant"] ??
              recentListing?.activeVersion?.content.title.en ??
              product.sku ??
              product.remoteProductId;
            const needsReview =
              listingStatus !== null && REVIEW_STATUSES.has(listingStatus);
            const needsAttention =
              product.listingId === null ||
              listingStatus === null ||
              ATTENTION_STATUSES.has(listingStatus) ||
              (openBlockingFlagCount ?? 0) > 0;

            return {
              id: product.id,
              remoteProductId: product.remoteProductId,
              origin: product.origin,
              sku: product.sku,
              listingId: product.listingId,
              specVersion: product.specVersion,
              title,
              listingStatus,
              openBlockingFlagCount,
              needsReview,
              needsAttention,
            };
          });
        });

      return jsonResponse(200, { items, summary: summarizeCatalog(items) });
    });
  };
}

export const GET = createCatalogHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
