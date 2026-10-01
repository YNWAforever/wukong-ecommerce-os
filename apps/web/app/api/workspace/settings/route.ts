import { createHash } from "node:crypto";
import { workspaceProfileSchema, type WorkspaceProfile } from "@wukong/core";
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
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
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
      let profile: WorkspaceProfile;
      try {
        profile = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const next = await repositories.workspaces.updateSettings(
              {
                brandBackgroundColor: parsed.data.brandBackgroundColor,
              },
              parsed.data.expectedDigest,
            );
            await repositories.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: session.workspaceId,
              action: "workspace.settings_updated",
              metadata: {
                brandBackgroundColor: parsed.data.brandBackgroundColor,
              },
            });
            return next;
          });
      } catch (error) {
        if ((error as { code?: string }).code === "workspace_policy_conflict")
          throw new ApiError(
            409,
            "workspace_policy_conflict",
            "Settings changed. Compare or reload before saving.",
          );
        throw error;
      }
      return jsonResponse(200, { ok: true, ...settingsView(profile) });
    });
  };
}

export const POST = createSettingsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

type SettingsGetRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createSettingsGetHandler(deps: SettingsGetRouteDeps) {
  return async function settingsGetHandler(
    _request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Admin access is required.",
        );
      }
      const profile = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.workspaces.requireProfile(),
        );
      return jsonResponse(200, settingsView(profile));
    });
  };
}

export const GET = createSettingsGetHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

function settingsView(profile: WorkspaceProfile) {
  return {
    brandBackgroundColor: profile.brandBackgroundColor,
    digest: createHash("sha256")
      .update(JSON.stringify(workspaceProfileSchema.parse(profile)))
      .digest("hex"),
  };
}
