import { isDeepStrictEqual } from "node:util";

import { and, desc, eq, sql, ne, isNotNull } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { exportAttempts } from "../schema.js";

export type ExportManifestOutcome =
  | "included"
  | "excluded_no_op"
  | "excluded_stale"
  | "excluded_unapproved"
  | "excluded_blocked"
  | "excluded_unconfirmed"
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

export type ArtifactStatus = "pending" | "ready" | "failed";

export type EnsureExportAttemptInput = {
  provenance?: Record<string, unknown>;
  artifactSha256?: string;
  idempotencyKey: string;
  requestedBy: string;
  manifest: ExportManifestEntry[];
  rowCount: number;
  specVersion: string;
};

export type ExportAttempt = {
  provenance?: Record<string, unknown> | null;
  artifactSha256?: string | null;
  artifactStatus?: ArtifactStatus | null;
  artifactErrorCode?: string | null;
  artifactReadyAt?: Date | null;
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
   * Identity covers canonical manifest, row order, source/approval provenance,
   * header/spec and artifact hash. Conflicts must match every stored input.
   * Omitted provenance/hash is reserved for historical compatibility; production
   * exports always provide both and start pending.
   */
  ensure(input: EnsureExportAttemptInput): Promise<EnsuredExportAttempt>;
  getById(id: string): Promise<ExportAttempt | null>;
  markReady(input: {
    id: string;
    artifactSha256: string;
  }): Promise<ExportAttempt>;
  markFailed(input: {
    id: string;
    artifactSha256: string;
    errorCode: string;
  }): Promise<ExportAttempt>;
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
      artifactStatus?: ArtifactStatus | null;
      provenanceComplete?: boolean;
      createdAt: Date;
    }>
  >;
};

// Normalize legacy manifest membership; new provenance also binds canonical row order.
const manifestSortKey = (entry: ExportManifestEntry): string =>
  `${entry.listingId}:${entry.versionId ?? "null"}`;

const sortedManifest = (
  manifest: ExportManifestEntry[],
): ExportManifestEntry[] =>
  [...manifest].sort((a, b) =>
    manifestSortKey(a).localeCompare(manifestSortKey(b)),
  );

const COLUMNS = {
  provenance: exportAttempts.provenance,
  artifactSha256: exportAttempts.artifactSha256,
  artifactStatus: exportAttempts.artifactStatus,
  artifactErrorCode: exportAttempts.artifactErrorCode,
  artifactReadyAt: exportAttempts.artifactReadyAt,
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

  async function transition(
    input: { id: string; artifactSha256: string; errorCode?: string },
    ready: boolean,
  ): Promise<ExportAttempt> {
    scope.assertOpen();
    const binding = and(
      eq(exportAttempts.workspaceId, workspaceId),
      eq(exportAttempts.id, input.id),
      eq(exportAttempts.artifactSha256, input.artifactSha256),
      isNotNull(exportAttempts.provenance),
    );
    const [updated] = await transaction
      .update(exportAttempts)
      .set(
        ready
          ? {
              artifactStatus: "ready",
              artifactErrorCode: null,
              artifactReadyAt: sql`coalesce(${exportAttempts.artifactReadyAt}, now())`,
            }
          : { artifactStatus: "failed", artifactErrorCode: input.errorCode },
      )
      .where(and(binding, ne(exportAttempts.artifactStatus, "ready")))
      .returning(COLUMNS);
    if (updated) return updated;
    const [existing] = await transaction
      .select(COLUMNS)
      .from(exportAttempts)
      .where(binding)
      .limit(1);
    if (!existing || existing.artifactStatus !== "ready")
      throw new Error(
        "export artifact state does not match the committed identity",
      );
    return existing;
  }

  return {
    async ensure(input) {
      scope.assertOpen();
      if (
        (input.provenance === undefined) !==
          (input.artifactSha256 === undefined) ||
        (input.artifactSha256 !== undefined &&
          !/^[0-9a-f]{64}$/.test(input.artifactSha256))
      )
        throw new Error(
          "export artifact provenance and hash are required together",
        );
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
          provenance: input.provenance ?? null,
          artifactSha256: input.artifactSha256 ?? null,
          artifactStatus: input.provenance ? "pending" : null,
        })
        .onConflictDoNothing()
        .returning(COLUMNS);
      const wasCreated = insertedRow !== undefined;
      const row = insertedRow ?? (await selectByKey(input.idempotencyKey));
      if (!row) throw new Error("export attempt insert did not return a row");
      if (
        row.artifactSha256 !== (input.artifactSha256 ?? null) ||
        !isDeepStrictEqual(row.provenance, input.provenance ?? null) ||
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

    markReady: (input) => transition(input, true),
    markFailed: (input) => transition(input, false),

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
          artifactStatus: exportAttempts.artifactStatus,
          provenance: exportAttempts.provenance,
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
          artifactStatus: row.artifactStatus,
          provenanceComplete: row.provenance !== null,
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
