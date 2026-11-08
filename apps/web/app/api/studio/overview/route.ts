import { getDatabase } from "../../../../lib/intake-runtime";
import { jsonResponse, withRouteErrors } from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/overview` ??the deterministic home strip (viewer+).
 *
 * Reads canonical repositories only: listing counts, the quality projection
 * and recent pipeline runs. It never reserves budget and never calls a model
 * (spec section 3.11), so the counts are as free as any other read.
 */
export function createStudioOverviewHandler(deps: StudioRouteDeps) {
  return async (_request: Request) =>
    withRouteErrors(async () => {
      const overview = await createStudioService(
        studioServiceDeps(deps),
      ).overview();
      return jsonResponse(200, { ...overview });
    });
}

const handlers = createStudioOverviewHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers;
