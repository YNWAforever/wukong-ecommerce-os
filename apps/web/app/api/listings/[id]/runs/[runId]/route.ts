import { z } from "zod";
import type { Database } from "@wukong/db";
import { getDatabase } from "../../../../../../lib/intake-runtime";
import { candidateDifferences } from "../../../../../../lib/listing-candidate-service";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../../lib/session-context-port";
export function createListingRunHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase: () => Pick<Database, "forWorkspace">;
}) {
  return async (
    _request: Request,
    context: { params: Promise<{ id: string; runId: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      const { id, runId } = await context.params;
      if (
        !z.string().uuid().safeParse(id).success ||
        !z.string().uuid().safeParse(runId).success
      )
        throw new ApiError(404, "run_not_found", "Run not found.");
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repos) => {
          const run = await repos.pipelineRuns.getOperation(runId);
          if (!run || run.listingId !== id)
            throw new ApiError(404, "run_not_found", "Run not found.");
          const current = await repos.listingInputs.getCurrent(id);
          return {
            runId: run.id,
            state: run.executionState,
            attempt: run.runAttempt,
            retryOfRunId: run.retryOfRunId,
            acceptedAt: run.acceptedAt,
            inputRevision: run.inputRevision,
            baseVersionId: run.baseVersionId,
            error: run.errorCode ? { code: run.errorCode } : null,
            candidate: current ? candidateDifferences(run, current) : null,
          };
        });
      const response = jsonResponse(200, result);
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
}
export const GET = createListingRunHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
