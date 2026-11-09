import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import { studioOutputListQuerySchema } from "../../../../lib/studio/contracts";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/outputs` - versioned Studio artifacts (viewer+).
 *
 * Deterministic read: no model call and no budget reservation. `?q=` is a
 * server-side title search and `?kind=`/`?status=` are exact filters; a foreign
 * workspace's outputs are invisible because every read goes through
 * `forWorkspace`.
 */
export function createStudioOutputsHandler(deps: StudioRouteDeps) {
  return async (request: Request) =>
    withRouteErrors(async () => {
      const parsed = studioOutputListQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!parsed.success)
        throw new ApiError(
          400,
          "invalid_query",
          "Query parameters are invalid.",
        );
      const listed = await createStudioService(
        studioServiceDeps(deps),
      ).listOutputs(parsed.data);
      return jsonResponse(200, { ...listed });
    });
}

const handlers = createStudioOutputsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers;
