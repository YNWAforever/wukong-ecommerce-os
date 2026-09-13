import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { reviewConfirmations } from "../schema.js";

/**
 * What one confirmed field was confirmed against.
 *
 * Digests rather than copies, so no merchant content enters a second table.
 * Each is sha256 hex of a JSON encoding:
 *
 * - `afterDigest` pins the value in the confirmed version.
 * - `before` pins the merchant's cell in the imported row. `null` when the
 *   listing has no imported row or the cell was blank -- a recorded fact that
 *   nothing was supplied, not a missing value.
 * - `evidenceDigest` pins the grounding the AI offered for the field, or `null`
 *   when it offered none. Content, not ids: evidence rows are replaced wholesale
 *   and copied forward under fresh ids, so an id identifies a row rather than
 *   the grounding it carries.
 *
 * Evidence about the confirmed version and its source -- not a transcript of
 * the reviewer's screen, which does not render the merchant's prior value.
 */
export type ReviewFieldRecord = {
  afterDigest: string;
  before: { column: string; digest: string } | null;
  evidenceDigest: string | null;
};

/** Keyed by confirmation field key. See 0027_review_confirmation_field_records.sql. */
export type ReviewFieldRecords = Record<string, ReviewFieldRecord>;

export type UpsertReviewConfirmationInput = {
  listingId: string;
  versionId: string;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  sourceImportId: string | null;
  rowDigest: string | null;
  /**
   * Optional so callers that predate the record keep compiling. Omitted, it is
   * stored as NULL -- including on update, because the record describes the
   * revision it was written with.
   */
  fieldRecords?: ReviewFieldRecords | null;
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
  /**
   * The per-field record for a version's confirmation, or null when there is
   * no confirmation or it was written without one.
   *
   * Deliberately not part of `getByVersionId`: six callers read that shape,
   * `GET /api/listings/[id]` returns it to the browser, and none of them needs
   * this.
   */
  getFieldRecordsByVersionId(
    versionId: string,
  ): Promise<ReviewFieldRecords | null>;
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
      const fieldRecords = input.fieldRecords ?? null;
      const [row] = await transaction
        .insert(reviewConfirmations)
        // workspaceId last: the scoped ID must win even if a caller's object
        // carries one of its own. RLS would reject the write anyway, but the
        // tenancy boundary should not depend on the database catching it.
        .values({ ...input, fieldRecords, workspaceId, revision: 0 })
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
            fieldRecords,
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

    async getFieldRecordsByVersionId(versionId) {
      scope.assertOpen();
      const [row] = await transaction
        .select({ fieldRecords: reviewConfirmations.fieldRecords })
        .from(reviewConfirmations)
        .where(
          and(
            eq(reviewConfirmations.workspaceId, workspaceId),
            eq(reviewConfirmations.versionId, versionId),
          ),
        )
        .limit(1);
      return row?.fieldRecords ?? null;
    },
  };
}
