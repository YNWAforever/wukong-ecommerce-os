import type { Database } from "@wukong/db";
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

  return { createBatch };
}
