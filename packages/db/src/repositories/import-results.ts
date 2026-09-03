import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { importResults } from "../schema.js";

export type ImportResultOutcome = "accepted" | "rejected";

/**
 * `outcome` is a plain `text()` column with only an app-level CHECK
 * constraint, not a Postgres enum, so Drizzle infers bare `string` for it --
 * same shape as `platform_products.origin`. Parse it at the same seam that
 * column is parsed at, rather than casting a wide type away unchecked.
 */
const importResultOutcomeSchema = z.enum(["accepted", "rejected"]);

export type CreateImportResultInput = {
  listingId: string;
  exportAttemptId: string | null;
  outcome: ImportResultOutcome;
  rejectReason: string | null;
  recordedBy: string;
};

export type ImportResult = {
  id: string;
  listingId: string;
  exportAttemptId: string | null;
  outcome: ImportResultOutcome;
  rejectReason: string | null;
  recordedBy: string;
  createdAt: Date;
};

export type ImportResultRepository = {
  create(input: CreateImportResultInput): Promise<ImportResult>;
  /** Newest-first, this workspace's import results only. `limit` defaults to
   * 100 and must be between 1 and 100 -- matches every sibling
   * `listForWorkspace` repository's own bound (export-attempts.ts, etc.). */
  listForWorkspace(limit?: number): Promise<ImportResult[]>;
};

const COLUMNS = {
  id: importResults.id,
  listingId: importResults.listingId,
  exportAttemptId: importResults.exportAttemptId,
  outcome: importResults.outcome,
  rejectReason: importResults.rejectReason,
  recordedBy: importResults.recordedBy,
  createdAt: importResults.createdAt,
};

type ImportResultRow = Omit<ImportResult, "outcome"> & {
  // `outcome` is a plain `text()` column with no `$type` cast, so Drizzle
  // infers `string` for it, not the narrower union.
  outcome: string;
};

const toImportResult = (row: ImportResultRow): ImportResult => ({
  ...row,
  outcome: importResultOutcomeSchema.parse(row.outcome),
});

export function createImportResultRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ImportResultRepository {
  return {
    async create(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(importResults)
        .values({
          workspaceId,
          listingId: input.listingId,
          exportAttemptId: input.exportAttemptId,
          outcome: input.outcome,
          rejectReason: input.rejectReason,
          recordedBy: input.recordedBy,
        })
        .returning(COLUMNS);
      if (!row) throw new Error("import result insert did not return a row");
      return toImportResult(row);
    },

    async listForWorkspace(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("import result limit must be between 1 and 100");
      }
      const rows = await transaction
        .select(COLUMNS)
        .from(importResults)
        .where(eq(importResults.workspaceId, workspaceId))
        .orderBy(desc(importResults.createdAt), desc(importResults.id))
        .limit(limit);
      return rows.map(toImportResult);
    },
  };
}
