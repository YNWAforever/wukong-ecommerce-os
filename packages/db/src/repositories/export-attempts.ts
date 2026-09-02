import { isDeepStrictEqual } from "node:util";

import { and, desc, eq, sql } from "drizzle-orm";

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
  // Always omit this key entirely when there is no reason -- never set it to
  // `undefined` explicitly. jsonb silently drops `undefined`-valued keys on
  // write, so a manifest built with `reason: undefined` would read back
  // without the key at all, which would then read as a false mismatch
  // against an input that omitted it from the start.
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

export type EnsuredExportAttempt = ExportAttempt & {
  /**
   * `true` exactly when this call's own INSERT won the race (a genuinely new
   * attempt) -- `false` when it found an existing row under the same
   * idempotency key (a pure repeat/double-click). Callers that write a
   * side effect keyed off "this export attempt happened" (an audit event,
   * a notification, ...) must gate on this, or a harmless repeat request
   * duplicates that side effect. Mirrors how `deliverListing`'s publish path
   * branches on `publishJobs.ensure()`'s returned job status before writing
   * its own audit event (`apps/web/lib/delivery-service.ts`).
   */
  wasCreated: boolean;
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
   * stored under this key against the input's `manifest`, entry by entry
   * (order-independent -- both sides are sorted by `listingId:versionId`
   * before comparing, since the key is itself derived from the sorted
   * listing/version set and two calls with the same set in a different
   * array order are the same request by the key's own definition). If the
   * stored manifest disagrees with the input once order is normalized,
   * something in the caller's key construction missed an input that
   * matters, and this throws instead of quietly handing back stale data
   * from an unrelated request.
   *
   * `rowCount` and `specVersion` are checked too, and deliberately not
   * dropped as "redundant" with the manifest check: `rowCount` is computed
   * by the caller through a separate code path (a count of changed
   * spreadsheet columns, not a tally of the manifest's `included` entries),
   * so a caller bug that produces a correct manifest but a wrong `rowCount`
   * would only be caught here, not by comparing manifests. This is
   * defense-in-depth across independently-computed fields, not one check
   * standing in for another.
   */
  ensure(input: EnsureExportAttemptInput): Promise<EnsuredExportAttempt>;
  getById(id: string): Promise<ExportAttempt | null>;
  /** Newest-first, this workspace's export attempts only. `limit` defaults
   * to 100 and must be between 1 and 100. */
  listForWorkspace(limit?: number): Promise<ExportAttempt[]>;
  /** Every export attempt whose manifest contains an entry for this listing,
   * newest first. Uses a jsonb containment check since `manifest` carries no
   * foreign key to listings (see the type comment above). `limit` defaults
   * to 100 and must be between 1 and 100. */
  listContainingListing(
    listingId: string,
    limit?: number,
  ): Promise<
    Array<{
      id: string;
      outcome: ExportManifestOutcome;
      reason?: string;
      createdAt: Date;
    }>
  >;
};

// Mirrors the listingId:versionId normalization the idempotency key itself
// is derived from (sha256 of the sorted "listingId:versionId" pair set), so
// a repeat call whose manifest entries arrive in a different array order --
// e.g. reconstructed from a Set/Map, or from a UI re-render -- compares
// equal instead of being mistaken for a genuine key collision.
const manifestSortKey = (entry: ExportManifestEntry): string =>
  `${entry.listingId}:${entry.versionId ?? "null"}`;

const sortedManifest = (
  manifest: ExportManifestEntry[],
): ExportManifestEntry[] =>
  [...manifest].sort((a, b) =>
    manifestSortKey(a).localeCompare(manifestSortKey(b)),
  );

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
      // `.returning()` on an `onConflictDoNothing()` insert yields a row
      // only when THIS call's insert actually won -- a conflicting repeat
      // gets back an empty array, not the existing row. That is what lets
      // `wasCreated` distinguish "freshly inserted" from "found existing"
      // without a second round trip beyond the fallback select below.
      const [insertedRow] = await transaction
        .insert(exportAttempts)
        .values({
          workspaceId,
          idempotencyKey: input.idempotencyKey,
          requestedBy: input.requestedBy,
          manifest: input.manifest,
          rowCount: input.rowCount,
          specVersion: input.specVersion,
        })
        .onConflictDoNothing()
        .returning(COLUMNS);
      const wasCreated = insertedRow !== undefined;
      const row = insertedRow ?? (await selectByKey(input.idempotencyKey));
      if (!row) throw new Error("export attempt insert did not return a row");
      if (
        row.rowCount !== input.rowCount ||
        row.specVersion !== input.specVersion ||
        !isDeepStrictEqual(
          sortedManifest(row.manifest),
          sortedManifest(input.manifest),
        )
      ) {
        throw new Error(
          "export attempt idempotency key does not match the stored row",
        );
      }
      return { ...row, wasCreated };
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

    async listContainingListing(listingId, limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("export attempt limit must be between 1 and 100");
      }
      const containment = JSON.stringify([{ listingId }]);
      const rows = await transaction
        .select({
          id: exportAttempts.id,
          manifest: exportAttempts.manifest,
          createdAt: exportAttempts.createdAt,
        })
        .from(exportAttempts)
        .where(
          and(
            eq(exportAttempts.workspaceId, workspaceId),
            sql`${exportAttempts.manifest} @> ${containment}::jsonb`,
          ),
        )
        // Rows created within one shared `db.forWorkspace` transaction share
        // Postgres's per-transaction `now()`, so `created_at` alone can tie --
        // `id` breaks the tie deterministically instead of leaving same-instant
        // rows in an arbitrary order.
        .orderBy(desc(exportAttempts.createdAt), desc(exportAttempts.id))
        .limit(limit);
      return rows.map((row) => {
        const entry = row.manifest.find((item) => item.listingId === listingId);
        return {
          id: row.id,
          outcome: entry?.outcome ?? "listing_not_found",
          reason: entry?.reason,
          createdAt: row.createdAt,
        };
      });
    },

    async listForWorkspace(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("export attempt limit must be between 1 and 100");
      }
      const rows = await transaction
        .select(COLUMNS)
        .from(exportAttempts)
        .where(eq(exportAttempts.workspaceId, workspaceId))
        // Rows created within one shared `db.forWorkspace` transaction share
        // Postgres's per-transaction `now()`, so `created_at` alone can tie --
        // `id` breaks the tie deterministically instead of leaving same-instant
        // rows in an arbitrary order.
        .orderBy(desc(exportAttempts.createdAt), desc(exportAttempts.id))
        .limit(limit);
      return rows;
    },
  };
}
