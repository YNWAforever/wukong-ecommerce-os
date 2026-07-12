import { and, eq } from "drizzle-orm";

import { listingDrafts, workspaces } from "../schema.js";
import type { WorkspaceTransaction } from "../client.js";

export type Listing = typeof listingDrafts.$inferSelect;

export type CreateListingInput = {
  target: "shopline";
};

export type ListingRepository = {
  create(input: CreateListingInput): Promise<Listing>;
  getById(id: string): Promise<Listing | null>;
};

export function createListingRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
): ListingRepository {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  return {
    async create(input) {
      await transaction
        .insert(workspaces)
        .values({ id: workspaceId, name: workspaceId, profile: {} })
        .onConflictDoNothing();
      const [created] = await transaction
        .insert(listingDrafts)
        .values({ workspaceId, target: input.target })
        .returning();
      if (!created) {
        throw new Error("listing insert did not return a row");
      }
      return created;
    },

    async getById(id) {
      const [listing] = await transaction
        .select()
        .from(listingDrafts)
        .where(
          and(
            eq(listingDrafts.workspaceId, workspaceId),
            eq(listingDrafts.id, id),
          ),
        )
        .limit(1);
      return listing ?? null;
    },
  };
}
