import { and, desc, eq, inArray } from "drizzle-orm";

import type { ListingFacts } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { platformProducts } from "../schema.js";

export type PlatformProduct = {
  id: string;
  connectionId: string;
  remoteProductId: string;
  sku: string;
  listingId: string | null;
  specVersion: string;
  rawRow: Record<string, string | null>;
  factsPrefill: ListingFacts;
  contentDigest: string;
};

export type UpsertPlatformProductInput = {
  connectionId: string;
  remoteProductId: string;
  sku: string;
  /**
   * The caller supplies the draft this product is linked to, including when it
   * is re-supplying an existing one. An upsert that passed null here would
   * unlink a product that already has a draft.
   */
  listingId: string | null;
  specVersion: string;
  rawRow: Record<string, string | null>;
  factsPrefill: ListingFacts;
  /**
   * MUST be `hashBulkFormRow(rawRow)`. A digest that disagrees with its row
   * reads as "unchanged" on the next import, which is a silent false negative
   * in the only mechanism that detects a real catalog change. The repository
   * cannot derive it here without coupling `@wukong/db` to a specific
   * connector's row type, so the importer owns the invariant.
   */
  contentDigest: string;
};

export type PlatformProductRepository = {
  upsert(input: UpsertPlatformProductInput): Promise<PlatformProduct>;
  listByRemoteProductIds(
    connectionId: string,
    remoteProductIds: readonly string[],
  ): Promise<PlatformProduct[]>;
  listRecent(limit?: number): Promise<PlatformProduct[]>;
};

const COLUMNS = {
  id: platformProducts.id,
  connectionId: platformProducts.connectionId,
  remoteProductId: platformProducts.remoteProductId,
  sku: platformProducts.sku,
  listingId: platformProducts.listingId,
  specVersion: platformProducts.specVersion,
  rawRow: platformProducts.rawRow,
  factsPrefill: platformProducts.factsPrefill,
  contentDigest: platformProducts.contentDigest,
};

export function createPlatformProductRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): PlatformProductRepository {
  return {
    async upsert(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(platformProducts)
        // workspaceId last: the scoped ID must win even if a caller's object
        // carries one of its own. RLS would reject the write anyway, but the
        // tenancy boundary should not depend on the database catching it.
        .values({ ...input, workspaceId })
        .onConflictDoUpdate({
          target: [
            platformProducts.workspaceId,
            platformProducts.connectionId,
            platformProducts.remoteProductId,
          ],
          set: {
            sku: input.sku,
            listingId: input.listingId,
            specVersion: input.specVersion,
            rawRow: input.rawRow,
            factsPrefill: input.factsPrefill,
            contentDigest: input.contentDigest,
            updatedAt: new Date(),
          },
        })
        .returning(COLUMNS);
      if (!row) throw new Error("platform product upsert did not return a row");
      return row;
    },

    async listByRemoteProductIds(connectionId, remoteProductIds) {
      scope.assertOpen();
      if (remoteProductIds.length === 0) return [];
      return transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            eq(platformProducts.connectionId, connectionId),
            inArray(platformProducts.remoteProductId, [...remoteProductIds]),
          ),
        );
    },

    async listRecent(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("platform product limit must be between 1 and 1000");
      }
      return transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(eq(platformProducts.workspaceId, workspaceId))
        .orderBy(desc(platformProducts.updatedAt))
        .limit(limit);
    },
  };
}
