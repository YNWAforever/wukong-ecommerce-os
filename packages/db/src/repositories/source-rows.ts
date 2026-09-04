import { and, eq } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { sourceRowSnapshots } from "../schema.js";

export type SourceRowSnapshot = typeof sourceRowSnapshots.$inferSelect;
export type CreateSourceRowInput = Omit<
  SourceRowSnapshot,
  "id" | "workspaceId" | "createdAt"
>;
export type SourceRowRepository = {
  createMany(
    inputs: readonly CreateSourceRowInput[],
  ): Promise<SourceRowSnapshot[]>;
  getForProduct(input: {
    sourceImportId: string;
    connectionId: string;
    remoteProductId: string;
  }): Promise<SourceRowSnapshot | null>;
};
export function createSourceRowRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): SourceRowRepository {
  return {
    async createMany(inputs) {
      scope.assertOpen();
      if (inputs.length === 0) return [];
      // Immutable: a repeated import identity cannot replace its source evidence.
      return transaction
        .insert(sourceRowSnapshots)
        .values(inputs.map((input) => ({ ...input, workspaceId })))
        .returning();
    },
    async getForProduct(input) {
      scope.assertOpen();
      const [row] = await transaction
        .select()
        .from(sourceRowSnapshots)
        .where(
          and(
            eq(sourceRowSnapshots.workspaceId, workspaceId),
            eq(sourceRowSnapshots.sourceImportId, input.sourceImportId),
            eq(sourceRowSnapshots.connectionId, input.connectionId),
            eq(sourceRowSnapshots.remoteProductId, input.remoteProductId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
