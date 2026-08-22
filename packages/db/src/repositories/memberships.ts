import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { memberships, users, workspaceInvites } from "../schema.js";

export type AssignableWorkspaceRole = "viewer" | "operator" | "reviewer" | "admin";

export type WorkspaceMember = {
  userId: string;
  email: string;
  role: string;
  createdAt: Date;
};

export type WorkspaceInvite = {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
};

export class MembershipGuardViolation extends Error {
  constructor(
    readonly reason:
      | "self_action"
      | "last_admin"
      | "owner_immutable"
      | "already_member",
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
};

export function createMembershipRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): MembershipRepository {
  return {
    async listForWorkspace() {
      scope.assertOpen();
      return transaction
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
    },

    async listInvites() {
      scope.assertOpen();
      return transaction
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
          set: { role, status: "pending", createdAt: new Date() },
        })
        .returning({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
        });
      if (!invite) throw new Error("failed to create invite");
      return invite;
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
  };
}
