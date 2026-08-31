import {
  createEnrichmentBatchService,
  type GetBatchInput,
  type GetBatchResult,
} from "../../../../lib/enrichment-batch-service";
import { getDatabase } from "../../../../lib/intake-runtime";
import { listingPublisher } from "../../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

export type GetEnrichmentBatchRouteDeps = {
  sessionContext: SessionContextPort;
  getBatch(input: GetBatchInput): Promise<GetBatchResult>;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createGetEnrichmentBatchHandler(
  deps: GetEnrichmentBatchRouteDeps,
) {
  return async function getEnrichmentBatch(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const { id } = await context.params;
      const { batch, counts } = await deps.getBatch({
        workspaceId: session.workspaceId,
        batchId: id,
      });

      return jsonResponse(200, {
        batch: { ...batch, createdAt: batch.createdAt.toISOString() },
        counts,
      });
    });
  };
}

const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const GET = createGetEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  getBatch: service.getBatch,
});
