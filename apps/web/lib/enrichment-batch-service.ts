import type { Database, PlatformProduct } from "@wukong/db";
import { bulkFormGaps, type BulkFormContentGaps } from "@wukong/shopline";

import type { ListingPublisher } from "./listing-queue-runtime.js";
import { ApiError } from "./route-support";

export type EnrichmentGap = keyof BulkFormContentGaps;

export type EnrichmentBatchServiceDeps = {
  getDatabase(): Database;
  publisher: ListingPublisher;
};

export type CreateBatchInput = {
  workspaceId: string;
  actorId: string;
  label: string;
  gap: EnrichmentGap;
  budgetUsd: number;
  waveSize: number;
};

export type CreateBatchResult = {
  batchId: string;
  selected: number;
  budgetUsd: number;
  waveSize: number;
};

/** Ten times the pilot catalog, matching the import cap. */
const MAX_BATCH_ITEMS = 5_000;

export type AdvanceBatchInput = {
  workspaceId: string;
  actorId: string;
  batchId: string;
};

export type AdvanceBatchResult = {
  batchId: string;
  status: "running" | "completed" | "budget_exhausted";
  enqueued: number;
  spentUsd: number;
  budgetUsd: number;
};

/**
 * A queued draft in one of these states has finished its enrichment run. The
 * two lists are disjoint and neither contains `received` or `processing`, so a
 * draft still in flight stays queued and cannot be counted twice.
 */
const SUCCEEDED_STATUSES = [
  "in_review",
  "approved",
  "publishing",
  "published",
] as const;
const FAILED_STATUSES = ["failed", "publish_failed"] as const;

const includes = (statuses: readonly string[], value: string | undefined) =>
  value !== undefined && statuses.includes(value);

/**
 * A create-origin product (published to SHOPLINE directly, never imported
 * through the bulk form) has no imported row and so `rawRow` is `null` — it
 * has nothing for `bulkFormGaps` to read. Narrowing on `origin` here, rather
 * than on `rawRow !== null`, keeps the filter's meaning aligned with *why*
 * the row is excluded and lets the compiler carry the non-null `rawRow`
 * forward to the `bulkFormGaps` call below.
 *
 * This is the only call site of `bulkFormGaps`, so today a create-origin
 * listing is invisible to gap-based enrichment entirely — there is no
 * imported sheet row (or any other data source) to measure gaps against.
 * A future gap detector for create-origin listings would need its own
 * facts-based comparison, not a relaxation of this filter.
 */
const isImportOrigin = (
  product: PlatformProduct,
): product is PlatformProduct & {
  rawRow: NonNullable<PlatformProduct["rawRow"]>;
} => product.origin === "import";

export function createEnrichmentBatchService(deps: EnrichmentBatchServiceDeps) {
  async function createBatch(
    input: CreateBatchInput,
  ): Promise<CreateBatchResult> {
    // Validated before the transaction opens: a rejected batch must not hold a
    // pooled connection, and the cohort scan is wasted work once the budget or
    // the wave size is already unusable.
    if (!(input.budgetUsd > 0)) {
      throw new ApiError(
        400,
        "invalid_budget",
        "A batch needs a budget greater than zero.",
      );
    }
    if (!Number.isInteger(input.waveSize) || input.waveSize < 1) {
      throw new ApiError(
        400,
        "invalid_wave_size",
        "Wave size must be a positive whole number.",
      );
    }

    return deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repositories) => {
        const products =
          await repositories.platformProducts.listRecent(MAX_BATCH_ITEMS);

        // A product with no draft has nothing to enrich; the gap is computed
        // from the stored snapshot so the cohort is a query, not a hand-picked
        // list.
        const listingIds = products
          .filter((product) => product.listingId !== null)
          .filter(isImportOrigin)
          .filter((product) => bulkFormGaps(product.rawRow)[input.gap])
          .map((product) => product.listingId as string);

        if (listingIds.length === 0) {
          throw new ApiError(
            422,
            "empty_cohort",
            "No products match that gap, so there is nothing to enrich.",
          );
        }

        const batch = await repositories.enrichmentBatches.create({
          label: input.label,
          budgetUsd: input.budgetUsd,
          waveSize: input.waveSize,
          createdBy: input.actorId,
          listingIds,
        });

        // Metadata carries identifiers and counts only — never merchant
        // content, so no product name, price or SKU appears here.
        await repositories.audit.write({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          entityId: batch.id,
          action: "enrichment_batch.created",
          metadata: {
            gap: input.gap,
            selected: listingIds.length,
            budgetUsd: input.budgetUsd,
            waveSize: input.waveSize,
          },
        });

        return {
          batchId: batch.id,
          selected: listingIds.length,
          budgetUsd: batch.budgetUsd,
          waveSize: batch.waveSize,
        };
      });
  }

  async function advanceBatch(
    input: AdvanceBatchInput,
  ): Promise<AdvanceBatchResult> {
    const plan = await deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repositories) => {
        const batch = await repositories.enrichmentBatches.getById(
          input.batchId,
        );
        if (!batch) {
          throw new ApiError(
            404,
            "batch_not_found",
            "No such enrichment batch.",
          );
        }

        // Reconcile before doing anything else. A queued draft that has since
        // reached a terminal state is no longer in flight, and until it is
        // recorded as such the batch can never report itself complete and a
        // failed product would look like work still pending.
        const queued = await repositories.enrichmentBatches.listItemsByStatus(
          input.batchId,
          "queued",
        );
        if (queued.length > 0) {
          const statuses = await repositories.listings.statusesByIds(queued);
          const succeeded = queued.filter((id) =>
            includes(SUCCEEDED_STATUSES, statuses[id]),
          );
          const failed = queued.filter((id) =>
            includes(FAILED_STATUSES, statuses[id]),
          );
          await repositories.enrichmentBatches.markItems(
            input.batchId,
            succeeded,
            "succeeded",
          );
          // A failed product does not block the batch and is not retried here;
          // re-running failures is a new, separately budgeted batch.
          await repositories.enrichmentBatches.markItems(
            input.batchId,
            failed,
            "failed",
          );
        }

        // Budget is enforced on observed spend, never on a stored running
        // total, so it cannot drift out of sync with the runs it counts.
        const itemIds = await repositories.enrichmentBatches.listItemIds(
          input.batchId,
        );
        const spentUsd = await repositories.aiRuns.sumCostForListings(itemIds);

        if (spentUsd >= batch.budgetUsd) {
          await repositories.enrichmentBatches.setStatus(
            input.batchId,
            "budget_exhausted",
          );
          return { batch, spentUsd, wave: [] as string[], done: false };
        }

        const wave = await repositories.enrichmentBatches.claimWave(
          input.batchId,
          batch.waveSize,
        );
        if (wave.length === 0) {
          const counts = await repositories.enrichmentBatches.countByStatus(
            input.batchId,
          );
          // Queued items are still in flight, so the batch is only done once
          // reconciliation has emptied both buckets.
          const done = counts.pending === 0 && counts.queued === 0;
          if (done) {
            await repositories.enrichmentBatches.setStatus(
              input.batchId,
              "completed",
            );
          }
          return { batch, spentUsd, wave, done };
        }

        await repositories.enrichmentBatches.setStatus(
          input.batchId,
          "running",
        );
        return { batch, spentUsd, wave, done: false };
      });

    if (plan.wave.length === 0) {
      return {
        batchId: input.batchId,
        status:
          plan.spentUsd >= plan.batch.budgetUsd
            ? "budget_exhausted"
            : plan.done
              ? "completed"
              : "running",
        enqueued: 0,
        spentUsd: plan.spentUsd,
        budgetUsd: plan.batch.budgetUsd,
      };
    }

    // Enqueue outside the transaction: the queue is a remote service and must
    // not hold a pooled connection open. Items are already `queued`, so a
    // failure here leaves them claimed rather than silently re-runnable.
    let enqueued = 0;
    for (const draftId of plan.wave) {
      await deps.publisher.enqueue({
        workspaceId: input.workspaceId,
        draftId,
        activeVersionSequence: 0,
      });
      enqueued += 1;
    }

    await deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repositories) => {
        // Counts and money only — no draft note, product name or SKU.
        await repositories.audit.write({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          entityId: input.batchId,
          action: "enrichment_batch.advanced",
          metadata: {
            enqueued,
            spentUsd: plan.spentUsd,
            budgetUsd: plan.batch.budgetUsd,
          },
        });
      });

    console.info(
      JSON.stringify({
        event: "enrichment_batch.advanced",
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        enqueued,
        spentUsd: plan.spentUsd,
        budgetUsd: plan.batch.budgetUsd,
      }),
    );

    return {
      batchId: input.batchId,
      status: "running",
      enqueued,
      spentUsd: plan.spentUsd,
      budgetUsd: plan.batch.budgetUsd,
    };
  }

  return { createBatch, advanceBatch };
}
