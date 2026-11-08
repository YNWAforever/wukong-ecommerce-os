import { getDatabase } from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import { sendMessageBodySchema } from "../../../../../../lib/studio/contracts";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../../lib/studio/turn-service";

/**
 * `POST /api/studio/threads/[id]/messages` — one bounded conversation turn
 * (operator+, plan Task 6 / spec §3.2).
 *
 * Response codes: 400 invalid body, 401 unauthenticated, 403 below operator,
 * 404 disabled Studio / foreign or private thread, 409 duplicate
 * clientMessageId whose run is running/failed, 200 composed reply.
 */
export function createStudioMessageHandler(deps: StudioRouteDeps) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const { id } = await context.params;
      let json: unknown;
      try {
        json = await request.json();
      } catch {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const parsed = sendMessageBodySchema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const result = await createStudioService(
        studioServiceDeps(deps),
      ).sendMessage(id, parsed.data);
      return jsonResponse(200, { ...result });
    });
}

const handlers = createStudioMessageHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const POST = handlers;
