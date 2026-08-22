import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ inviteId: string }> };
type InviteRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createInviteRevokeHandler(deps: InviteRouteDeps) {
  return async function inviteRevokeHandler(
    _request: Request,
    context: RouteContext,
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
      const { inviteId } = await context.params;
      await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          await repositories.memberships.revokeInvite(inviteId);
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: inviteId,
            action: "workspace.invite_revoked",
            metadata: {},
          });
        });
      return jsonResponse(200, { ok: true });
    });
  };
}

export const DELETE = createInviteRevokeHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
