import {
  batchCreateInputSchema,
  createBatchSelectionService,
} from "../../../lib/batch-selection";

import {
  createEnrichmentBatchService,
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

export type EnrichmentBatchRouteDeps = {
  sessionContext: SessionContextPort;
  createBatch(input: {
    workspaceId: string;
    actorId: string;
    previewId: string;
    digest: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>>;
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

      const body = batchCreateInputSchema.parse(await request.json());
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
  listBatches(input: {
    workspaceId: string;
    includeArchived?: boolean;
  }): Promise<EnrichmentBatch[]>;
};

export function createListEnrichmentBatchesHandler(
  deps: ListEnrichmentBatchesRouteDeps,
) {
  return async function listEnrichmentBatches(
    request?: Request,
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

      const batches = await deps.listBatches({
        workspaceId: context.workspaceId,
        ...(request &&
        new URL(request.url).searchParams.get("includeArchived") === "true"
          ? { includeArchived: true }
          : {}),
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
  createBatch: createBatchSelectionService({ getDatabase }).create,
});

export const GET = createListEnrichmentBatchesHandler({
  sessionContext: authSessionContext,
  listBatches: service.listBatches,
});
