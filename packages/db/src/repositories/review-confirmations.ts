import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { reviewConfirmations } from "../schema.js";

export type UpsertReviewConfirmationInput = {
  listingId: string;
  versionId: string;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  sourceImportId: string | null;
  rowDigest: string | null;
};

export type ReviewConfirmation = {
  id: string;
  listingId: string;
  versionId: string;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  revision: number;
  sourceImportId: string | null;
  rowDigest: string | null;
};

export type ReviewConfirmationRepository = {
  upsert(input: UpsertReviewConfirmationInput): Promise<ReviewConfirmation>;
  getByVersionId(versionId: string): Promise<ReviewConfirmation | null>;
};

const COLUMNS = {
  id: reviewConfirmations.id,
  listingId: reviewConfirmations.listingId,
  versionId: reviewConfirmations.versionId,
  fieldConfirmations: reviewConfirmations.fieldConfirmations,
  negativeConfirmations: reviewConfirmations.negativeConfirmations,
  revision: reviewConfirmations.revision,
  sourceImportId: reviewConfirmations.sourceImportId,
  rowDigest: reviewConfirmations.rowDigest,
};

export function createReviewConfirmationRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ReviewConfirmationRepository {
  return {
    async upsert(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(reviewConfirmations)
        // workspaceId last: the scoped ID must win even if a caller's object
        // carries one of its own. RLS would reject the write anyway, but the
        // tenancy boundary should not depend on the database catching it.
        .values({ ...input, workspaceId, revision: 0 })
        .onConflictDoUpdate({
          target: [
            reviewConfirmations.workspaceId,
            reviewConfirmations.versionId,
          ],
          set: {
            fieldConfirmations: input.fieldConfirmations,
            negativeConfirmations: input.negativeConfirmations,
            sourceImportId: input.sourceImportId,
            rowDigest: input.rowDigest,
            revision: sql`${reviewConfirmations.revision} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning(COLUMNS);
      if (!row)
        throw new Error("review confirmation upsert did not return a row");
      return row;
    },

    async getByVersionId(versionId) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(reviewConfirmations)
        .where(
          and(
            eq(reviewConfirmations.workspaceId, workspaceId),
            eq(reviewConfirmations.versionId, versionId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
