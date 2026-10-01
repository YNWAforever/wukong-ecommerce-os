import { z } from "zod";
import type { AssignmentResult, ListingAssignmentRepository } from "@wukong/db";
import type { SessionContext } from "./session-context-port";
import { ApiError } from "./route-support";
import { requireWorkspaceRole } from "./session-context";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const assignmentItemSchema = z
  .object({
    listingId: uuid,
    assigneeUserId: z.string().min(1).max(200).nullable(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: uuid,
    action: z.enum(["assign", "claim", "handoff"]),
  })
  .strict();
export const assignmentBulkSchema = z
  .object({
    items: z
      .array(assignmentItemSchema)
      .min(1)
      .max(100)
      .refine(
        (items) =>
          new Set(items.map((item) => item.listingId)).size === items.length,
        "Listing IDs must be unique",
      ),
  })
  .strict();
export type AssignmentItemInput = z.infer<typeof assignmentItemSchema>;

export async function assignListingItems(
  repository: ListingAssignmentRepository,
  context: SessionContext,
  items: AssignmentItemInput[],
) {
  if (
    !requireWorkspaceRole("operator", context.role) ||
    items.some(
      (item) =>
        item.action === "assign" &&
        !requireWorkspaceRole("reviewer", context.role),
    ) ||
    items.some(
      (item) =>
        item.action === "claim" && item.assigneeUserId !== context.actorId,
    )
  )
    throw new ApiError(
      403,
      "insufficient_role",
      "You may claim your own work or hand your work to a reviewer.",
    );
  const byListing = new Map<string, AssignmentResult>();
  // Per-item business conflicts are returned. Infrastructure failures still
  // fail the request so they cannot masquerade as a healthy bulk result.
  // All overlapping requests acquire listing locks in the same order.
  for (const item of [...items].sort((a, b) =>
    a.listingId.localeCompare(b.listingId),
  ))
    byListing.set(
      item.listingId,
      await repository.apply({ ...item, actorId: context.actorId }),
    );
  const results = items.map((item) => byListing.get(item.listingId)!);
  const assigned = results.filter(
    (result) => result.outcome === "assigned",
  ).length;
  return { results, assigned, failed: results.length - assigned };
}
