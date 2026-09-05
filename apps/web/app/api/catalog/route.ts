import { resultCapabilities } from "../../../lib/export-reconciliation";
import { z } from "zod";

import type { Database } from "@wukong/db";
import type { ListingStatus } from "@wukong/core";

import {
  type CatalogItem,
  filterCatalogItemsServer,
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

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().optional(),
  filter: z
    .enum(["all", "attention", "review", "unlinked", "published"])
    .default("all"),
});

type CatalogRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createCatalogHandler(deps: CatalogRouteDeps) {
  return async function catalog(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const url = new URL(request.url);
      const query = querySchema.parse(Object.fromEntries(url.searchParams));

      const allItems = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const products = await repositories.platformProducts.listRecent(5000);
          const listingIds = [
            ...new Set(
              products
                .map((product) => product.listingId)
                .filter((id): id is string => id !== null),
            ),
          ];
          const statuses =
            await repositories.listings.statusesByIds(listingIds);
          const linkedListings =
            await repositories.listings.getByIds(listingIds);
          const linkedListingById = new Map(
            linkedListings.map((listing) => [listing.id, listing]),
          );

          return products.map((product): CatalogItem => {
            const linkedListing = product.listingId
              ? linkedListingById.get(product.listingId)
              : undefined;
            const listingStatus = product.listingId
              ? (statuses[product.listingId] ?? null)
              : null;
            const openBlockingFlagCount =
              linkedListing?.openBlockingFlagCount ?? null;
            const title =
              linkedListing?.activeVersion?.content.title["zh-Hant"] ??
              linkedListing?.activeVersion?.content.title.en ??
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
              createdAt: product.createdAt.toISOString(),
              updatedAt: product.updatedAt.toISOString(),
              contentDigest: product.contentDigest,
            };
          });
        });

      const filtered = filterCatalogItemsServer(
        allItems,
        query.q,
        query.filter,
      );
      const start = (query.page - 1) * query.pageSize;
      const pageItems = filtered.slice(start, start + query.pageSize);

      return jsonResponse(200, {
        capabilities: resultCapabilities(context.role),
        items: pageItems,
        summary: summarizeCatalog(allItems),
        page: query.page,
        pageSize: query.pageSize,
        totalMatching: filtered.length,
      });
    });
  };
}

export const GET = createCatalogHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
