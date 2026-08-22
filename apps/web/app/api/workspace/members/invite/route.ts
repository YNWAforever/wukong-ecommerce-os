import { z } from "zod";

import { MembershipGuardViolation } from "@wukong/db";

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

const bodySchema = z
  .object({
    email: z.email(),
    role: z.enum(["viewer", "operator", "reviewer", "admin"]),
  })
  .strict();

type InviteRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createMemberInviteHandler(deps: InviteRouteDeps) {
  return async function memberInviteHandler(
    request: Request,
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
      const parsed = bodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Invalid invite payload.");
      }
      try {
        const invite = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const created = await repositories.memberships.createInvite(
              parsed.data.email,
              parsed.data.role,
            );
            await repositories.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: created.id,
              action: "workspace.member_invited",
              metadata: { email: created.email, role: created.role },
            });
            return created;
          });
        return jsonResponse(200, invite);
      } catch (error) {
        if (error instanceof MembershipGuardViolation) {
          throw new ApiError(409, error.reason, error.message);
        }
        throw error;
      }
    });
  };
}

export const POST = createMemberInviteHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
