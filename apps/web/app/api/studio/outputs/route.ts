import { getDatabase } from "../../../../lib/intake-runtime";
import { jsonResponse, withRouteErrors } from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/outputs` - versioned Studio artifacts (viewer+).
 *
 * Deterministic read: no model call and no budget reservation. A foreign
 * workspace's outputs are invisible because every read goes through
 * `forWorkspace`.
 */
export function createStudioOutputsHandler(deps: StudioRouteDeps) {
  return async (_request: Request) =>
    withRouteErrors(async () => {
      const listed = await createStudioService(
        studioServiceDeps(deps),
      ).listOutputs();
      return jsonResponse(200, { ...listed });
    });
}

const handlers = createStudioOutputsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers;
