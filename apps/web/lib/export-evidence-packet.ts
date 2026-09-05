import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  validateExportResultBinding,
  type ExportEvidenceSnapshot,
} from "@wukong/db";
import {
  BULK_FORM_COLUMNS,
  compareFreshExport,
  FRESH_EXPORT_POLICY_VERSION,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  type BulkFormSheet,
  type FreshExportComparison,
} from "@wukong/shopline";
export const MAX_EVIDENCE_PACKET_BYTES = 3 * 1024 * 1024;
export const EVIDENCE_LIMITATIONS = {
  suppliedSnapshot: true,
  storeAndTime: "operator_attested",
  evidence: "normalized_cells_only",
  quantityDeltas: "observational",
  authenticatedLiveShoplineState: false,
  causalityClaim: false,
  stockNeutralityClaim: false,
  uatSignOff: false,
  merchantWriteAuthorization: false,
} as const;
export class ExportEvidenceError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
    this.name = "ExportEvidenceError";
  }
}
function fail(code = "evidence_binding_invalid", status = 409): never {
  throw new ExportEvidenceError(code, status);
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("evidence_json_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length)
      fail("evidence_json_invalid");
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return fail("evidence_json_invalid");
}
const iso = (value: Date) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
  return value.toISOString();
};
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
/** Rebuild only retained relevant rows, preserving their original row numbers. No unrelated rows are invented. */
export function retainedComparisonSheets(comparison: FreshExportComparison) {
  const expected: (string | null)[][] = [
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
  ];
  const supplied: (string | null)[][] = [...expected];
  const expectedPositions = new Set<number>(),
    observedPositions = new Set<number>();
  const add = (
    sheet: (string | null)[][],
    positions: Set<number>,
    r: { rowNumber: number; cells: (string | null)[] },
    id: string,
  ) => {
    if (
      !Number.isSafeInteger(r.rowNumber) ||
      r.rowNumber < 3 ||
      r.rowNumber > 5002 ||
      positions.has(r.rowNumber) ||
      !Array.isArray(r.cells) ||
      r.cells.length !== BULK_FORM_COLUMNS.length ||
      r.cells[0] !== id ||
      r.cells.some(
        (c) =>
          c !== null &&
          (typeof c !== "string" || !c.trim() || c.length > 32767),
      )
    )
      fail();
    positions.add(r.rowNumber);
    while (sheet.length < r.rowNumber) sheet.push([]);
    sheet[r.rowNumber - 1] = [...r.cells];
  };
  for (const p of comparison.products) {
    add(expected, expectedPositions, p.expectedRow, p.productId);
    for (const r of p.observedRows)
      add(supplied, observedPositions, r, p.productId);
  }
  return { expected, supplied, observedCount: observedPositions.size };
}
export function validateRetainedComparison(
  comparison: FreshExportComparison,
  productIds: string[],
  delivered?: BulkFormSheet,
) {
  const sheets = retainedComparisonSheets(comparison);
  const recomputed = compareFreshExport({
    delivered: delivered ?? sheets.expected,
    supplied: sheets.supplied,
    productIds,
  });
  const counts = comparison.counts;
  if (
    !Number.isSafeInteger(counts.unrelatedRows) ||
    counts.unrelatedRows < 0 ||
    !Number.isSafeInteger(counts.suppliedRows) ||
    counts.suppliedRows > 5000 ||
    counts.suppliedRows !== sheets.observedCount + counts.unrelatedRows
  )
    fail();
  recomputed.counts.unrelatedRows = counts.unrelatedRows;
  recomputed.counts.suppliedRows = counts.suppliedRows;
  if (!isDeepStrictEqual(recomputed, comparison)) fail();
  return recomputed;
}
export function buildExportEvidencePacket(
  snapshot: ExportEvidenceSnapshot,
  input: { workspaceId: string; exportAttemptId: string; comparisonId: string },
) {
  if (snapshot.receiptCount > 1000 || snapshot.receipts.length > 1000)
    fail("evidence_receipts_too_large", 413);
  if (snapshot.receiptCount !== snapshot.receipts.length) fail();
  const a = snapshot.attempt,
    c = snapshot.comparison;
  if (!a) fail("export_attempt_not_found", 404);
  if (!c) fail("comparison_not_found", 404);
  if (
    a.id !== input.exportAttemptId ||
    c.id !== input.comparisonId ||
    c.exportAttemptId !== a.id
  )
    fail();
  const members = a.manifest.filter((m) => m.outcome === "included");
  if (!members.length) fail("export_provenance_incomplete");
  validateExportResultBinding(
    a,
    input.workspaceId,
    members[0]!.listingId,
    members[0]!.versionId ?? "",
  );
  const p = a.provenance!;
  if (
    !a.artifactReadyAt ||
    a.specVersion !== SHOPLINE_BULK_FORM_SPEC_VERSION ||
    p.headerContractSha256 !== hashBulkFormHeaderContract() ||
    !isDeepStrictEqual(p, c.provenance) ||
    c.artifactSha256 !== a.artifactSha256 ||
    !/^[a-f0-9]{64}$/.test(c.suppliedSha256) ||
    c.policyVersion !== FRESH_EXPORT_POLICY_VERSION ||
    !nonempty(c.recordedBy) ||
    !nonempty(c.filename) ||
    c.merchantAttestedExportAt <= a.artifactReadyAt
  )
    fail();
  const evidence = p.evidence as Array<Record<string, unknown>>;
  if (
    evidence.some(
      (e) =>
        e.connectionId !== c.connectionId ||
        e.confirmationVersionId !== e.versionId,
    ) ||
    new Set(evidence.map((e) => e.remoteProductId)).size !== members.length
  )
    fail();
  const normalized = validateRetainedComparison(
    c.comparison,
    evidence.map((e) => String(e.remoteProductId)),
  );
  const receiptMap = new Map(
    members.map((m) => [m.listingId, [] as typeof snapshot.receipts]),
  );
  const memberMap = new Map(members.map((m) => [m.listingId, m]));
  const receiptIds = new Set<string>();
  for (const r of snapshot.receipts) {
    const m = memberMap.get(r.listingId);
    if (
      !m ||
      r.exportAttemptId !== a.id ||
      r.mode !== "export" ||
      r.versionId !== m.versionId ||
      receiptIds.has(r.id) ||
      !nonempty(r.id) ||
      !nonempty(r.recordedBy) ||
      !["accepted", "rejected"].includes(r.outcome) ||
      (r.outcome === "rejected" && !r.rejectReason?.trim()) ||
      (r.outcome === "accepted" && r.rejectReason !== null)
    )
      fail();
    receiptIds.add(r.id);
    receiptMap.get(r.listingId)!.push(r);
  }
  const projectedMembers = evidence.map((e) => {
    const receipts = receiptMap
      .get(String(e.listingId))!
      .sort((x, y) => x.revision - y.revision);
    receipts.forEach((r, i) => {
      if (
        r.revision !== i + 1 ||
        r.supersedesResultId !== (i === 0 ? null : receipts[i - 1]!.id) ||
        (i === 0 ? r.correctionReason !== null : !r.correctionReason?.trim())
      )
        fail();
    });
    return {
      listingId: String(e.listingId),
      versionId: String(e.versionId),
      approvalReceiptId: String(e.approvalReceiptId),
      sourceSnapshotId: String(e.sourceSnapshotId),
      confirmationVersionId: String(e.confirmationVersionId),
      confirmationRevision: Number(e.confirmationRevision),
      sourceImportId: String(e.sourceImportId),
      rowDigest: String(e.rowDigest),
      remoteProductId: String(e.remoteProductId),
      connectionId: String(e.connectionId),
      headerContractSha256: String(e.headerContractSha256),
      specVersion: String(e.specVersion),
      operatorOutcome: receipts.at(-1)?.outcome ?? "unreported",
      receipts: receipts.map((r) => ({
        id: r.id,
        listingId: r.listingId,
        exportAttemptId: r.exportAttemptId,
        versionId: r.versionId,
        mode: r.mode,
        revision: r.revision,
        outcome: r.outcome,
        rejectReason: r.rejectReason,
        recordedBy: r.recordedBy,
        createdAt: iso(r.createdAt),
        supersedesResultId: r.supersedesResultId,
        correctionReason: r.correctionReason,
      })),
    };
  });
  const payload = {
    schemaVersion: "wukong-attempt-evidence-packet/v1" as const,
    canonicalization: "sorted-json-v1" as const,
    asOf: iso(snapshot.asOf),
    workspaceId: input.workspaceId,
    limitations: EVIDENCE_LIMITATIONS,
    attempt: {
      id: a.id,
      requestedBy: a.requestedBy,
      createdAt: iso(a.createdAt),
      artifactStatus: "ready",
      artifactReadyAt: iso(a.artifactReadyAt),
      artifactSha256: a.artifactSha256!,
      rowCount: a.rowCount,
      specVersion: a.specVersion,
      identityVersion: 1,
      freshnessAttested: true,
      headerContractSha256: String(p.headerContractSha256),
      rowOrder: [...(p.rowOrder as string[])],
      manifest: a.manifest.map((m) => ({
        listingId: m.listingId,
        versionId: m.versionId,
        outcome: m.outcome,
        ...(m.reason === undefined ? {} : { reason: m.reason }),
      })),
    },
    members: projectedMembers,
    comparison: {
      id: c.id,
      exportAttemptId: c.exportAttemptId,
      artifactSha256: c.artifactSha256,
      suppliedSha256: c.suppliedSha256,
      merchantAttestedExportAt: iso(c.merchantAttestedExportAt),
      connectionId: c.connectionId,
      policyVersion: c.policyVersion,
      filename: c.filename,
      recordedBy: c.recordedBy,
      createdAt: iso(c.createdAt),
      comparison: normalized,
    },
  };
  const payloadSha256 = digest(canonicalJson(payload));
  const { asOf: _asOf, ...snapshotPayload } = payload;
  const snapshotSha256 = digest(canonicalJson(snapshotPayload));
  const json = canonicalJson({ payload, payloadSha256 });
  const byteLength = Buffer.byteLength(json);
  if (byteLength > MAX_EVIDENCE_PACKET_BYTES)
    fail("evidence_packet_too_large", 413);
  return { payload, payloadSha256, snapshotSha256, json, byteLength };
}
export type ExportEvidencePacket = ReturnType<typeof buildExportEvidencePacket>;
