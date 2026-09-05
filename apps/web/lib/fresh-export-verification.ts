import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createExportAssetKey, type AssetStore } from "@wukong/assets";
import {
  ImportResultConflict,
  validateExportResultBinding,
  type Database,
  type ExportAttempt,
  type ExportVerification,
  type ExportVerificationSummary,
} from "@wukong/db";
import {
  compareFreshExport,
  FreshExportComparisonError,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import {
  readBulkFormSheet,
  readBulkFormSheetName,
} from "@wukong/shopline/bulk-form-xlsx";
import { artifactHash } from "./export-artifact";
import { ApiError } from "./route-support";
export const MAX_VERIFICATION_UPLOAD_BYTES = 4 * 1024 * 1024;
export type ExportVerificationWire = Omit<
  ExportVerification,
  "createdAt" | "merchantAttestedExportAt"
> & { createdAt: string; merchantAttestedExportAt: string };
export type ExportVerificationSummaryWire = Omit<
  ExportVerificationSummary,
  "createdAt" | "merchantAttestedExportAt"
> & { createdAt: string; merchantAttestedExportAt: string };
export type ExportVerificationHistoryWire = {
  items: ExportVerificationSummaryWire[];
  total: number;
  page: number;
  pageSize: number;
};
export type RecordExportVerificationWire = {
  verification: ExportVerificationWire;
  replayed: boolean;
};
export type RecordFreshExportInput = {
  workspaceId: string;
  actorId: string;
  exportAttemptId: string;
  filename: string;
  merchantAttestedExportAt: string;
  sameStoreAttested: boolean;
  body: Uint8Array;
};
function failure(code: string, status = 409): never {
  throw new ApiError(
    status,
    code,
    "The snapshot comparison could not be recorded. Check the supplied evidence and retry.",
  );
}
const wire = (record: ExportVerification): ExportVerificationWire => ({
  ...record,
  createdAt: record.createdAt.toISOString(),
  merchantAttestedExportAt: record.merchantAttestedExportAt.toISOString(),
});
function binding(attempt: ExportAttempt | null, workspaceId: string) {
  if (!attempt) failure("export_attempt_not_found", 404);
  const a = attempt!;
  const members = a.manifest.filter((m) => m.outcome === "included");
  if (!members.length) failure("export_provenance_incomplete");
  for (const m of members)
    validateExportResultBinding(a, workspaceId, m.listingId, m.versionId ?? "");
  if (
    !a.artifactReadyAt ||
    !Number.isFinite(a.artifactReadyAt.getTime()) ||
    a.specVersion !== SHOPLINE_BULK_FORM_SPEC_VERSION ||
    a.provenance!.headerContractSha256 !== hashBulkFormHeaderContract()
  )
    failure("export_provenance_incomplete");
  const evidence = a.provenance!.evidence as Array<{
    remoteProductId: string;
    connectionId: string;
  }>;
  const connectionId = evidence[0]!.connectionId;
  if (
    evidence.some((e) => e.connectionId !== connectionId) ||
    new Set(evidence.map((e) => e.remoteProductId)).size !== members.length
  )
    failure("export_provenance_incomplete");
  return {
    attempt: a,
    connectionId,
    productIds: evidence.map((e) => e.remoteProductId),
  };
}
export function createFreshExportVerificationService(deps: {
  getDatabase(): Pick<Database, "forWorkspace">;
  getAssetStore(): Pick<AssetStore, "readObject">;
  now?: () => Date;
}) {
  const db = () => deps.getDatabase();
  return {
    async record(
      input: RecordFreshExportInput,
    ): Promise<RecordExportVerificationWire> {
      try {
        if (!input.sameStoreAttested)
          failure("comparison_same_store_required", 400);
        if (
          !input.filename.trim() ||
          input.filename.length > 255 ||
          /[\/\\\u0000-\u001f\u007f]/.test(input.filename) ||
          !input.filename.toLowerCase().endsWith(".xlsx")
        )
          failure("comparison_filename_invalid", 400);
        if (input.body.byteLength > MAX_VERIFICATION_UPLOAD_BYTES)
          failure("comparison_upload_too_large", 413);
        if (!input.body.byteLength) failure("comparison_workbook_invalid", 400);
        // Zod validates calendar dates as well as explicit UTC/offset syntax; Date alone normalizes impossible dates.
        if (
          !z.iso
            .datetime({ offset: true })
            .safeParse(input.merchantAttestedExportAt).success
        )
          failure("comparison_export_time_invalid", 400);
        const attestedAt = new Date(input.merchantAttestedExportAt),
          now = (deps.now ?? (() => new Date()))();
        if (attestedAt > now) failure("comparison_export_time_invalid", 400);
        const initial = binding(
          await db().forWorkspace(input.workspaceId, (r) =>
            r.exportAttempts.getById(input.exportAttemptId),
          ),
          input.workspaceId,
        );
        if (attestedAt <= initial.attempt.artifactReadyAt!)
          failure("comparison_export_time_invalid", 400);
        let delivered: Uint8Array;
        try {
          delivered = await deps.getAssetStore().readObject(
            input.workspaceId,
            createExportAssetKey({
              workspaceId: input.workspaceId,
              exportAttemptId: input.exportAttemptId,
              fileName: "export-" + input.exportAttemptId + ".xlsx",
            }),
          );
        } catch {
          failure("export_artifact_unavailable", 503);
        }
        if (artifactHash(delivered!) !== initial.attempt.artifactSha256)
          failure("export_artifact_hash_mismatch");
        let deliveredSheet, suppliedSheet;
        try {
          if (
            readBulkFormSheetName(delivered!) !== "Default" ||
            readBulkFormSheetName(input.body) !== "Default"
          )
            failure("comparison_workbook_invalid", 400);
          deliveredSheet = readBulkFormSheet(delivered!);
          suppliedSheet = readBulkFormSheet(input.body);
        } catch {
          failure("comparison_workbook_invalid", 400);
        }
        const comparison = compareFreshExport({
          delivered: deliveredSheet!,
          supplied: suppliedSheet!,
          productIds: initial.productIds,
        });
        const record = await db().forWorkspace(input.workspaceId, async (r) => {
          const current = binding(
            await r.exportAttempts.getById(input.exportAttemptId),
            input.workspaceId,
          );
          if (
            current.attempt.artifactSha256 !== initial.attempt.artifactSha256 ||
            !isDeepStrictEqual(
              current.attempt.provenance,
              initial.attempt.provenance,
            ) ||
            current.attempt.artifactReadyAt!.getTime() !==
              initial.attempt.artifactReadyAt!.getTime()
          )
            failure("export_verification_binding_mismatch");
          return r.exportVerifications.ensure({
            exportAttemptId: input.exportAttemptId,
            artifactSha256: initial.attempt.artifactSha256!,
            suppliedSha256: artifactHash(input.body),
            merchantAttestedExportAt: attestedAt,
            connectionId: initial.connectionId,
            policyVersion: comparison.policyVersion,
            filename: input.filename,
            recordedBy: input.actorId,
            provenance: initial.attempt.provenance!,
            comparison,
          });
        });
        const { wasCreated, ...verification } = record;
        return { verification: wire(verification), replayed: !wasCreated };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof ImportResultConflict)
          failure(error.code, error.status);
        if (error instanceof FreshExportComparisonError)
          failure(
            error.code,
            error.code === "comparison_input_too_large"
              ? 413
              : error.code === "export_membership_mismatch"
                ? 409
                : 400,
          );
        // Workbook/database/provider details must never escape through logs or responses.
        failure("comparison_unavailable", 503);
      }
    },
    async detail(input: {
      workspaceId: string;
      exportAttemptId: string;
      verificationId: string;
    }): Promise<{ verification: ExportVerificationWire }> {
      try {
        return await db().forWorkspace(input.workspaceId, async (r) => {
          const record = await r.exportVerifications.getForAttempt(
            input.exportAttemptId,
            input.verificationId,
          );
          if (!record) failure("comparison_not_found", 404);
          return { verification: wire(record!) };
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        failure("comparison_history_unavailable", 503);
      }
    },
    async history(input: {
      workspaceId: string;
      exportAttemptId: string;
      page: number;
      pageSize: number;
    }): Promise<ExportVerificationHistoryWire> {
      try {
        return await db().forWorkspace(input.workspaceId, async (r) => {
          if (!(await r.exportAttempts.getById(input.exportAttemptId)))
            failure("export_attempt_not_found", 404);
          const page = await r.exportVerifications.listForAttempt(
            input.exportAttemptId,
            input.page,
            input.pageSize,
          );
          return {
            ...page,
            items: page.items.map((r) => ({
              ...r,
              createdAt: r.createdAt.toISOString(),
              merchantAttestedExportAt:
                r.merchantAttestedExportAt.toISOString(),
            })),
          };
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof ImportResultConflict)
          failure(error.code, error.status);
        failure("comparison_history_unavailable", 503);
      }
    },
  };
}
