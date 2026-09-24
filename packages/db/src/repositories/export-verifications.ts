import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  FRESH_EXPORT_POLICY_VERSION,
  MAX_COMPARISON_EVIDENCE_BYTES,
  type FreshExportComparison,
} from "@wukong/shopline";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { exportVerifications } from "../schema.js";
import { createExportAttemptRepository } from "./export-attempts.js";
import {
  validateExportResultBinding,
  ImportResultConflict,
} from "./import-results.js";
import { createAuditWriter } from "./audit.js";
export type ExportVerificationInput = {
  exportAttemptId: string;
  artifactSha256: string;
  suppliedSha256: string;
  merchantAttestedExportAt: Date;
  connectionId: string;
  policyVersion: typeof FRESH_EXPORT_POLICY_VERSION;
  filename: string;
  recordedBy: string;
  provenance: Record<string, unknown>;
  comparison: FreshExportComparison;
};
export type ExportVerification = ExportVerificationInput & {
  id: string;
  createdAt: Date;
};
export type ExportVerificationSummary = Omit<
  ExportVerification,
  "provenance" | "comparison"
> & { comparison: Pick<FreshExportComparison, "outcome" | "counts"> };
export type ExportVerificationPage = {
  items: ExportVerificationSummary[];
  total: number;
  page: number;
  pageSize: number;
};
export type ExportVerificationRepository = {
  getForAttempt(
    attemptId: string,
    id: string,
  ): Promise<ExportVerification | null>;
  ensure(
    input: ExportVerificationInput,
  ): Promise<ExportVerification & { wasCreated: boolean }>;
  listForAttempt(
    id: string,
    page?: number,
    pageSize?: number,
  ): Promise<ExportVerificationPage>;
};
export function exportVerificationIdentity(
  input: Pick<
    ExportVerificationInput,
    | "exportAttemptId"
    | "artifactSha256"
    | "suppliedSha256"
    | "merchantAttestedExportAt"
    | "connectionId"
  > & { policyVersion: string },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.exportAttemptId,
        input.artifactSha256,
        input.suppliedSha256,
        input.merchantAttestedExportAt.toISOString(),
        input.connectionId,
        input.policyVersion,
      ]),
    )
    .digest("hex");
}
const columns = {
  id: exportVerifications.id,
  exportAttemptId: exportVerifications.exportAttemptId,
  artifactSha256: exportVerifications.artifactSha256,
  suppliedSha256: exportVerifications.suppliedSha256,
  merchantAttestedExportAt: exportVerifications.merchantAttestedExportAt,
  connectionId: exportVerifications.connectionId,
  policyVersion: exportVerifications.policyVersion,
  filename: exportVerifications.filename,
  recordedBy: exportVerifications.recordedBy,
  provenance: exportVerifications.provenance,
  comparison: exportVerifications.comparison,
  createdAt: exportVerifications.createdAt,
};
export function createExportVerificationRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ExportVerificationRepository {
  const workspace = eq(exportVerifications.workspaceId, workspaceId);
  return {
    async ensure(input) {
      scope.assertOpen();
      if (
        !/^[a-f0-9]{64}$/.test(input.suppliedSha256) ||
        input.policyVersion !== FRESH_EXPORT_POLICY_VERSION ||
        input.comparison.policyVersion !== input.policyVersion ||
        !input.filename.trim() ||
        input.filename.length > 255 ||
        /[\/\\\u0000-\u001f\u007f]/.test(input.filename) ||
        !input.recordedBy ||
        !Number.isFinite(input.merchantAttestedExportAt.getTime())
      )
        throw new ImportResultConflict("comparison_input_invalid", 400);
      if (
        Buffer.byteLength(JSON.stringify(input)) + 512 >
        MAX_COMPARISON_EVIDENCE_BYTES
      )
        throw new ImportResultConflict("comparison_input_too_large", 413);
      const attempt = await createExportAttemptRepository(
        transaction,
        workspaceId,
        scope,
      ).getById(input.exportAttemptId);
      if (!attempt)
        throw new ImportResultConflict("export_attempt_not_found", 404);
      const members = attempt.manifest.filter((m) => m.outcome === "included");
      if (!members.length)
        throw new ImportResultConflict("export_provenance_incomplete");
      // Revalidate the whole immutable attempt once at the persistence boundary.
      const member = members[0]!;
      validateExportResultBinding(
        attempt,
        workspaceId,
        member.listingId,
        member.versionId ?? "",
      );
      const evidence = attempt.provenance!.evidence as Array<{
        remoteProductId: string;
        connectionId: string;
      }>;
      if (
        attempt.artifactSha256 !== input.artifactSha256 ||
        !isDeepStrictEqual(attempt.provenance, input.provenance) ||
        !attempt.artifactReadyAt ||
        input.merchantAttestedExportAt <= attempt.artifactReadyAt ||
        evidence.some((e) => e.connectionId !== input.connectionId) ||
        !isDeepStrictEqual(
          evidence.map((e) => e.remoteProductId),
          input.comparison.products.map((p) => p.productId),
        )
      )
        throw new ImportResultConflict("export_verification_binding_mismatch");
      const identityKey = exportVerificationIdentity(input);
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId + ":export-verification:" + identityKey},0))`,
      );
      const [prior] = await transaction
        .select(columns)
        .from(exportVerifications)
        .where(and(workspace, eq(exportVerifications.identityKey, identityKey)))
        .limit(1);
      if (prior) {
        if (
          !isDeepStrictEqual(prior.comparison, input.comparison) ||
          !isDeepStrictEqual(prior.provenance, input.provenance)
        )
          throw new ImportResultConflict("comparison_identity_conflict");
        return { ...prior, wasCreated: false };
      }
      const [created] = await transaction
        .insert(exportVerifications)
        .values({ ...input, workspaceId, identityKey })
        .returning(columns);
      if (!created) throw new Error("verification insert failed");
      await createAuditWriter(transaction, workspaceId, scope).write({
        workspaceId,
        actorId: input.recordedBy,
        entityId: input.exportAttemptId,
        action: "shopline.export_snapshot_compared",
        metadata: {
          verificationId: created.id,
          exportAttemptId: input.exportAttemptId,
          policyVersion: input.policyVersion,
          outcome: input.comparison.outcome,
        },
      });
      return { ...created, wasCreated: true };
    },
    async getForAttempt(attemptId, id) {
      scope.assertOpen();
      const [row] = await transaction
        .select(columns)
        .from(exportVerifications)
        .where(
          and(
            workspace,
            eq(exportVerifications.exportAttemptId, attemptId),
            eq(exportVerifications.id, id),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async listForAttempt(id, page = 1, pageSize = 10) {
      scope.assertOpen();
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 20
      )
        throw new ImportResultConflict("invalid_pagination", 400);
      const where = and(workspace, eq(exportVerifications.exportAttemptId, id));
      // Window count and page read share one statement snapshot, including an empty page.
      const totals = transaction
        .select({ total: sql<number>`count(*)::int`.as("total") })
        .from(exportVerifications)
        .where(where)
        .as("totals");
      const {
        provenance: _provenance,
        comparison: _comparison,
        ...metadata
      } = columns;
      const summaryColumns = {
        ...metadata,
        comparison: sql<
          Pick<FreshExportComparison, "outcome" | "counts">
        >`jsonb_build_object('outcome',${exportVerifications.comparison}->'outcome','counts',${exportVerifications.comparison}->'counts')`.as(
          "comparison_summary",
        ),
      };
      const pageRows = transaction
        .select(summaryColumns)
        .from(exportVerifications)
        .where(where)
        .orderBy(
          desc(exportVerifications.createdAt),
          desc(exportVerifications.id),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .as("page_rows");
      const result = await transaction
        .select({
          total: totals.total,
          item: {
            id: pageRows.id,
            exportAttemptId: pageRows.exportAttemptId,
            artifactSha256: pageRows.artifactSha256,
            suppliedSha256: pageRows.suppliedSha256,
            merchantAttestedExportAt: pageRows.merchantAttestedExportAt,
            connectionId: pageRows.connectionId,
            policyVersion: pageRows.policyVersion,
            filename: pageRows.filename,
            recordedBy: pageRows.recordedBy,
            comparison: pageRows.comparison,
            createdAt: pageRows.createdAt,
          },
        })
        .from(totals)
        .leftJoin(pageRows, sql`true`)
        .orderBy(desc(pageRows.createdAt), desc(pageRows.id));
      return {
        items: result.flatMap((r) => (r.item ? [r.item] : [])),
        total: result[0]?.total ?? 0,
        page,
        pageSize,
      };
    },
  };
}
