import { sql } from "drizzle-orm";


import {
  SessionContextUnavailableError,
  type SessionContext,
  type SessionContextPort,
} from "./session-context-port";

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

export type AuthSession = {
  user?: { id?: string | null } | null;
} | null;

export type AuthSessionContextOptions = {
  resolveAuth?: () => Promise<AuthSession>;
  membershipLookup?: (userId: string) => Promise<MembershipRecord | null>;
};

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

/**
 * Production session context: Auth.js establishes identity, then a
 * security-definer database function resolves the first active membership.
 * No workspace or actor value is accepted from request JSON.
 */
export function createAuthSessionContextPort(
  options: AuthSessionContextOptions = {},
): SessionContextPort {
  const resolveAuth = options.resolveAuth ?? (async () => {
    if (
      !process.env.AUTH_SMTP_URL ||
      !process.env.AUTH_EMAIL_FROM ||
      !process.env.AUTH_SECRET ||
      !process.env.DATABASE_URL
    ) {
      throw new SessionContextUnavailableError();
    }
    try {
      const { auth } = await import("../auth");
      return (await auth()) as AuthSession;
    } catch (error) {
      if (error instanceof Error && error.name === "AuthConfigurationUnavailableError") {
        throw new SessionContextUnavailableError();
      }
      throw error;
    }
  });
  const membershipLookup = options.membershipLookup ?? (async (userId: string) => {
    const { getAuthDatabase } = await import("../auth");
    const rows = await getAuthDatabase().execute<{
      workspace_id: string;
      actor_id: string;
      role: string;
    }>(sql`select workspace_id, actor_id, role from auth_get_active_membership(${userId})`);
    const row = rows[0];
    if (!row || !(row.role in roleOrder)) return null;
    return {
      workspaceId: row.workspace_id,
      actorId: row.actor_id,
      role: row.role as WorkspaceRole,
    };
  });

  return {
    async resolve() {
      const session = await resolveAuth();
      const userId = session?.user?.id;
      if (!userId) return null;
      return membershipLookup(userId);
    },
  };
}

export const authSessionContext = createAuthSessionContextPort();

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
