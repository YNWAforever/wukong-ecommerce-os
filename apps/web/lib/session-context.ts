import type { SessionContext } from "./session-context-port";

export type WorkspaceRole = SessionContext["role"];

export type AuthenticatedSession = {
  user?: { id?: string | null; email?: string | null };
  /** Set by the server after membership resolution; never copied from request input. */
  workspaceId?: string | null;
};

export type MembershipRecord = {
  workspaceId: string;
  actorId: string;
  role: WorkspaceRole;
};

export interface MembershipRepository {
  findActiveByUserId(userId: string, workspaceId?: string | null): Promise<MembershipRecord | null>;
}

const roleOrder: Record<WorkspaceRole, number> = {
  viewer: 10,
  operator: 20,
  reviewer: 30,
  admin: 40,
  owner: 50,
};

export async function sessionContext(
  session: AuthenticatedSession | null | undefined,
  memberships: MembershipRepository,
): Promise<SessionContext | null> {
  const userId = session?.user?.id;
  if (!userId) return null;
  const membership = await memberships.findActiveByUserId(userId);
  if (!membership || membership.actorId !== userId) return null;
  return membership;
}

export function requireWorkspaceRole(required: WorkspaceRole, actual: WorkspaceRole): boolean;
export function requireWorkspaceRole(required: WorkspaceRole): (context: SessionContext) => SessionContext;
export function requireWorkspaceRole(
  required: WorkspaceRole,
  actual?: WorkspaceRole,
): boolean | ((context: SessionContext) => SessionContext) {
  if (actual !== undefined) return roleOrder[actual] >= roleOrder[required];
  return (context: SessionContext): SessionContext => {
    if (!requireWorkspaceRole(required, context.role)) {
      throw new Error("insufficient workspace role");
    }
    return context;
  };
}
