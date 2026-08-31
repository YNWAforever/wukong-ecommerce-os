import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { enrichmentBatchItems, enrichmentBatches } from "../schema.js";

export type EnrichmentBatchStatus =
  "open" | "running" | "completed" | "budget_exhausted" | "cancelled";

export type EnrichmentBatchItemStatus =
  "pending" | "queued" | "succeeded" | "failed" | "skipped";

export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  createdBy: string;
  createdAt: Date;
};

export type CreateEnrichmentBatchInput = {
  label: string;
  budgetUsd: number;
  waveSize: number;
  createdBy: string;
  listingIds: readonly string[];
};

export type EnrichmentBatchCounts = Record<EnrichmentBatchItemStatus, number>;

export type EnrichmentBatchRepository = {
  create(input: CreateEnrichmentBatchInput): Promise<EnrichmentBatch>;
  getById(id: string): Promise<EnrichmentBatch | null>;
  listForWorkspace(): Promise<EnrichmentBatch[]>;
  listItemIds(batchId: string): Promise<string[]>;
  listItemsByStatus(
    batchId: string,
    status: EnrichmentBatchItemStatus,
  ): Promise<string[]>;
  countByStatus(batchId: string): Promise<EnrichmentBatchCounts>;
  /** Moves up to `limit` pending items to `queued` and returns their draft IDs. */
  claimWave(batchId: string, limit: number): Promise<string[]>;
  markItems(
    batchId: string,
    listingIds: readonly string[],
    status: EnrichmentBatchItemStatus,
  ): Promise<void>;
  setStatus(batchId: string, status: EnrichmentBatchStatus): Promise<void>;
};

const COLUMNS = {
  id: enrichmentBatches.id,
  label: enrichmentBatches.label,
  budgetUsd: enrichmentBatches.budgetUsd,
  waveSize: enrichmentBatches.waveSize,
  status: enrichmentBatches.status,
  createdBy: enrichmentBatches.createdBy,
  createdAt: enrichmentBatches.createdAt,
};

type EnrichmentBatchRow = Omit<EnrichmentBatch, "budgetUsd"> & {
  budgetUsd: string;
};

const ITEM_STATUSES: readonly EnrichmentBatchItemStatus[] = [
  "pending",
  "queued",
  "succeeded",
  "failed",
  "skipped",
];

/**
 * `budget_usd` is a numeric column, so the driver hands it back as a string.
 * Converting here is what keeps the string from escaping into the typed batch,
 * where `budgetUsd - spend` would silently concatenate instead of subtract.
 */
const toEnrichmentBatch = (row: EnrichmentBatchRow): EnrichmentBatch => ({
  ...row,
  budgetUsd: Number(row.budgetUsd),
});

export function createEnrichmentBatchRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): EnrichmentBatchRepository {
  const itemsOfBatch = (batchId: string) =>
    and(
      eq(enrichmentBatchItems.workspaceId, workspaceId),
      eq(enrichmentBatchItems.batchId, batchId),
    );

  return {
    async create(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(enrichmentBatches)
        .values({
          label: input.label,
          budgetUsd: input.budgetUsd.toFixed(6),
          waveSize: input.waveSize,
          createdBy: input.createdBy,
          // Last, so the scoped ID wins over anything a caller supplied.
          workspaceId,
        })
        .returning(COLUMNS);
      if (!row) throw new Error("enrichment batch insert did not return a row");
      if (input.listingIds.length > 0) {
        // One statement for the whole batch: a 500-draft batch would otherwise
        // hold the transaction open for 500 round trips.
        await transaction.insert(enrichmentBatchItems).values(
          input.listingIds.map((listingId) => ({
            workspaceId,
            batchId: row.id,
            listingId,
          })),
        );
      }
      return toEnrichmentBatch(row);
    },

    async getById(id) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(enrichmentBatches)
        .where(
          and(
            eq(enrichmentBatches.workspaceId, workspaceId),
            eq(enrichmentBatches.id, id),
          ),
        )
        .limit(1);
      return row ? toEnrichmentBatch(row) : null;
    },

    async listForWorkspace() {
      scope.assertOpen();
      const rows = await transaction
        .select(COLUMNS)
        .from(enrichmentBatches)
        .where(eq(enrichmentBatches.workspaceId, workspaceId))
        .orderBy(desc(enrichmentBatches.createdAt));
      return rows.map(toEnrichmentBatch);
    },

    async listItemIds(batchId) {
      scope.assertOpen();
      const rows = await transaction
        .select({ listingId: enrichmentBatchItems.listingId })
        .from(enrichmentBatchItems)
        .where(itemsOfBatch(batchId))
        .orderBy(asc(enrichmentBatchItems.createdAt));
      return rows.map((row) => row.listingId);
    },

    async listItemsByStatus(batchId, status) {
      scope.assertOpen();
      const rows = await transaction
        .select({ listingId: enrichmentBatchItems.listingId })
        .from(enrichmentBatchItems)
        .where(
          and(itemsOfBatch(batchId), eq(enrichmentBatchItems.status, status)),
        )
        .orderBy(asc(enrichmentBatchItems.createdAt));
      return rows.map((row) => row.listingId);
    },

    async countByStatus(batchId) {
      scope.assertOpen();
      const rows = await transaction
        .select({
          status: enrichmentBatchItems.status,
          total: sql<number>`count(*)::int`,
        })
        .from(enrichmentBatchItems)
        .where(itemsOfBatch(batchId))
        .groupBy(enrichmentBatchItems.status);
      // Complete by construction: a caller comparing "succeeded + failed" to
      // the batch size must not have to distinguish zero from absent.
      const counts = Object.fromEntries(
        ITEM_STATUSES.map((status) => [status, 0]),
      ) as EnrichmentBatchCounts;
      for (const row of rows) counts[row.status] = Number(row.total);
      return counts;
    },

    async claimWave(batchId, limit) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("enrichment wave limit must be between 1 and 1000");
      }
      // Claim and read in one statement, so two concurrent advances cannot
      // hand the same draft to two waves. The CTE picks the wave and locks it
      // (`skip locked`: a concurrent advance takes the next rows instead of
      // blocking), and the update joins against that one evaluation.
      //
      // Deliberately raw rather than `inArray(id, subquery)`: Postgres plans an
      // `IN (select ... limit n for update)` as a per-row subplan, re-runs it
      // for each candidate, and skips the rows this very statement already
      // locked — which returned more than `limit` drafts in a wave.
      const rows = await transaction.execute<{ listing_id: string }>(sql`
        with claimed as (
          select ${enrichmentBatchItems.id} as id
          from ${enrichmentBatchItems}
          where ${and(
            itemsOfBatch(batchId),
            eq(enrichmentBatchItems.status, "pending"),
          )}
          order by ${enrichmentBatchItems.createdAt} asc, ${enrichmentBatchItems.id} asc
          limit ${limit}
          for update skip locked
        )
        update ${enrichmentBatchItems}
        set status = 'queued', updated_at = now()
        from claimed
        where ${enrichmentBatchItems.id} = claimed.id
          and ${and(
            itemsOfBatch(batchId),
            eq(enrichmentBatchItems.status, "pending"),
          )}
        returning ${enrichmentBatchItems.listingId} as listing_id
      `);
      return [...rows].map((row) => row.listing_id);
    },

    async markItems(batchId, listingIds, status) {
      scope.assertOpen();
      if (listingIds.length === 0) return;
      await transaction
        .update(enrichmentBatchItems)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            itemsOfBatch(batchId),
            inArray(enrichmentBatchItems.listingId, [...listingIds]),
          ),
        );
    },

    async setStatus(batchId, status) {
      scope.assertOpen();
      const updated = await transaction
        .update(enrichmentBatches)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(enrichmentBatches.workspaceId, workspaceId),
            eq(enrichmentBatches.id, batchId),
          ),
        )
        .returning({ id: enrichmentBatches.id });
      // A silent no-op would let an operator believe a batch was cancelled
      // while its next wave is still claimable.
      if (updated.length !== 1) {
        throw new Error("enrichment batch status update matched no row");
      }
    },
  };
}
