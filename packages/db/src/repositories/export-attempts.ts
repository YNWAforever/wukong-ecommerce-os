import { isDeepStrictEqual } from "node:util";

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
  /**
   * `idempotencyKey` must be fully deterministic from everything that
   * affects `manifest` -- every input that can change which listings are
   * included or why one was excluded has to feed the key, or two requests
   * that mean different things collide on the same row and the caller
   * silently gets back whichever one landed first.
   *
   * This method cannot know what the key is derived from, so it cannot
   * detect that kind of collision in general. What it does do is a sanity
   * check on repeat calls: it compares the full `manifest` array already
   * stored under this key against the input's `manifest`, entry by entry.
   * `rowCount` and `specVersion` alone are not enough -- two requests can
   * agree on both while every manifest entry disagrees on *why* a listing
   * was included or excluded (e.g. all excluded as `not_attested` in one
   * request, all excluded as `excluded_no_op` in another, same row count,
   * same spec version). If the stored manifest disagrees with the input,
   * something in the caller's key construction missed an input that
   * matters, and this throws instead of quietly handing back stale data
   * from an unrelated request.
   */
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
      if (
        row.rowCount !== input.rowCount ||
        row.specVersion !== input.specVersion ||
        !isDeepStrictEqual(row.manifest, input.manifest)
      ) {
        throw new Error(
          "export attempt idempotency key does not match the stored row",
        );
      }
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
