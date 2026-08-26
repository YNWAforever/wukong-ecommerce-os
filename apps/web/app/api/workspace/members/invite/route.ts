import { z } from "zod";

import {
  createRuntimeAuthFlow,
  type AuthFlow,
} from "../../../../../lib/auth-flow";
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
  requestEnrollment: AuthFlow["requestEnrollment"];
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
      // Best-effort: the invite row is the source of truth and has already
      // committed. A failure to send the enrollment email (SMTP down, a
      // future bug in requestEnrollment) must not turn a real invite into
      // an error response -- the admin can always re-invite the same email
      // to resend, since createInvite upserts by (workspaceId, email).
      try {
        await deps.requestEnrollment({ email: invite.email });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "member_invite_enrollment_email_failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
      return jsonResponse(200, invite);
    });
  };
}

export const POST = createMemberInviteHandler({
  sessionContext: authSessionContext,
  getDatabase,
  // Constructed lazily, once per call, not at module scope: building the
  // runtime auth flow reads the auth environment and throws if it's
  // unconfigured (see withRuntimeAuthFlow in lib/auth-route.ts for the same
  // reasoning) -- evaluating it at import time would crash the whole route
  // module instead of just this one request.
  requestEnrollment: (input) =>
    createRuntimeAuthFlow().requestEnrollment(input),
});
