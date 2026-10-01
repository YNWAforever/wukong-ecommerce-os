import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { createAuditWriter } from "./audit.js";

export type AssignmentRole =
  "viewer" | "operator" | "reviewer" | "admin" | "owner";
export type AssignmentMember = {
  userId: string;
  email: string;
  name: string | null;
  role: AssignmentRole;
};
export type ListingAssignment = {
  listingId: string;
  assigneeUserId: string | null;
  assignmentRevision: number;
  assigneeActive: boolean;
  assigneeEmail: string | null;
};
export type AssignmentOutcome =
  | "assigned"
  | "listing_not_found"
  | "target_not_active"
  | "insufficient_role"
  | "assignment_owned"
  | "revision_conflict"
  | "idempotency_conflict";
export type AssignmentResult = {
  listingId: string;
  outcome: AssignmentOutcome;
  assigneeUserId: string | null;
  assignmentRevision: number;
  replayed: boolean;
};
export type ApplyAssignmentInput = {
  actorId: string;
  listingId: string;
  assigneeUserId: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  action: "assign" | "claim" | "handoff";
};
export type ListingAssignmentRepository = {
  listActiveMembers(): Promise<AssignmentMember[]>;
  getMany(listingIds: readonly string[]): Promise<ListingAssignment[]>;
  apply(input: ApplyAssignmentInput): Promise<AssignmentResult>;
};
const rank: Record<string, number> = {
  viewer: 10,
  operator: 20,
  reviewer: 30,
  admin: 40,
  owner: 50,
};

export function createListingAssignmentRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ListingAssignmentRepository {
  return {
    async listActiveMembers() {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select m.user_id,u.email,u.name,m.role from memberships m join users u on u.id=m.user_id where m.workspace_id=${workspaceId} order by u.email,m.user_id`,
      );
      return rows.map((row) => ({
        userId: String(row.user_id),
        email: String(row.email),
        name: row.name == null ? null : String(row.name),
        role: String(row.role) as AssignmentRole,
      }));
    },
    async getMany(listingIds) {
      scope.assertOpen();
      if (listingIds.length > 100)
        throw new Error("Assignment read is limited to 100 listings");
      if (!listingIds.length) return [];
      const rows =
        await tx.execute(sql`select d.id,a.assignee_user_id,coalesce(a.assignment_revision,0) as assignment_revision,m.user_id as active_assignee,u.email as assignee_email
        from listing_drafts d left join listing_assignments a on a.workspace_id=d.workspace_id and a.listing_id=d.id
        left join memberships m on m.workspace_id=d.workspace_id and m.user_id=a.assignee_user_id and m.role in ('operator','reviewer','admin','owner') left join users u on u.id=m.user_id
        where d.workspace_id=${workspaceId} and d.id in (${sql.join(
          listingIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )}) order by d.id`);
      return rows.map((row) => ({
        listingId: String(row.id),
        assigneeUserId:
          row.assignee_user_id == null ? null : String(row.assignee_user_id),
        assignmentRevision: Number(row.assignment_revision),
        assigneeActive: row.active_assignee != null,
        assigneeEmail:
          row.assignee_email == null ? null : String(row.assignee_email),
      }));
    },
    async apply(input) {
      scope.assertOpen();
      // Same membership ordering as admin removal/role changes; SHARE prevents
      // membership revocation between target validation and this transaction's commit.
      const members = await tx.execute(
        sql`select user_id,role from memberships where workspace_id=${workspaceId} order by user_id for share`,
      );
      const actor = members.find((row) => row.user_id === input.actorId);
      const actorRank = rank[String(actor?.role)] ?? 0;
      const blank = (outcome: AssignmentOutcome): AssignmentResult => ({
        listingId: input.listingId,
        outcome,
        assigneeUserId: null,
        assignmentRevision: 0,
        replayed: false,
      });
      if (
        actorRank < 20 ||
        (input.action === "assign" && actorRank < 30) ||
        (input.action === "claim" && input.assigneeUserId !== input.actorId)
      )
        return blank("insufficient_role");
      const target = members.find(
        (row) => row.user_id === input.assigneeUserId,
      );
      if (
        (input.assigneeUserId !== null && !target) ||
        (target &&
          (rank[String(target.role)] ?? 0) <
            (input.action === "handoff" ? 30 : 20)) ||
        (input.assigneeUserId === null && input.action !== "assign")
      )
        return blank("target_not_active");
      const listings = await tx.execute(
        sql`select id from listing_drafts where workspace_id=${workspaceId} and id=${input.listingId}::uuid for update`,
      );
      if (!listings.length) return blank("listing_not_found");
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            input.action,
            input.assigneeUserId,
            input.expectedRevision,
          ]),
        )
        .digest("hex");
      const receipt = await tx.execute(
        sql`select request_digest,result from listing_assignment_requests where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid and actor_id=${input.actorId} and request_key=${input.idempotencyKey}::uuid`,
      );
      if (receipt[0]) {
        if (receipt[0].request_digest !== digest)
          return blank("idempotency_conflict");
        return { ...(receipt[0].result as AssignmentResult), replayed: true };
      }
      const rows = await tx.execute(
        sql`select assignee_user_id,assignment_revision from listing_assignments where workspace_id=${workspaceId} and listing_id=${input.listingId}::uuid`,
      );
      const currentUser =
        rows[0]?.assignee_user_id == null
          ? null
          : String(rows[0].assignee_user_id);
      const currentOwner = members.find((row) => row.user_id === currentUser);
      const currentOwnerActive = (rank[String(currentOwner?.role)] ?? 0) >= 20;
      const revision = Number(rows[0]?.assignment_revision ?? 0);
      const result: AssignmentResult = {
        listingId: input.listingId,
        outcome: "assigned",
        assigneeUserId: currentUser,
        assignmentRevision: revision,
        replayed: false,
      };
      if (revision !== input.expectedRevision)
        result.outcome = "revision_conflict";
      else if (
        (input.action === "claim" &&
          currentUser !== null &&
          currentUser !== input.actorId &&
          currentOwnerActive) ||
        (actorRank < 30 &&
          input.action === "handoff" &&
          currentUser !== input.actorId)
      )
        result.outcome = "assignment_owned";
      else if (currentUser !== input.assigneeUserId) {
        const next = revision + 1;
        await tx.execute(sql`insert into listing_assignments(workspace_id,listing_id,assignee_user_id,assignment_revision) values (${workspaceId},${input.listingId}::uuid,${input.assigneeUserId},${next})
          on conflict(workspace_id,listing_id) do update set assignee_user_id=excluded.assignee_user_id,assignment_revision=excluded.assignment_revision,updated_at=now()
          where listing_assignments.assignment_revision=${input.expectedRevision}`);
        result.assigneeUserId = input.assigneeUserId;
        result.assignmentRevision = next;
        await createAuditWriter(tx, workspaceId, scope).write({
          workspaceId,
          actorId: input.actorId,
          entityId: input.listingId,
          action: "listing.assigned",
          metadata: {
            assigneeUserId: input.assigneeUserId,
            previousAssigneeUserId: currentUser,
            assignmentRevision: next,
            assignmentAction: input.action,
            requestKey: input.idempotencyKey,
          },
        });
      }
      await tx.execute(
        sql`insert into listing_assignment_requests(workspace_id,listing_id,actor_id,request_key,request_digest,result) values (${workspaceId},${input.listingId}::uuid,${input.actorId},${input.idempotencyKey}::uuid,${digest},${JSON.stringify(result)}::jsonb)`,
      );
      return result;
    },
  };
}
