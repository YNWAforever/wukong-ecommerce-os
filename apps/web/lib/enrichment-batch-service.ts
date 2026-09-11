import type {
  Database,
  EnrichmentBatch,
  EnrichmentBatchCounts,
  PlatformProduct,
  WorkspaceRepositories,
} from "@wukong/db";
import { listingRunKey } from "@wukong/jobs";
import { bulkFormGaps, type BulkFormContentGaps } from "@wukong/shopline";

import type { ListingPublisher } from "./listing-queue-runtime.js";
import { ApiError } from "./route-support";

export type { EnrichmentBatch };

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

export type ListBatchesInput = { workspaceId: string };

export type GetBatchInput = { workspaceId: string; batchId: string };

export type GetBatchResult = {
  batch: EnrichmentBatch;
  counts: EnrichmentBatchCounts;
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

/**
 * The only statuses the pipeline can start from.
 *
 * Mirrors `retryableStatuses` in the manual re-run route, and for the same
 * reason: `transitionListing` accepts `start_processing` only from
 * received/needs_info and `retry` only from failed. The batch never checked,
 * which was harmless only because every batch job carried the same stale key
 * and was deduplicated into a no-op. A real job for an `approved` or
 * `published` draft runs extraction AND generation and then throws "Illegal
 * transition" on completion -- and that throw rolls back the cost record
 * written in the same transaction, so the money is spent somewhere no budget
 * can ever see it.
 */
const RUNNABLE_STATUSES = ["received", "needs_info", "failed"] as const;

/**
 * Finished, but not anywhere this batch can take further.
 *
 * A run that ended `needs_info` asked for information the batch has no way to
 * supply, and `reopened` means someone took the draft back by hand. Neither is
 * a success or a failure, and neither was in either list -- so the item stayed
 * `queued` and the batch could never report itself complete.
 */
const UNRESOLVED_STATUSES = ["needs_info", "reopened"] as const;

/** Exactly what the publisher accepts, so the two cannot drift apart. */
type WaveJob = Parameters<ListingPublisher["enqueue"]>[0];

/**
 * How long a recorded-but-unsent job waits before another advance re-sends it.
 *
 * A wave is at most five messages, so a healthy dispatch finishes in well under
 * a second; anything still unsent after a minute belongs to a request that did
 * not survive. Long enough that a concurrent advance does not race the one
 * currently sending -- and if two ever did overlap, the duplicate is harmless:
 * both carry the same run key, and the pipeline deduplicates on it.
 */
const OUTBOX_GRACE_SECONDS = 60;

/** Marks items, skipping the write entirely when there is nothing to mark. */
async function markItems(
  repositories: WorkspaceRepositories,
  batchId: string,
  listingIds: readonly string[],
  status: "succeeded" | "failed" | "skipped",
): Promise<void> {
  if (listingIds.length === 0) return;
  await repositories.enrichmentBatches.markItems(batchId, listingIds, status);
}

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
    if (
      !Number.isInteger(input.waveSize) ||
      input.waveSize < 1 ||
      input.waveSize > 5
    ) {
      throw new ApiError(
        400,
        "invalid_wave_size",
        "Wave size must be a whole number from 1 to 5.",
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

  /**
   * Turns a claimed wave into the jobs that are actually worth sending.
   *
   * Two defects met here. Every batch job was enqueued with
   * `activeVersionSequence: 0`, so for any draft that had already been through
   * the pipeline the key resolved to a run that was already complete and the
   * Worker returned the cached result without calling the model: the item was
   * marked queued, reconciled as succeeded, and the catalog was unchanged --
   * an operator saw "enqueued: 5" against five listings nothing had touched.
   * And the cohort makes that the expected case, not a corner: the gap is
   * computed from an imported sheet row that enrichment never rewrites, so a
   * second batch re-selects exactly the same drafts.
   *
   * Resolving the real revision fixes the no-op and exposes the second defect,
   * which is why both land together: a real job for a draft that is already
   * approved or published spends on the model and then throws on the status
   * transition. So the status is checked before anything is sent.
   *
   * Mutual exclusion still comes from the item status, not the queue key.
   * `claimWave` claims only `pending` rows and leaves them `queued`, and
   * nothing moves an item back, so a second advance cannot re-send a draft
   * whose job is still in flight.
   */
  async function planWave(
    repositories: WorkspaceRepositories,
    input: AdvanceBatchInput,
    wave: readonly string[],
  ): Promise<WaveJob[]> {
    const statuses = await repositories.listings.statusesByIds([...wave]);
    const jobs: WaveJob[] = [];
    const finished: string[] = [];
    const unusable: string[] = [];
    for (const draftId of wave) {
      const status = statuses[draftId];
      if (!includes(RUNNABLE_STATUSES, status)) {
        // Already carried past enrichment by someone else, or in a state the
        // pipeline cannot start from. Either way it is settled, not pending.
        (includes(SUCCEEDED_STATUSES, status) ? finished : unusable).push(
          draftId,
        );
        continue;
      }
      const revision = await repositories.listings.requireById(draftId);
      // Runs for a revision are numbered from 0, so N recorded runs means the
      // next free number is N. The batch always wants a NEW run.
      const recordedRuns = await repositories.pipelineRuns.countRuns({
        listingId: draftId,
        activeVersionSequence: revision.activeVersionSequence,
      });
      jobs.push({
        workspaceId: input.workspaceId,
        draftId,
        activeVersionSequence: revision.activeVersionSequence,
        // Attempt 0 must not put the field on the wire at all: a Worker
        // deployed before `runAttempt` existed parses strictly and would
        // silently ack the message away.
        ...(recordedRuns > 0 ? { runAttempt: recordedRuns } : {}),
      });
    }
    await markItems(repositories, input.batchId, finished, "succeeded");
    await markItems(repositories, input.batchId, unusable, "skipped");
    return jobs;
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
          await markItems(repositories, input.batchId, succeeded, "succeeded");
          // A failed product does not block the batch and is not retried here;
          // re-running failures is a new, separately budgeted batch.
          await markItems(repositories, input.batchId, failed, "failed");
          // Neither succeeded nor failed, and previously in neither list, so
          // the item sat `queued` for ever and `done` below could never become
          // true. The batch has nothing further to try for these.
          await markItems(
            repositories,
            input.batchId,
            queued.filter((id) => includes(UNRESOLVED_STATUSES, statuses[id])),
            "skipped",
          );
        }

        // Work an earlier advance recorded and never confirmed as sent. The
        // grace window keeps a wave that is dispatching right now out of this,
        // so a second advance cannot race the one currently sending.
        const stranded = await repositories.dispatchOutbox.pending({
          olderThanSeconds: OUTBOX_GRACE_SECONDS,
          maxRows: 100,
        });

        // Budget is enforced on observed spend, never on a stored running
        // total, so it cannot drift out of sync with the runs it counts.
        const itemIds = await repositories.enrichmentBatches.listItemIds(
          input.batchId,
        );
        // Bounded to this batch's own lifetime. Unbounded, the sum is every
        // run those drafts have ever had, so a second batch over a cohort an
        // earlier one already enriched opened pre-charged with that spend --
        // and could exhaust its budget on the first advance without enqueuing
        // anything, with no budget an operator could set to escape it.
        const spentUsd = await repositories.aiRuns.sumCostForListings(itemIds, {
          since: batch.createdAt,
        });

        if (spentUsd >= batch.budgetUsd) {
          await repositories.enrichmentBatches.setStatus(
            input.batchId,
            "budget_exhausted",
          );
          // Stranded work still goes out. The money was committed when the
          // item was claimed; the message merely never left. Withholding it
          // now would leave the item queued for ever with nothing owed to it.
          return { batch, spentUsd, dispatches: stranded, done: false };
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
          return { batch, spentUsd, dispatches: stranded, done };
        }

        await repositories.enrichmentBatches.setStatus(
          input.batchId,
          "running",
        );
        const jobs = await planWave(repositories, input, wave);
        // Recorded INSIDE the claim transaction, which is the whole point: if
        // this request dies before the queue call, the row already says what
        // was owed. `listing_pipeline_runs` cannot answer that question --
        // it appears only once the pipeline claims its first step, so its
        // absence cannot tell "never sent" from "sent and still queued".
        const recorded = await repositories.dispatchOutbox.record(
          jobs.map((job) => ({
            listingId: job.draftId,
            dedupeKey: listingRunKey(job),
            payload: job as unknown as Record<string, unknown>,
          })),
        );
        return {
          batch,
          spentUsd,
          dispatches: [...stranded, ...recorded],
          done: false,
        };
      });

    // Derived once. Sending stranded work no longer implies the batch is
    // running: a budget-exhausted batch can still owe messages from a wave it
    // paid for, and reporting that as `running` told the operator the batch had
    // resumed when it had not.
    const status =
      plan.spentUsd >= plan.batch.budgetUsd
        ? ("budget_exhausted" as const)
        : plan.done
          ? ("completed" as const)
          : ("running" as const);

    if (plan.dispatches.length === 0) {
      return {
        batchId: input.batchId,
        status,
        enqueued: 0,
        spentUsd: plan.spentUsd,
        budgetUsd: plan.batch.budgetUsd,
      };
    }

    // Enqueue outside the transaction: the queue is a remote service and must
    // not hold a pooled connection open. Every job is already recorded, so a
    // failure here is recoverable rather than lost -- which is why one send
    // failing no longer abandons the rest of the wave.
    const delivered: string[] = [];
    const unsent: string[] = [];
    let firstFailure: unknown;
    for (const entry of plan.dispatches) {
      try {
        await deps.publisher.enqueue(entry.payload as unknown as WaveJob);
        delivered.push(entry.id);
      } catch (error) {
        firstFailure ??= error;
        unsent.push(entry.id);
      }
    }
    const enqueued = delivered.length;

    await deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repositories) => {
        // Confirm before auditing: the audit event reports what the queue
        // accepted, and it must not claim more than the outbox records.
        await repositories.dispatchOutbox.markDispatched(delivered);
        await repositories.dispatchOutbox.markAttempted(unsent);
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

    // Nothing reached the queue. The work is safe -- every job is recorded and
    // the next advance re-sends it -- but answering 200 with `enqueued: 0`
    // would tell the operator the queue is healthy when it plainly is not.
    if (enqueued === 0 && unsent.length > 0) throw firstFailure;

    return {
      batchId: input.batchId,
      status,
      enqueued,
      spentUsd: plan.spentUsd,
      budgetUsd: plan.batch.budgetUsd,
    };
  }

  async function listBatches(
    input: ListBatchesInput,
  ): Promise<EnrichmentBatch[]> {
    return deps
      .getDatabase()
      .forWorkspace(input.workspaceId, (repositories) =>
        repositories.enrichmentBatches.listForWorkspace(),
      );
  }

  async function getBatch(input: GetBatchInput): Promise<GetBatchResult> {
    return deps
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
        const counts = await repositories.enrichmentBatches.countByStatus(
          input.batchId,
        );
        return { batch, counts };
      });
  }

  return { createBatch, advanceBatch, listBatches, getBatch };
}
