import { and, eq } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { exportAttempts } from "../schema.js";

export type ExportManifestOutcome =
  | "included"
  | "excluded_no_op"
  | "excluded_stale"
  | "not_import_origin"
  | "raw_row_invalid"
  | "listing_not_found";

export type ExportManifestEntry = {
  listingId: string;
  versionId: string | null;
  outcome: ExportManifestOutcome;
  reason?: string;
};

export type EnsureExportAttemptInput = {
  idempotencyKey: string;
  requestedBy: string;
  manifest: ExportManifestEntry[];
  rowCount: number;
  specVersion: string;
};

export type ExportAttempt = {
  id: string;
  requestedBy: string;
  manifest: ExportManifestEntry[];
  rowCount: number;
  specVersion: string;
  createdAt: Date;
};

export type ExportAttemptRepository = {
  ensure(input: EnsureExportAttemptInput): Promise<ExportAttempt>;
  getById(id: string): Promise<ExportAttempt | null>;
};

const COLUMNS = {
  id: exportAttempts.id,
  requestedBy: exportAttempts.requestedBy,
  manifest: exportAttempts.manifest,
  rowCount: exportAttempts.rowCount,
  specVersion: exportAttempts.specVersion,
  createdAt: exportAttempts.createdAt,
};

export function createExportAttemptRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ExportAttemptRepository {
  const byKey = (key: string) =>
    and(
      eq(exportAttempts.workspaceId, workspaceId),
      eq(exportAttempts.idempotencyKey, key),
    );

  const selectByKey = async (key: string) => {
    const [row] = await transaction
      .select(COLUMNS)
      .from(exportAttempts)
      .where(byKey(key))
      .limit(1);
    return row ?? null;
  };

  return {
    async ensure(input) {
      scope.assertOpen();
      await transaction
        .insert(exportAttempts)
        .values({
          workspaceId,
          idempotencyKey: input.idempotencyKey,
          requestedBy: input.requestedBy,
          manifest: input.manifest,
          rowCount: input.rowCount,
          specVersion: input.specVersion,
        })
        .onConflictDoNothing();
      const row = await selectByKey(input.idempotencyKey);
      if (!row) throw new Error("export attempt insert did not return a row");
      return row;
    },

    async getById(id) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(exportAttempts)
        .where(
          and(
            eq(exportAttempts.workspaceId, workspaceId),
            eq(exportAttempts.id, id),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
