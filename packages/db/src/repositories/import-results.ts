import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { importResults, listingDrafts } from "../schema.js";
import {
  createExportAttemptRepository,
  type ExportAttempt,
} from "./export-attempts.js";
export type ImportResultOutcome = "accepted" | "rejected";
export type ImportResultMode =
  "export" | "historical_manual" | "legacy_historical";
export class ImportResultConflict extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
    this.name = "ImportResultConflict";
  }
}
export type CreateImportResultInput = {
  mode: "export" | "historical_manual";
  listingId: string;
  exportAttemptId: string | null;
  versionId?: string | null;
  idempotencyKey: string;
  outcome: ImportResultOutcome;
  rejectReason: string | null;
  recordedBy: string;
  supersedesResultId?: string | null;
  correctionReason?: string | null;
};
export type ImportResult = {
  id: string;
  listingId: string;
  exportAttemptId: string | null;
  outcome: ImportResultOutcome;
  rejectReason: string | null;
  recordedBy: string;
  createdAt: Date;
  mode: ImportResultMode;
  versionId: string | null;
  idempotencyKey: string | null;
  supersedesResultId: string | null;
  correctionReason: string | null;
  revision: number;
};
export type ImportResultRepository = {
  create(
    input: CreateImportResultInput,
  ): Promise<ImportResult & { wasCreated: boolean }>;
  getByIds(ids: readonly string[]): Promise<ImportResult[]>;
  listForWorkspace(limit?: number): Promise<ImportResult[]>;
  listHistoricalForListing(listingId: string): Promise<ImportResult[]>;
  listForExportAttempts(ids: readonly string[]): Promise<ImportResult[]>;
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z.object({
  identityVersion: z.literal(1),
  workspaceId: z.string(),
  freshnessAttested: z.literal(true),
  headerContractSha256: hash,
  specVersion: z.string().min(1),
  rowOrder: z.array(z.string()),
  manifest: z.array(
    z.object({
      listingId: z.string(),
      versionId: z.string().nullable(),
      outcome: z.string(),
      reason: z.string().optional(),
    }),
  ),
  evidence: z.array(
    z.object({
      listingId: z.string(),
      versionId: z.string(),
      approvalReceiptId: z.string().min(1),
      sourceSnapshotId: z.string().min(1),
      confirmationVersionId: z.string().min(1),
      headerContractSha256: hash,
      specVersion: z.string().min(1),
      confirmationRevision: z.number().int().nonnegative(),
      sourceImportId: z.string().min(1),
      rowDigest: hash,
      remoteProductId: z.string().min(1),
      connectionId: z.string().min(1),
    }),
  ),
});
export function validateExportResultBinding(
  attempt: ExportAttempt | null,
  workspaceId: string,
  listingId: string,
  versionId: string,
): void {
  if (!attempt) throw new ImportResultConflict("export_attempt_not_found", 404);
  if (attempt.artifactStatus !== "ready")
    throw new ImportResultConflict("export_artifact_not_ready");
  const parsed = provenanceSchema.safeParse(attempt.provenance);
  const included = attempt.manifest.filter((x) => x.outcome === "included");
  if (!parsed.success || !hash.safeParse(attempt.artifactSha256).success)
    throw new ImportResultConflict("export_provenance_incomplete");
  const p = parsed.data;
  const evidenceByListing = new Map(p.evidence.map((e) => [e.listingId, e]));
  if (
    p.workspaceId !== workspaceId ||
    p.specVersion !== attempt.specVersion ||
    !isDeepStrictEqual(p.manifest, attempt.manifest) ||
    included.length !== attempt.rowCount ||
    new Set(included.map((x) => x.listingId)).size !== included.length ||
    p.evidence.length !== included.length ||
    evidenceByListing.size !== p.evidence.length ||
    !isDeepStrictEqual(
      p.rowOrder,
      p.evidence.map((x) => x.listingId),
    ) ||
    included.some((m) => {
      const e = evidenceByListing.get(m.listingId);
      return (
        !e ||
        e.versionId !== m.versionId ||
        e.specVersion !== p.specVersion ||
        e.headerContractSha256 !== p.headerContractSha256
      );
    })
  )
    throw new ImportResultConflict("export_provenance_incomplete");
  const member = included.find((x) => x.listingId === listingId);
  if (!member) throw new ImportResultConflict("listing_not_in_export");
  if (member.versionId !== versionId)
    throw new ImportResultConflict("export_version_mismatch");
}
const columns = {
  id: importResults.id,
  listingId: importResults.listingId,
  exportAttemptId: importResults.exportAttemptId,
  outcome: importResults.outcome,
  rejectReason: importResults.rejectReason,
  recordedBy: importResults.recordedBy,
  createdAt: importResults.createdAt,
  mode: importResults.mode,
  versionId: importResults.versionId,
  idempotencyKey: importResults.idempotencyKey,
  supersedesResultId: importResults.supersedesResultId,
  correctionReason: importResults.correctionReason,
  revision: importResults.revision,
};
const parse = (
  row:
    | typeof importResults.$inferSelect
    | Omit<typeof importResults.$inferSelect, "workspaceId">,
): ImportResult => ({
  ...row,
  outcome: z.enum(["accepted", "rejected"]).parse(row.outcome),
  mode: z
    .enum(["export", "historical_manual", "legacy_historical"])
    .parse(row.mode),
});
export function createImportResultRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ImportResultRepository {
  const workspace = eq(importResults.workspaceId, workspaceId);
  return {
    async create(input) {
      scope.assertOpen();
      if (
        !["export", "historical_manual"].includes(input.mode) ||
        !input.idempotencyKey?.trim() ||
        input.idempotencyKey.length > 200 ||
        !["accepted", "rejected"].includes(input.outcome) ||
        (input.outcome === "rejected" && !input.rejectReason?.trim()) ||
        (input.outcome === "accepted" && input.rejectReason !== null) ||
        !!input.supersedesResultId !== !!input.correctionReason?.trim()
      )
        throw new ImportResultConflict("invalid_import_result", 400);
      const normalized = {
        mode: input.mode,
        listingId: input.listingId,
        exportAttemptId: input.exportAttemptId,
        versionId: input.versionId ?? null,
        idempotencyKey: input.idempotencyKey,
        outcome: input.outcome,
        rejectReason: input.rejectReason,
        recordedBy: input.recordedBy,
        supersedesResultId: input.supersedesResultId ?? null,
        correctionReason: input.correctionReason ?? null,
      };
      if (
        input.mode === "historical_manual" &&
        (normalized.exportAttemptId !== null || normalized.versionId !== null)
      )
        throw new ImportResultConflict(
          "historical_report_must_be_unlinked",
          400,
        );
      if (
        input.mode === "export" &&
        (!normalized.exportAttemptId || !normalized.versionId)
      )
        throw new ImportResultConflict("export_context_required", 400);
      // Serialize workspace-key retries before the listing lock, including malicious key reuse across listings.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId + ":import-result:" + input.idempotencyKey},0))`,
      );
      const [prior] = await transaction
        .select(columns)
        .from(importResults)
        .where(
          and(
            workspace,
            eq(importResults.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (prior) {
        const same = Object.entries(normalized).every(
          ([key, value]) => prior[key as keyof typeof prior] === value,
        );
        if (!same) throw new ImportResultConflict("idempotency_conflict");
        return { ...parse(prior), wasCreated: false };
      }
      const [listing] = await transaction
        .select({ id: listingDrafts.id })
        .from(listingDrafts)
        .where(
          and(
            eq(listingDrafts.workspaceId, workspaceId),
            eq(listingDrafts.id, input.listingId),
          ),
        )
        .for("update");
      if (!listing) throw new ImportResultConflict("listing_not_found", 404);
      if (input.mode === "export")
        validateExportResultBinding(
          await createExportAttemptRepository(
            transaction,
            workspaceId,
            scope,
          ).getById(normalized.exportAttemptId!),
          workspaceId,
          input.listingId,
          normalized.versionId!,
        );
      const [latest] = await transaction
        .select(columns)
        .from(importResults)
        .where(
          and(
            workspace,
            eq(importResults.listingId, input.listingId),
            eq(importResults.mode, input.mode),
            input.exportAttemptId
              ? eq(importResults.exportAttemptId, input.exportAttemptId)
              : isNull(importResults.exportAttemptId),
          ),
        )
        .orderBy(desc(importResults.revision))
        .limit(1);
      if ((latest?.id ?? null) !== normalized.supersedesResultId)
        throw new ImportResultConflict("stale_import_result");
      const [row] = await transaction
        .insert(importResults)
        .values({
          workspaceId,
          ...normalized,
          revision: (latest?.revision ?? 0) + 1,
        })
        .returning(columns);
      if (!row) throw new Error("import result insert did not return a row");
      return { ...parse(row), wasCreated: true };
    },
    async getByIds(ids) {
      scope.assertOpen();
      if (ids.length === 0) return [];
      if (ids.length > 100) throw new Error("read hydration exceeds page size");
      return (
        await transaction
          .select(columns)
          .from(importResults)
          .where(and(workspace, inArray(importResults.id, [...ids])))
          .orderBy(desc(importResults.createdAt), desc(importResults.id))
          .limit(100)
      ).map(parse);
    },

    async listForWorkspace(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("import result limit must be between 1 and 100");
      return (
        await transaction
          .select(columns)
          .from(importResults)
          .where(workspace)
          .orderBy(desc(importResults.createdAt), desc(importResults.id))
          .limit(limit)
      ).map(parse);
    },
    async listHistoricalForListing(listingId) {
      scope.assertOpen();
      return (
        await transaction
          .select(columns)
          .from(importResults)
          .where(
            and(
              workspace,
              eq(importResults.listingId, listingId),
              eq(importResults.mode, "historical_manual"),
            ),
          )
          .orderBy(desc(importResults.revision))
      ).map(parse);
    },
    async listForExportAttempts(ids) {
      scope.assertOpen();
      if (ids.length === 0) return [];
      return (
        await transaction
          .select(columns)
          .from(importResults)
          .where(
            and(
              workspace,
              eq(importResults.mode, "export"),
              inArray(importResults.exportAttemptId, [...ids]),
            ),
          )
          .orderBy(desc(importResults.revision))
      ).map(parse);
    },
  };
}
