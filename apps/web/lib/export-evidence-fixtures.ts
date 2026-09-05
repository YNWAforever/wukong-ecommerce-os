import { createHash } from "node:crypto";
import {
  BULK_FORM_COLUMNS,
  compareFreshExport,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
export function packetFixture() {
  const sheet = [
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
    ...["001", "002"].map((id) =>
      BULK_FORM_COLUMNS.map((c) => (c.key === "productId" ? id : "")),
    ),
  ];
  const bytes = writeBulkFormWorkbook(sheet),
    hash = createHash("sha256").update(bytes).digest("hex");
  const manifest = ["one", "two"].map((listingId, i) => ({
    listingId,
    versionId: "version" + i,
    outcome: "included" as const,
  }));
  const provenance = {
    identityVersion: 1,
    workspaceId: "ws",
    freshnessAttested: true,
    headerContractSha256: hashBulkFormHeaderContract(),
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    rowOrder: ["one", "two"],
    manifest,
    evidence: manifest.map((m, i) => ({
      ...m,
      approvalReceiptId: "approval" + i,
      sourceSnapshotId: "snapshot" + i,
      confirmationVersionId: m.versionId,
      confirmationRevision: 1,
      sourceImportId: "source" + i,
      rowDigest: "c".repeat(64),
      remoteProductId: "00" + (i + 1),
      connectionId: "store",
      headerContractSha256: hashBulkFormHeaderContract(),
      specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    })),
  };
  const attempt = {
    id: "11111111-1111-4111-8111-111111111111",
    requestedBy: "actor",
    manifest,
    rowCount: 2,
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    provenance,
    artifactSha256: hash,
    artifactStatus: "ready" as const,
    artifactReadyAt: new Date("2026-09-05T00:00:00Z"),
    createdAt: new Date("2026-09-04T23:00:00Z"),
  };
  const comparison = {
    id: "22222222-2222-4222-8222-222222222222",
    exportAttemptId: attempt.id,
    artifactSha256: hash,
    suppliedSha256: hash,
    merchantAttestedExportAt: new Date("2026-09-05T01:00:00Z"),
    connectionId: "store",
    policyVersion: "fresh-export-v1" as const,
    filename: "supplied.xlsx",
    recordedBy: "operator",
    provenance: structuredClone(provenance),
    comparison: compareFreshExport({
      delivered: sheet,
      supplied: sheet,
      productIds: ["001", "002"],
    }),
    createdAt: new Date("2026-09-05T02:00:00Z"),
  };
  const receipts = [1, 2].map((revision) => ({
    id: "receipt" + revision,
    listingId: "one",
    exportAttemptId: attempt.id,
    versionId: "version0",
    mode: "export" as const,
    revision,
    outcome: revision === 1 ? ("rejected" as const) : ("accepted" as const),
    rejectReason: revision === 1 ? "bad" : null,
    recordedBy: "operator",
    createdAt: new Date("2026-09-05T03:00:00Z"),
    idempotencyKey: "private" + revision,
    supersedesResultId: revision === 1 ? null : "receipt1",
    correctionReason: revision === 1 ? null : "corrected",
  }));
  return {
    bytes,
    snapshot: {
      asOf: new Date("2026-09-05T04:00:00Z"),
      attempt,
      comparison,
      receipts,
      receiptCount: 2,
    },
    input: {
      workspaceId: "ws",
      exportAttemptId: attempt.id,
      comparisonId: comparison.id,
    },
  };
}
