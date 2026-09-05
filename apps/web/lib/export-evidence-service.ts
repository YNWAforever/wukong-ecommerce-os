import { createExportAssetKey, type AssetStore } from "@wukong/assets";
import { ImportResultConflict, type Database } from "@wukong/db";
import { FreshExportComparisonError } from "@wukong/shopline";
import { readDefaultBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
import { artifactHash } from "./export-artifact";
import { ApiError } from "./route-support";
import {
  buildExportEvidencePacket,
  ExportEvidenceError,
  validateRetainedComparison,
  type ExportEvidencePacket,
} from "./export-evidence-packet";
export type ExportEvidenceInput = {
  workspaceId: string;
  exportAttemptId: string;
  comparisonId: string;
};
export type ExportEvidenceSummary = {
  schemaVersion: "wukong-attempt-evidence-packet/v1";
  canonicalization: "sorted-json-v1";
  asOf: string;
  snapshotSha256: string;
  exportAttemptId: string;
  comparisonId: string;
  artifactSha256: string;
  suppliedSha256: string;
  memberCount: number;
  receiptRevisionCount: number;
  reportedMemberCount: number;
  unreportedMemberCount: number;
  comparisonOutcome: ExportEvidencePacket["payload"]["comparison"]["comparison"]["outcome"];
  comparisonCounts: ExportEvidencePacket["payload"]["comparison"]["comparison"]["counts"];
  byteLength: number;
  limitations: ExportEvidencePacket["payload"]["limitations"];
};
function failure(code: string, status = 409): never {
  throw new ApiError(
    status,
    code,
    "The evidence packet could not be prepared. Refresh the preview or retry.",
  );
}
export function createExportEvidenceService(deps: {
  getDatabase(): Pick<Database, "forWorkspace">;
  getAssetStore(): Pick<AssetStore, "readObject">;
}) {
  async function prepare(
    input: ExportEvidenceInput,
    download?: { actorId: string; expectedSnapshotSha256: string },
  ) {
    try {
      return await deps
        .getDatabase()
        .forWorkspace(input.workspaceId, async (r) => {
          const snapshot = await r.exportEvidence.getSnapshot(
            input.exportAttemptId,
            input.comparisonId,
          );
          const packet = buildExportEvidencePacket(snapshot, input);
          if (
            download &&
            download.expectedSnapshotSha256 !== packet.snapshotSha256
          )
            failure("evidence_snapshot_changed");
          let bytes: Uint8Array;
          try {
            bytes = await deps.getAssetStore().readObject(
              input.workspaceId,
              createExportAssetKey({
                workspaceId: input.workspaceId,
                exportAttemptId: input.exportAttemptId,
                fileName: `export-${input.exportAttemptId}.xlsx`,
              }),
            );
          } catch {
            failure("export_artifact_unavailable", 503);
          }
          if (artifactHash(bytes!) !== packet.payload.attempt.artifactSha256)
            failure("export_artifact_hash_mismatch");
          validateRetainedComparison(
            packet.payload.comparison.comparison,
            packet.payload.members.map((m) => m.remoteProductId),
            readDefaultBulkFormSheet(bytes!),
          );
          if (download)
            await r.audit.write({
              workspaceId: input.workspaceId,
              actorId: download.actorId,
              entityId: input.exportAttemptId,
              action: "shopline.export_evidence_packet_downloaded",
              metadata: {
                exportAttemptId: input.exportAttemptId,
                comparisonId: input.comparisonId,
                snapshotSha256: packet.snapshotSha256,
                payloadSha256: packet.payloadSha256,
                schemaVersion: packet.payload.schemaVersion,
              },
            });
          return packet;
        });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (
        error instanceof ExportEvidenceError ||
        error instanceof ImportResultConflict
      )
        failure(error.code, error.status);
      if (error instanceof FreshExportComparisonError)
        failure("evidence_binding_invalid");
      failure("evidence_packet_unavailable", 503);
    }
  }
  return {
    async preview(input: ExportEvidenceInput): Promise<ExportEvidenceSummary> {
      const packet = await prepare(input);
      const p = packet.payload;
      const unreportedMemberCount = p.members.filter(
        (m) => m.operatorOutcome === "unreported",
      ).length;
      return {
        schemaVersion: p.schemaVersion,
        canonicalization: p.canonicalization,
        asOf: p.asOf,
        snapshotSha256: packet.snapshotSha256,
        exportAttemptId: p.attempt.id,
        comparisonId: p.comparison.id,
        artifactSha256: p.attempt.artifactSha256,
        suppliedSha256: p.comparison.suppliedSha256,
        memberCount: p.members.length,
        receiptRevisionCount: p.members.reduce(
          (n, m) => n + m.receipts.length,
          0,
        ),
        reportedMemberCount: p.members.length - unreportedMemberCount,
        unreportedMemberCount,
        comparisonOutcome: p.comparison.comparison.outcome,
        comparisonCounts: p.comparison.comparison.counts,
        byteLength: packet.byteLength,
        limitations: p.limitations,
      };
    },
    async download(
      input: ExportEvidenceInput & {
        actorId: string;
        expectedSnapshotSha256: string;
      },
    ) {
      const packet = await prepare(input, input);
      return {
        json: packet.json,
        filename: `export-${input.exportAttemptId}-comparison-${input.comparisonId}-evidence.json`,
      };
    },
  };
}
