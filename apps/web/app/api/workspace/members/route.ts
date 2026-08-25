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

type MembersListRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createMembersListHandler(deps: MembersListRouteDeps) {
  return async function membersListHandler(
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
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const [members, invites] = await Promise.all([
            repositories.memberships.listForWorkspace(),
            repositories.memberships.listInvites(),
          ]);
          return { members, invites };
        });
      return jsonResponse(200, result);
    });
  };
}

export const GET = createMembersListHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
