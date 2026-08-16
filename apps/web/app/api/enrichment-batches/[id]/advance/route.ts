import {
  createEnrichmentBatchService,
  type AdvanceBatchInput,
  type AdvanceBatchResult,
} from "../../../../../lib/enrichment-batch-service";
import { getDatabase } from "../../../../../lib/intake-runtime";
import { listingPublisher } from "../../../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

export type AdvanceRouteDeps = {
  sessionContext: SessionContextPort;
  advanceBatch(input: AdvanceBatchInput): Promise<AdvanceBatchResult>;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createAdvanceEnrichmentBatchHandler(deps: AdvanceRouteDeps) {
  return async function advanceEnrichmentBatch(
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
      // An exhausted budget is a normal outcome, not a failure: the operator
      // asked whether there was more to do and the answer is no.
      const result = await deps.advanceBatch({
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        batchId: id,
      });

      return jsonResponse(200, result);
    });
  };
}

const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const POST = createAdvanceEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  advanceBatch: service.advanceBatch,
});
