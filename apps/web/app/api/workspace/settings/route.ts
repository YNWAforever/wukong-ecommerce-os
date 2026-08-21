import { z } from "zod";

import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

const bodySchema = z
  .object({
    brandBackgroundColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable(),
  })
  .strict();

type SettingsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createSettingsHandler(deps: SettingsRouteDeps) {
  return async function settingsHandler(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Admin access is required.",
        );
      }
      const parsed = bodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Invalid settings payload.");
      }
      await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const current = await repositories.workspaces.requireProfile();
          await repositories.workspaces.updateProfile({
            ...current,
            brandBackgroundColor: parsed.data.brandBackgroundColor,
          });
        });
      return jsonResponse(200, { ok: true });
    });
  };
}

export const POST = createSettingsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
