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
  try {
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
  } catch (error) {
    if (error instanceof MembershipGuardViolation) {
      throw new ApiError(409, error.reason, error.message);
    }
    throw error;
  }
  return jsonResponse(200, { ok: true });
}

async function handleRemove(
  deps: MemberRouteDeps,
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const session = await requireAdmin(deps);
  const { userId } = await context.params;
  try {
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
  } catch (error) {
    if (error instanceof MembershipGuardViolation) {
      throw new ApiError(409, error.reason, error.message);
    }
    throw error;
  }
  return jsonResponse(200, { ok: true });
}

export function createMemberHandler(deps: MemberRouteDeps) {
  return function memberHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      if (request.method === "DELETE") {
        return handleRemove(deps, request, context);
      }
      return handleRoleChange(deps, request, context);
    });
  };
}

const memberHandler = createMemberHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const PATCH = memberHandler;
export const DELETE = memberHandler;
