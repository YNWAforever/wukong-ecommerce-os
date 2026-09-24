import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { listingFactsSchema, type ListingFacts } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { platformProducts } from "../schema.js";

export type PlatformProductOrigin = "import" | "created";

/**
 * `origin` is a plain `text()` column with only an app-level CHECK
 * constraint, not a Postgres enum, so Drizzle infers bare `string` for it —
 * unlike `listing_drafts.status`, which is a real `pgEnum` and gets a narrow
 * literal-union type for free. Parse it at the same seam `factsPrefill` is
 * parsed at, rather than casting a wide type away unchecked.
 */
const platformProductOriginSchema = z.enum(["import", "created"]);

export type PlatformProduct = {
  id: string;
  connectionId: string;
  remoteProductId: string;
  origin: PlatformProductOrigin;
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  rawRow: Record<string, string | null> | null;
  factsPrefill: ListingFacts | null;
  contentDigest: string | null;
  sourceImportId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertPlatformProductInput = {
  connectionId: string;
  remoteProductId: string;
  origin: PlatformProductOrigin;
  sku: string | null;
  /**
   * The caller supplies the draft this product is linked to, including when it
   * is re-supplying an existing one. An upsert that passed null here would
   * unlink a product that already has a draft.
   */
  listingId: string | null;
  specVersion: string | null;
  rawRow: Record<string, string | null> | null;
  factsPrefill: ListingFacts | null;
  /**
   * MUST be `hashBulkFormRow(rawRow)` for an "import"-origin row — a digest
   * that disagrees with its row reads as "unchanged" on the next import,
   * which is a silent false negative in the only mechanism that detects a
   * real catalog change. Null for a "created"-origin row, which has no
   * imported row to hash. The repository cannot derive it here without
   * coupling `@wukong/db` to a specific connector's row type, so the caller
   * owns the invariant.
   */
  contentDigest: string | null;
  sourceImportId: string | null;
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
  getByIds(ids: readonly string[]): Promise<PlatformProduct[]>;
  listRecent(limit?: number): Promise<PlatformProduct[]>;
  /**
   * The link the exporter reads: does this listing have a known remote
   * product at all. `listingId` has no unique constraint on the table, so a
   * listing could in principle link to more than one row; this returns the
   * most recently updated one, matching `listRecent`'s own ordering.
   */
  getByListingId(listingId: string): Promise<PlatformProduct | null>;
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
  origin: platformProducts.origin,
  sku: platformProducts.sku,
  listingId: platformProducts.listingId,
  specVersion: platformProducts.specVersion,
  rawRow: platformProducts.rawRow,
  factsPrefill: platformProducts.factsPrefill,
  contentDigest: platformProducts.contentDigest,
  sourceImportId: platformProducts.sourceImportId,
  createdAt: platformProducts.createdAt,
  updatedAt: platformProducts.updatedAt,
};

type PlatformProductRow = Omit<PlatformProduct, "factsPrefill" | "origin"> & {
  factsPrefill: unknown;
  // `origin` is a plain `text()` column with no `$type` cast, so Drizzle
  // infers `string` for it, not the narrower union.
  origin: string;
};

/**
 * `jsonb().$type<ListingFacts>()` is a compile-time cast with no runtime check,
 * so a malformed prefill would flow straight through the boundary. Parse it at
 * the seam, the way the workspace repository parses its profile jsonb.
 */
const toPlatformProduct = (row: PlatformProductRow): PlatformProduct => ({
  ...row,
  origin: platformProductOriginSchema.parse(row.origin),
  factsPrefill:
    row.factsPrefill === null
      ? null
      : listingFactsSchema.parse(row.factsPrefill),
});

const validatedValues = (
  input: UpsertPlatformProductInput,
  workspaceId: string,
) => ({
  ...input,
  factsPrefill:
    input.factsPrefill === null
      ? null
      : listingFactsSchema.parse(input.factsPrefill),
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
            origin: input.origin,
            sku: input.sku,
            listingId: input.listingId,
            specVersion: input.specVersion,
            rawRow: input.rawRow,
            factsPrefill: input.factsPrefill,
            contentDigest: input.contentDigest,
            sourceImportId: input.sourceImportId,
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
            origin: sql`excluded.origin`,
            sku: sql`excluded.sku`,
            listingId: sql`excluded.listing_id`,
            specVersion: sql`excluded.spec_version`,
            rawRow: sql`excluded.raw_row`,
            factsPrefill: sql`excluded.facts_prefill`,
            contentDigest: sql`excluded.content_digest`,
            sourceImportId: sql`excluded.source_import_id`,
            updatedAt: new Date(),
          },
        })
        .returning(COLUMNS);
      return rows.map(toPlatformProduct);
    },

    async getByListingId(listingId) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            eq(platformProducts.listingId, listingId),
          ),
        )
        .orderBy(desc(platformProducts.updatedAt))
        .limit(1);
      return row ? toPlatformProduct(row) : null;
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

    async getByIds(ids) {
      scope.assertOpen();
      if (!ids.length) return [];
      if (ids.length > 100) throw new Error("read hydration exceeds page size");
      const rows = await transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            inArray(platformProducts.id, [...ids]),
          ),
        )
        .orderBy(desc(platformProducts.updatedAt))
        .limit(100);
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
