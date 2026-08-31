import { z } from "zod";

import {
  createEnrichmentBatchService,
  type CreateBatchInput,
  type CreateBatchResult,
  type EnrichmentBatch,
} from "../../../lib/enrichment-batch-service";
import { getDatabase } from "../../../lib/intake-runtime";
import { listingPublisher } from "../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

const bodySchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    gap: z.enum([
      "untranslatedName",
      "untranslatedSeoTitle",
      "seoTitleMirrorsName",
      "seoDescriptionMirrorsSeoTitle",
      "keywordsMirrorName",
      "summaryMissing",
    ]),
    budgetUsd: z.number().positive().max(10_000),
    waveSize: z.number().int().min(1).max(5),
  })
  .strict();

export type EnrichmentBatchRouteDeps = {
  sessionContext: SessionContextPort;
  createBatch(input: CreateBatchInput): Promise<CreateBatchResult>;
};

export function createEnrichmentBatchHandler(deps: EnrichmentBatchRouteDeps) {
  return async function createEnrichmentBatch(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const body = bodySchema.parse(await request.json());
      const result = await deps.createBatch({
        ...body,
        // Session identity last: the tenancy boundary must not depend on the
        // body schema staying `.strict()`. It rejects a stray workspaceId today,
        // but a future schema edit should not be able to open a hole here.
        workspaceId: context.workspaceId,
        actorId: context.actorId,
      });

      return jsonResponse(201, result);
    });
  };
}

export type ListEnrichmentBatchesRouteDeps = {
  sessionContext: SessionContextPort;
  listBatches(input: { workspaceId: string }): Promise<EnrichmentBatch[]>;
};

export function createListEnrichmentBatchesHandler(
  deps: ListEnrichmentBatchesRouteDeps,
) {
  return async function listEnrichmentBatches(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const batches = await deps.listBatches({
        workspaceId: context.workspaceId,
      });

      return jsonResponse(200, {
        batches: batches.map((batch) => ({
          ...batch,
          createdAt: batch.createdAt.toISOString(),
        })),
      });
    });
  };
}

const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const POST = createEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  createBatch: service.createBatch,
});

export const GET = createListEnrichmentBatchesHandler({
  sessionContext: authSessionContext,
  listBatches: service.listBatches,
});
