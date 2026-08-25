import { z } from "zod";

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

type RouteContext = { params: Promise<{ userId: string }> };
type MemberRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

const roleBodySchema = z
  .object({ role: z.enum(["viewer", "operator", "reviewer", "admin"]) })
  .strict();

async function requireAdmin(deps: MemberRouteDeps) {
  const session = await requireSessionContext(deps.sessionContext);
  if (!requireWorkspaceRole("admin", session.role)) {
    throw new ApiError(403, "insufficient_role", "Admin access is required.");
  }
  return session;
}

async function handleRoleChange(
  deps: MemberRouteDeps,
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const session = await requireAdmin(deps);
  const { userId } = await context.params;
  const parsed = roleBodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new ApiError(400, "invalid_body", "Invalid role payload.");
  }
  await deps
    .getDatabase()
    .forWorkspace(session.workspaceId, async (repositories) => {
      await repositories.memberships.updateRole(
        session.actorId,
        userId,
        parsed.data.role,
      );
      await repositories.audit.write({
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: userId,
        action: "workspace.member_role_changed",
        metadata: { role: parsed.data.role },
      });
    });
  return jsonResponse(200, { ok: true });
}

async function handleRemove(
  deps: MemberRouteDeps,
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const session = await requireAdmin(deps);
  const { userId } = await context.params;
  await deps
    .getDatabase()
    .forWorkspace(session.workspaceId, async (repositories) => {
      await repositories.memberships.remove(session.actorId, userId);
      await repositories.audit.write({
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: userId,
        action: "workspace.member_removed",
        metadata: {},
      });
    });
  return jsonResponse(200, { ok: true });
}

export function createMemberHandler(deps: MemberRouteDeps) {
  return function memberHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      if (request.method === "PATCH") {
        return handleRoleChange(deps, request, context);
      }
      if (request.method === "DELETE") {
        return handleRemove(deps, request, context);
      }
      throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    });
  };
}

const memberHandler = createMemberHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const PATCH = memberHandler;
export const DELETE = memberHandler;
