import { getDatabase } from "../../../../../lib/intake-runtime";
import { jsonResponse, withRouteErrors } from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import { type StudioRouteDeps, studioServiceDeps } from "../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/threads/[id]` — thread plus bounded messages (viewer+).
 * A foreign or private thread the caller may not read is a 404 (plan Task 6).
 */
export function createStudioThreadHandler(deps: StudioRouteDeps) {
  return async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const { id } = await context.params;
      const thread = await createStudioService(
        studioServiceDeps(deps),
      ).getThread(id);
      return jsonResponse(200, { ...thread });
    });
}

const handlers = createStudioThreadHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers;
