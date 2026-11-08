import { getDatabase } from "../../../../../../../lib/intake-runtime";
import {
  jsonResponse,
  withRouteErrors,
} from "../../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/threads/[id]/runs/[runId]` — run status, usage and the
 * ordered persisted trace events for polling (viewer+). Plan Task 6.
 */
export function createStudioRunHandler(deps: StudioRouteDeps) {
  return async (
    _request: Request,
    context: { params: Promise<{ id: string; runId: string }> },
  ) =>
    withRouteErrors(async () => {
      const { id, runId } = await context.params;
      const run = await createStudioService(studioServiceDeps(deps)).getRun(
        id,
        runId,
      );
      return jsonResponse(200, { ...run });
    });
}

const handlers = createStudioRunHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers;
