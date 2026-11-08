import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import { outputActionBodySchema } from "../../../../../lib/studio/contracts";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../lib/studio/route-deps";
import { createStudioService } from "../../../../../lib/studio/turn-service";

/**
 * `GET /api/studio/outputs/[id]` - artifact plus its immutable versions
 * (viewer+). `POST` `{action:"save"|"sign_off"}` - operator+ saves a review
 * artifact; reviewer+ signs it off. Neither path writes canonical listing
 * data: the existing listing review screen remains the only apply surface.
 */
export function createStudioOutputHandler(deps: StudioRouteDeps) {
  const service = () => createStudioService(studioServiceDeps(deps));
  return {
    GET: async (
      _request: Request,
      context: { params: Promise<{ id: string }> },
    ) =>
      withRouteErrors(async () => {
        const { id } = await context.params;
        const output = await service().getOutput(id);
        return jsonResponse(200, { ...output });
      }),
    POST: async (
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
        const parsed = outputActionBodySchema.safeParse(json);
        if (!parsed.success)
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        const result = await service().setOutputStatus(id, parsed.data.action);
        return jsonResponse(200, { ...result });
      }),
  };
}

const handlers = createStudioOutputHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
