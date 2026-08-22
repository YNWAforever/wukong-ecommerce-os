import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { memberships, users, workspaceInvites } from "../schema.js";

export type AssignableWorkspaceRole =
  "viewer" | "operator" | "reviewer" | "admin";

export type WorkspaceMember = {
  userId: string;
  email: string;
  role: AssignableWorkspaceRole | "owner";
  createdAt: Date;
};

export type WorkspaceInvite = {
  id: string;
  email: string;
  role: AssignableWorkspaceRole;
  createdAt: Date;
};

export class MembershipGuardViolation extends Error {
  constructor(
    readonly reason:
      "self_action" | "last_admin" | "owner_immutable" | "already_member",
  ) {
    super(
      reason === "self_action"
        ? "You cannot change or remove your own membership."
        : reason === "last_admin"
          ? "A workspace must keep at least one admin or owner."
          : reason === "owner_immutable"
            ? "The workspace owner's role is not managed here."
            : "This email is already an active member of the workspace.",
    );
    this.name = "MembershipGuardViolation";
  }
}

export type MembershipRepository = {
  listForWorkspace(): Promise<WorkspaceMember[]>;
  listInvites(): Promise<WorkspaceInvite[]>;
  createInvite(
    email: string,
    role: AssignableWorkspaceRole,
  ): Promise<WorkspaceInvite>;
  revokeInvite(inviteId: string): Promise<void>;
  updateRole(
    actingUserId: string,
    targetUserId: string,
    role: AssignableWorkspaceRole,
  ): Promise<void>;
  remove(actingUserId: string, targetUserId: string): Promise<void>;
};

const ADMIN_TIER_ROLES = new Set(["admin", "owner"]);

// `memberships.role` is `text` at the Drizzle-column level; only the runtime
// CHECK constraint narrows it, so these internal helpers work with the raw
// `string` the query returns and leave casting to the public return
// boundary (see `listForWorkspace`/`listInvites`/`createInvite` above).
//
// `updateRole`/`remove` guard a hard invariant -- a workspace must never end
// up with zero admin-tier members -- by checking the target's role and
// counting the other admin-tier members before deciding whether to allow
// the UPDATE/DELETE. Under READ COMMITTED with no row locking this is a
// classic check-then-act race: two concurrent calls (e.g. removing each of
// the workspace's two remaining admins) can each read the *other* admin as
// still present before either commits, both pass the guard, and both
// proceed -- leaving zero admins.
//
// `lockMembershipRows` closes that race with `SELECT ... FOR UPDATE` over
// every membership row in the workspace, taken once per guarded call and
// reused for both the target lookup and the admin-tier count -- a single
// locked snapshot rather than two separately-unlocked (and potentially
// inconsistent) reads. Locking the whole row set in one query -- rather
// than locking rows one at a time in a per-call-dependent order -- avoids
// introducing a new deadlock risk: both `updateRole` and `remove` issue the
// *same* query shape (same table, same `workspace_id` filter), so Postgres
// scans and locks the rows in the same order for every concurrent caller.
// The second caller to reach a given row simply blocks until the first
// caller's transaction ends, rather than two callers each holding one row
// and waiting on the other's.
async function lockMembershipRows(
  transaction: WorkspaceTransaction,
  workspaceId: string,
): Promise<{ userId: string; role: string }[]> {
  return transaction
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
    .for("update");
}

function findTargetMembership(
  rows: { userId: string; role: string }[],
  targetUserId: string,
): { role: string } {
  const target = rows.find((row) => row.userId === targetUserId);
  if (!target) throw new Error("membership not found");
  return target;
}

function activeAdminTierCountExcluding(
  rows: { userId: string; role: string }[],
  excludingUserId: string,
): number {
  return rows.filter(
    (row) => ADMIN_TIER_ROLES.has(row.role) && row.userId !== excludingUserId,
  ).length;
}

export function createMembershipRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): MembershipRepository {
  return {
    async listForWorkspace() {
      scope.assertOpen();
      const rows = await transaction
        .select({
          userId: memberships.userId,
          email: users.email,
          role: memberships.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.workspaceId, workspaceId))
        .orderBy(memberships.createdAt);
      // `memberships.role` is `text` at the Drizzle-column level; only the
      // runtime CHECK constraint narrows it, so the cast happens here, once,
      // at the query boundary.
      return rows.map((row) => ({
        ...row,
        role: row.role as AssignableWorkspaceRole | "owner",
      }));
    },

    async listInvites() {
      scope.assertOpen();
      const rows = await transaction
        .select({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
        })
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            eq(workspaceInvites.status, "pending"),
          ),
        )
        .orderBy(workspaceInvites.createdAt);
      return rows.map((row) => ({
        ...row,
        role: row.role as AssignableWorkspaceRole,
      }));
    },

    async createInvite(email, role) {
      scope.assertOpen();
      const normalizedEmail = email.trim().toLowerCase();
      const [existingMember] = await transaction
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            sql`lower(${users.email}) = ${normalizedEmail}`,
          ),
        )
        .limit(1);
      if (existingMember) throw new MembershipGuardViolation("already_member");

      const [invite] = await transaction
        .insert(workspaceInvites)
        .values({
          workspaceId,
          email: normalizedEmail,
          role,
          status: "pending",
        })
        .onConflictDoUpdate({
          target: [workspaceInvites.workspaceId, workspaceInvites.email],
          set: { role, status: "pending", createdAt: sql`now()` },
        })
        .returning({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
        });
      if (!invite) throw new Error("failed to create invite");
      return { ...invite, role: invite.role as AssignableWorkspaceRole };
    },

    async revokeInvite(inviteId) {
      scope.assertOpen();
      await transaction
        .delete(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            eq(workspaceInvites.id, inviteId),
          ),
        );
    },

    async updateRole(actingUserId, targetUserId, role) {
      scope.assertOpen();
      if (targetUserId === actingUserId) {
        throw new MembershipGuardViolation("self_action");
      }
      const rows = await lockMembershipRows(transaction, workspaceId);
      const target = findTargetMembership(rows, targetUserId);
      if (target.role === "owner") {
        throw new MembershipGuardViolation("owner_immutable");
      }
      if (ADMIN_TIER_ROLES.has(target.role) && !ADMIN_TIER_ROLES.has(role)) {
        const remaining = activeAdminTierCountExcluding(rows, targetUserId);
        if (remaining === 0) throw new MembershipGuardViolation("last_admin");
      }
      await transaction
        .update(memberships)
        .set({ role })
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, targetUserId),
          ),
        );
    },

    async remove(actingUserId, targetUserId) {
      scope.assertOpen();
      if (targetUserId === actingUserId) {
        throw new MembershipGuardViolation("self_action");
      }
      const rows = await lockMembershipRows(transaction, workspaceId);
      const target = findTargetMembership(rows, targetUserId);
      if (target.role === "owner") {
        throw new MembershipGuardViolation("owner_immutable");
      }
      if (ADMIN_TIER_ROLES.has(target.role)) {
        const remaining = activeAdminTierCountExcluding(rows, targetUserId);
        if (remaining === 0) throw new MembershipGuardViolation("last_admin");
      }
      await transaction
        .delete(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, targetUserId),
          ),
        );
    },
  };
}
