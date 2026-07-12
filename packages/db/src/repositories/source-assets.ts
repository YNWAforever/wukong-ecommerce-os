import { and, eq, inArray, isNull } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { sourceAssets, workspaces } from "../schema.js";

export type SourceAsset = typeof sourceAssets.$inferSelect;

export type CreateSourceAssetInput = {
  storageKey: string;
  kind: string;
  metadata: Record<string, unknown>;
};

export type SourceAssetRepository = {
  create(input: CreateSourceAssetInput): Promise<SourceAsset>;
  getByIds(ids: string[]): Promise<SourceAsset[]>;
  getByStorageKey(storageKey: string): Promise<SourceAsset | null>;
  attachToListing(listingId: string, assetIds: string[]): Promise<void>;
  listForListing(listingId: string): Promise<SourceAsset[]>;
};

export function createSourceAssetRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): SourceAssetRepository {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  return {
    async create(input) {
      scope.assertOpen();
      await transaction
        .insert(workspaces)
        .values({ id: workspaceId, name: workspaceId, profile: {} })
        .onConflictDoNothing();
      const [created] = await transaction
        .insert(sourceAssets)
        .values({
          workspaceId,
          listingId: null,
          storageKey: input.storageKey,
          kind: input.kind,
          metadata: input.metadata,
        })
        .returning();
      if (!created) {
        throw new Error("source asset insert did not return a row");
      }
      return created;
    },

    async getByIds(ids) {
      scope.assertOpen();
      if (ids.length === 0) return [];
      return transaction
        .select()
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            inArray(sourceAssets.id, ids),
          ),
        );
    },

    async getByStorageKey(storageKey) {
      scope.assertOpen();
      const [asset] = await transaction
        .select()
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            eq(sourceAssets.storageKey, storageKey),
          ),
        )
        .limit(1);
      return asset ?? null;
    },

    async listForListing(listingId) {
      scope.assertOpen();
      return transaction.select().from(sourceAssets).where(and(eq(sourceAssets.workspaceId, workspaceId), eq(sourceAssets.listingId, listingId)));
    },

    async attachToListing(listingId, assetIds) {
      scope.assertOpen();
      const uniqueIds = [...new Set(assetIds)];
      if (uniqueIds.length === 0) return;
      const updated = await transaction
        .update(sourceAssets)
        .set({ listingId })
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            inArray(sourceAssets.id, uniqueIds),
            isNull(sourceAssets.listingId),
          ),
        )
        .returning({ id: sourceAssets.id });
      if (updated.length !== uniqueIds.length) {
        throw new Error("One or more source assets are missing or already associated");
      }
    },
  };
}
