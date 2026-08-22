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
async function requireTargetMembership(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  targetUserId: string,
): Promise<{ role: string }> {
  const [target] = await transaction
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!target) throw new Error("membership not found");
  return target;
}

async function activeAdminTierCountExcluding(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  excludingUserId: string,
): Promise<number> {
  const rows = await transaction
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId));
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
      const target = await requireTargetMembership(
        transaction,
        workspaceId,
        targetUserId,
      );
      if (target.role === "owner") {
        throw new MembershipGuardViolation("owner_immutable");
      }
      if (ADMIN_TIER_ROLES.has(target.role) && !ADMIN_TIER_ROLES.has(role)) {
        const remaining = await activeAdminTierCountExcluding(
          transaction,
          workspaceId,
          targetUserId,
        );
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
      const target = await requireTargetMembership(
        transaction,
        workspaceId,
        targetUserId,
      );
      if (target.role === "owner") {
        throw new MembershipGuardViolation("owner_immutable");
      }
      if (ADMIN_TIER_ROLES.has(target.role)) {
        const remaining = await activeAdminTierCountExcluding(
          transaction,
          workspaceId,
          targetUserId,
        );
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
