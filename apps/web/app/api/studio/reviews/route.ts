import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../lib/studio/turn-service";

/**
 * Bounded multi-listing review (2026-11-16 plan).
 *
 * `POST` starts one explicit, capped review of up to five listings: the
 * deterministic audit and gap stages run sequentially, each in its own guided
 * thread, and per-listing failures are reported instead of aborting the batch.
 * `GET ?listingIds=a,b` rebuilds the recorded state after a reload (viewer+).
 * Neither path is a scheduler: nothing runs without the operator's request, and
 * no copy proposal or model call is triggered here.
 */
export function createStudioReviewsHandler(deps: StudioRouteDeps) {
  const service = () => createStudioService(studioServiceDeps(deps));
  return {
    GET: async (request: Request) =>
      withRouteErrors(async () => {
        const params = new URL(request.url).searchParams;
        if (new Set(params.keys()).size !== params.size)
          throw new ApiError(
            400,
            "invalid_query",
            "Duplicate query parameters.",
          );
        const result = await service().listingReviews(
          Object.fromEntries(params),
        );
        return jsonResponse(200, { ...result });
      }),
    POST: async (request: Request) =>
      withRouteErrors(async () => {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const result = await service().startReviewBatch(json);
        return jsonResponse(200, { ...result });
      }),
  };
}

const handlers = createStudioReviewsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
