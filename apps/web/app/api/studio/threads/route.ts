import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import { createThreadBodySchema } from "../../../../lib/studio/contracts";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/threads` (list, viewer+) and
 * `POST /api/studio/threads` (create, operator+). Plan Task 6.
 *
 * The workspace always comes from the resolved session; body parsing is a
 * strict zod schema so a tenant/role/model field is a 400, never honoured.
 */

export function createStudioThreadsHandlers(deps: StudioRouteDeps) {
  const service = () => createStudioService(studioServiceDeps(deps));
  return {
    GET: async (_request: Request) =>
      withRouteErrors(async () => {
        const listed = await service().listThreads();
        return jsonResponse(200, { ...listed });
      }),
    POST: async (request: Request) =>
      withRouteErrors(async () => {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          throw new ApiError(
            400,
            "invalid_body",
            "Request body is invalid.",
          );
        }
        const parsed = createThreadBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new ApiError(
            400,
            "invalid_body",
            "Request body is invalid.",
          );
        }
        const created = await service().createThread(parsed.data);
        return jsonResponse(201, { ...created });
      }),
  };
}

type DefaultDeps = {
  sessionContext: StudioRouteDeps["sessionContext"];
  getDatabase: StudioRouteDeps["getDatabase"];
};

const handlers = createStudioThreadsHandlers({
  sessionContext: authSessionContext,
  getDatabase,
} satisfies DefaultDeps);

export const GET = handlers.GET;
export const POST = handlers.POST;
