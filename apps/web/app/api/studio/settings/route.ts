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
import {
  createStudioSettingsAdminService,
  updateStudioSettingsBodySchema,
} from "../../../../lib/studio/settings-admin";

/**
 * `GET`/`PATCH /api/studio/settings` — admin workspace Studio configuration.
 *
 * This is the audited replacement for hand-written SQL in the conversation
 * studio runbook. Both verbs go through `requireStudioSession(deps, "admin")`:
 * a disabled Studio answers 404, a below-admin role 403, and an unknown or
 * otherwise invalid body is a 400 before any write. `PATCH` returns the row
 * read back from the database, never a local echo of the request.
 */
export function createStudioSettingsHandlers(deps: StudioRouteDeps) {
  const service = () =>
    createStudioSettingsAdminService(studioServiceDeps(deps));
  return {
    GET: async (_request: Request) =>
      withRouteErrors(async () => {
        const view = await service().getWorkspaceSettings();
        return jsonResponse(200, { ...view });
      }),
    PATCH: async (request: Request) =>
      withRouteErrors(async () => {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          throw new ApiError(400, "invalid_body", "Request body is invalid.");
        }
        const parsed = updateStudioSettingsBodySchema.safeParse(json);
        if (!parsed.success) {
          throw new ApiError(
            400,
            "invalid_settings",
            "Workspace settings are invalid.",
          );
        }
        const updated = await service().updateWorkspaceSettings(parsed.data);
        return jsonResponse(200, { ...updated });
      }),
  };
}

const handlers = createStudioSettingsHandlers({
  sessionContext: authSessionContext,
  getDatabase,
});

export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
