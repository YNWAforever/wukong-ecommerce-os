import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";

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
  findActiveByUserId(
    userId: string,
    workspaceId?: string | null,
  ): Promise<MembershipRecord | null>;
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
 * Production session context: Better Auth establishes identity, then a
 * security-definer database function resolves the first active membership.
 * No workspace or actor value is accepted from request JSON.
 */
export function createAuthSessionContextPort(
  options: AuthSessionContextOptions = {},
): SessionContextPort {
  const resolveAuth =
    options.resolveAuth ??
    (async () => {
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
        return (await auth.api.getSession({
          headers: await headers(),
        })) as AuthSession;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AuthConfigurationUnavailableError"
        ) {
          throw new SessionContextUnavailableError();
        }
        throw error;
      }
    });
  const membershipLookup =
    options.membershipLookup ??
    (async (userId: string) => {
      const { getAuthDatabase } = await import("../auth");
      const rows = await getAuthDatabase().execute<{
        workspace_id: string;
        actor_id: string;
        role: string;
      }>(
        sql`select workspace_id, actor_id, role from auth_get_active_membership(${userId})`,
      );
      const row = rows[0];
      if (!row || !(row.role in roleOrder)) return null;
      return {
        workspaceId: row.workspace_id,
        actorId: row.actor_id,
        role: row.role as WorkspaceRole,
      };
    });

  // Wrapped with React's cache() so that multiple `.resolve()` calls within
  // the same request/render pass (e.g. the (app) layout and a page both
  // resolving the session) share one result instead of re-querying the
  // database. React (via Next.js's per-request storage) scopes this cache to
  // a single request's render pass, so it never leaks a session across
  // different requests; it also has no effect inside Route Handlers, which
  // fall outside the React render tree, so behavior there is unchanged.
  const resolveSessionContext = cache(
    async (): Promise<SessionContext | null> => {
      const session = await resolveAuth();
      const userId = session?.user?.id;
      if (!userId) return null;
      return membershipLookup(userId);
    },
  );

  return {
    resolve: resolveSessionContext,
  };
}

export const authSessionContext = createAuthSessionContextPort();

export function requireWorkspaceRole(
  required: WorkspaceRole,
  actual: WorkspaceRole,
): boolean;
export function requireWorkspaceRole(
  required: WorkspaceRole,
): (context: SessionContext) => SessionContext;
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
