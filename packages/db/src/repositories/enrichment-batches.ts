import { createBatchControlRepository } from "./enrichment-batch-controls.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { enrichmentBatchItems, enrichmentBatches } from "../schema.js";

export type EnrichmentBatchStatus =
  | "paused"
  | "open"
  | "running"
  | "completed"
  | "budget_exhausted"
  | "cancelled";

export type EnrichmentBatchItemStatus =
  "pending" | "queued" | "succeeded" | "failed" | "skipped";

export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  controlRevision?: number;
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

export type EnrichmentBatchRepository = ReturnType<
  typeof createBatchControlRepository
> & {
  create(input: CreateEnrichmentBatchInput): Promise<EnrichmentBatch>;
  getById(id: string): Promise<EnrichmentBatch | null>;
  listItemIds(batchId: string): Promise<string[]>;
  listItemsByStatus(
    batchId: string,
    status: EnrichmentBatchItemStatus,
  ): Promise<string[]>;
  /** Newest-first, this workspace's batches this listing belongs to only.
   * `limit` defaults to 100 and must be between 1 and 100, matching every
   * sibling repository's own bound. */
  listBatchesForListing(
    listingId: string,
    limit?: number,
  ): Promise<
    Array<{
      batchId: string;
      label: string;
      status: EnrichmentBatchStatus;
      createdAt: Date;
    }>
  >;
  countByStatus(batchId: string): Promise<EnrichmentBatchCounts>;
  /** Newest-first, this workspace's batches only. `limit` defaults to 100 and
   * must be between 1 and 100. */
  getByIds(ids: readonly string[]): Promise<EnrichmentBatch[]>;
  listForWorkspace(limit?: number): Promise<EnrichmentBatch[]>;
  /** Moves up to `limit` pending items to `queued` and returns their draft IDs. */
  claimWave(batchId: string, limit: number): Promise<string[]>;
  markItems(
    batchId: string,
    listingIds: readonly string[],
    status: EnrichmentBatchItemStatus,
  ): Promise<void>;
  bindRun(input: {
    batchId: string;
    listingId: string;
    pipelineRunId: string;
    inputRevision: number;
  }): Promise<boolean>;
  reconcileBoundRuns(batchId: string): Promise<void>;
  sumBoundRunCost(batchId: string): Promise<number>;
  setStatus(batchId: string, status: EnrichmentBatchStatus): Promise<void>;
};

const COLUMNS = {
  controlRevision: enrichmentBatches.controlRevision,
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
      eq(enrichmentBatchItems.isCurrent, true),
    );

  return {
    ...createBatchControlRepository(transaction, workspaceId, scope),
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

    async listBatchesForListing(listingId, limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("enrichment batch limit must be between 1 and 100");
      }
      const rows = await transaction
        .select({
          batchId: enrichmentBatchItems.batchId,
          label: enrichmentBatches.label,
          status: enrichmentBatches.status,
          createdAt: enrichmentBatches.createdAt,
        })
        .from(enrichmentBatchItems)
        .innerJoin(
          enrichmentBatches,
          and(
            eq(enrichmentBatches.workspaceId, enrichmentBatchItems.workspaceId),
            eq(enrichmentBatches.id, enrichmentBatchItems.batchId),
          ),
        )
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.listingId, listingId),
          ),
        )
        // Same tiebreak convention as `listForWorkspace`: batches created in
        // one shared transaction share Postgres's per-transaction `now()`, so
        // `id` breaks same-instant ties deterministically.
        .orderBy(desc(enrichmentBatches.createdAt), desc(enrichmentBatches.id))
        .limit(limit);
      return rows;
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

    async getByIds(ids) {
      scope.assertOpen();
      if (ids.length === 0) return [];
      if (ids.length > 100) throw new Error("read hydration exceeds page size");
      const rows = await transaction
        .select(COLUMNS)
        .from(enrichmentBatches)
        .where(
          and(
            eq(enrichmentBatches.workspaceId, workspaceId),
            inArray(enrichmentBatches.id, [...ids]),
          ),
        )
        // Rows created within one shared `db.forWorkspace` transaction share
        // Postgres's per-transaction `now()`, so `created_at` alone can tie --
        // `id` breaks the tie deterministically instead of leaving same-instant
        // rows in an arbitrary order.
        .orderBy(desc(enrichmentBatches.createdAt), desc(enrichmentBatches.id))
        .limit(100);
      return rows.map(toEnrichmentBatch);
    },

    async listForWorkspace(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("enrichment batch limit must be between 1 and 100");
      }
      const rows = await transaction
        .select(COLUMNS)
        .from(enrichmentBatches)
        .where(eq(enrichmentBatches.workspaceId, workspaceId))
        // Rows created within one shared `db.forWorkspace` transaction share
        // Postgres's per-transaction `now()`, so `created_at` alone can tie --
        // `id` breaks the tie deterministically instead of leaving same-instant
        // rows in an arbitrary order.
        .orderBy(desc(enrichmentBatches.createdAt), desc(enrichmentBatches.id))
        .limit(limit);
      return rows.map(toEnrichmentBatch);
    },

    async claimWave(batchId, limit) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("enrichment wave limit must be between 1 and 1000");
      }
      const active = await transaction.execute(
        sql`select id from enrichment_batches where workspace_id=${workspaceId} and id=${batchId}::uuid and status in ('open','running') for update`,
      );
      if (!active.length) return [];
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
        .set({
          status,
          outcome:
            status === "succeeded"
              ? "already_prepared"
              : status === "failed"
                ? "failed"
                : status === "skipped"
                  ? "skipped"
                  : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            itemsOfBatch(batchId),
            inArray(enrichmentBatchItems.listingId, [...listingIds]),
          ),
        );
    },

    async bindRun(input) {
      scope.assertOpen();
      // Serialize admission on the batch row. The next statement then gets a
      // fresh READ COMMITTED snapshot containing reservations committed by a
      // concurrent Advance that waited on the same lock.
      await transaction.execute(sql`
        select id from enrichment_batches
        where workspace_id=${workspaceId} and id=${input.batchId}::uuid
        for update`);
      const rows = await transaction.execute(sql`
        with charge as (
          select coalesce((
            select reserved_usd from ai_budget_reservations
            where workspace_id=${workspaceId}
              and pipeline_run_id=${input.pipelineRunId}::uuid
          ), 0::numeric) amount
        )
        update enrichment_batch_items i set
          pipeline_run_id=${input.pipelineRunId}::uuid,
          input_revision=${input.inputRevision},
          reserved_usd=charge.amount,
          updated_at=now()
        from charge, enrichment_batches b
        where i.workspace_id=${workspaceId}
          and i.batch_id=${input.batchId}::uuid
          and i.listing_id=${input.listingId}::uuid
          and i.status='queued' and i.is_current and i.pipeline_run_id is null
          and b.workspace_id=i.workspace_id and b.id=i.batch_id
          and (select coalesce(sum(existing.reserved_usd), 0::numeric)
               from enrichment_batch_items existing
               where existing.workspace_id=i.workspace_id
                 and existing.batch_id=i.batch_id) + charge.amount <= b.budget_usd
        returning i.id`);
      return Boolean(rows[0]);
    },

    async reconcileBoundRuns(batchId) {
      scope.assertOpen();
      await transaction.execute(sql`
        update enrichment_batch_items i set
          status=case
            when r.execution_state='succeeded' and r.result_status='in_review' then 'succeeded'::enrichment_batch_item_status
            when r.execution_state='failed' then 'failed'::enrichment_batch_item_status
            when r.execution_state in ('succeeded','superseded','cancelled') then 'skipped'::enrichment_batch_item_status
            else i.status end,
          outcome=case
            when r.execution_state='succeeded' and r.result_status='in_review' then 'this_run_success'
            when r.execution_state='succeeded' and r.result_status='needs_info' then 'needs_input'
            when r.execution_state='failed' then 'failed'
            when r.execution_state='superseded' then 'superseded'
            when r.execution_state='cancelled' then 'cancelled'
            else i.outcome end,
          updated_at=case when r.execution_state in ('succeeded','failed','superseded','cancelled') then now() else i.updated_at end
        from listing_pipeline_runs r
        where i.workspace_id=${workspaceId} and i.batch_id=${batchId}::uuid
          and i.status='queued' and i.pipeline_run_id=r.id and r.workspace_id=i.workspace_id`);
    },

    async sumBoundRunCost(batchId) {
      scope.assertOpen();
      const rows = await transaction.execute(sql`
        select coalesce(sum(coalesce(reservation.settled_usd,
                                     reservation.reserved_usd,
                                     calls.total)), 0)::text total
        from enrichment_batch_items i
        left join ai_budget_reservations reservation
          on reservation.workspace_id=i.workspace_id
          and reservation.pipeline_run_id=i.pipeline_run_id
        left join lateral (
          select sum(a.estimated_cost_usd) total from ai_runs a
          where a.workspace_id=i.workspace_id
            and a.pipeline_run_id=i.pipeline_run_id
        ) calls on true
        where i.workspace_id=${workspaceId} and i.batch_id=${batchId}::uuid`);
      return Number(rows[0]?.total ?? 0);
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
