import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { listingFactsSchema, type ListingFacts } from "@wukong/core";

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
  upsertMany(
    inputs: readonly UpsertPlatformProductInput[],
  ): Promise<PlatformProduct[]>;
  listByRemoteProductIds(
    connectionId: string,
    remoteProductIds: readonly string[],
  ): Promise<PlatformProduct[]>;
  listRecent(limit?: number): Promise<PlatformProduct[]>;
  /**
   * Detaches mirror rows from a draft so the draft can be deleted.
   *
   * The listing foreign key is `ON DELETE RESTRICT` precisely so a draft delete
   * cannot silently destroy the catalog mirror and its digest. That makes the
   * unlink a deliberate, separate step — this is it. Returns how many rows were
   * detached. Deleting a whole workspace needs none of this: the mirror's own
   * cascade to `workspaces` removes these rows first.
   */
  unlinkListing(listingId: string): Promise<number>;
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

type PlatformProductRow = Omit<PlatformProduct, "factsPrefill"> & {
  factsPrefill: unknown;
};

/**
 * `jsonb().$type<ListingFacts>()` is a compile-time cast with no runtime check,
 * so a malformed prefill would flow straight through the boundary. Parse it at
 * the seam, the way the workspace repository parses its profile jsonb.
 */
const toPlatformProduct = (row: PlatformProductRow): PlatformProduct => ({
  ...row,
  factsPrefill: listingFactsSchema.parse(row.factsPrefill),
});

const validatedValues = (
  input: UpsertPlatformProductInput,
  workspaceId: string,
) => ({
  ...input,
  factsPrefill: listingFactsSchema.parse(input.factsPrefill),
  workspaceId,
});

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
        .values(validatedValues(input, workspaceId))
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
      return toPlatformProduct(row);
    },

    async upsertMany(inputs) {
      scope.assertOpen();
      if (inputs.length === 0) return [];
      // One statement for the whole batch: a catalog import would otherwise
      // issue a round trip per product and hold the transaction open for it.
      const rows = await transaction
        .insert(platformProducts)
        .values(inputs.map((input) => validatedValues(input, workspaceId)))
        .onConflictDoUpdate({
          target: [
            platformProducts.workspaceId,
            platformProducts.connectionId,
            platformProducts.remoteProductId,
          ],
          set: {
            sku: sql`excluded.sku`,
            listingId: sql`excluded.listing_id`,
            specVersion: sql`excluded.spec_version`,
            rawRow: sql`excluded.raw_row`,
            factsPrefill: sql`excluded.facts_prefill`,
            contentDigest: sql`excluded.content_digest`,
            updatedAt: new Date(),
          },
        })
        .returning(COLUMNS);
      return rows.map(toPlatformProduct);
    },

    async unlinkListing(listingId) {
      scope.assertOpen();
      const rows = await transaction
        .update(platformProducts)
        .set({ listingId: null, updatedAt: new Date() })
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            eq(platformProducts.listingId, listingId),
          ),
        )
        .returning({ id: platformProducts.id });
      return rows.length;
    },

    async listByRemoteProductIds(connectionId, remoteProductIds) {
      scope.assertOpen();
      if (remoteProductIds.length === 0) return [];
      const rows = await transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            eq(platformProducts.connectionId, connectionId),
            inArray(platformProducts.remoteProductId, [...remoteProductIds]),
          ),
        );
      return rows.map(toPlatformProduct);
    },

    async listRecent(limit = 100) {
      scope.assertOpen();
      // 5000 matches the import cap: a cohort is selected by scanning the
      // mirror, so anything importable in one request must be scannable in one
      // read. A lower cap here silently made every catalog-wide batch fail.
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
        throw new Error("platform product limit must be between 1 and 5000");
      }
      const rows = await transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(eq(platformProducts.workspaceId, workspaceId))
        .orderBy(desc(platformProducts.updatedAt))
        .limit(limit);
      return rows.map(toPlatformProduct);
    },
  };
}
