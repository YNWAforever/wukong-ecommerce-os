import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  BULK_FORM_COLUMNS,
  compareFreshExport,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import {
  buildExportEvidencePacket,
  canonicalJson,
  MAX_EVIDENCE_PACKET_BYTES,
} from "./export-evidence-packet";
import { packetFixture } from "./export-evidence-fixtures";
describe("canonical evidence packet", () => {
  it("includes exact selected evidence, all revisions and explicit unreported members", () => {
    const f = packetFixture();
    const result = buildExportEvidencePacket(f.snapshot, f.input);
    expect(result.payload.comparison.id).toBe(f.input.comparisonId);
    expect(result.payload.members.map((m) => m.operatorOutcome)).toEqual([
      "accepted",
      "unreported",
    ]);
    expect(result.payload.members[0]!.receipts).toHaveLength(2);
    expect(result.json).not.toContain("idempotencyKey");
    expect(result.payloadSha256).toBe(
      createHash("sha256").update(canonicalJson(result.payload)).digest("hex"),
    );
  });
  it("canonicalizes sorted keys and preserves ordered arrays", () => {
    expect(canonicalJson({ z: [2, 1], a: { z: 1, b: 2 } })).toBe(
      '{"a":{"b":2,"z":1},"z":[2,1]}',
    );
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    { x: undefined },
    [undefined],
    new Date(),
    1n,
  ])("rejects malformed JSON value %s", (value) =>
    expect(() => canonicalJson(value)).toThrow(),
  );
  it("changes payload hash but not snapshot hash for asOf alone", () => {
    const f = packetFixture(),
      a = buildExportEvidencePacket(f.snapshot, f.input);
    f.snapshot.asOf = new Date("2026-09-05T05:00:00Z");
    const b = buildExportEvidencePacket(f.snapshot, f.input);
    expect(a.snapshotSha256).toBe(b.snapshotSha256);
    expect(a.payloadSha256).not.toBe(b.payloadSha256);
  });
  it("orders revisions deterministically", () => {
    const f = packetFixture(),
      a = buildExportEvidencePacket(f.snapshot, f.input);
    f.snapshot.receipts.reverse();
    expect(buildExportEvidencePacket(f.snapshot, f.input).json).toBe(a.json);
  });
  it.each([
    "comparison",
    "version",
    "source",
    "connection",
    "digest",
    "counts",
    "fields",
    "chain",
  ])("rejects corrupt %s binding", (kind) => {
    const f = packetFixture();
    if (kind === "comparison") f.snapshot.comparison.id = "other";
    if (kind === "version")
      f.snapshot.attempt.provenance.evidence[0]!.versionId = "wrong";
    if (kind === "source")
      f.snapshot.comparison.provenance.evidence[0]!.sourceImportId = "wrong";
    if (kind === "connection") f.snapshot.comparison.connectionId = "wrong";
    if (kind === "digest")
      f.snapshot.comparison.artifactSha256 = "a".repeat(64);
    if (kind === "counts") f.snapshot.comparison.comparison.counts.matched = 0;
    if (kind === "fields")
      f.snapshot.comparison.comparison.products[0]!.fields[0]!.different = true;
    if (kind === "chain") f.snapshot.receipts[1]!.supersedesResultId = "other";
    expect(() => buildExportEvidencePacket(f.snapshot, f.input)).toThrow();
  });
  it("refuses receipt overflow and final envelope overflow", () => {
    const f = packetFixture();
    f.snapshot.receiptCount = 1001;
    expect(() => buildExportEvidencePacket(f.snapshot, f.input)).toThrow(
      "evidence_receipts_too_large",
    );
    f.snapshot.receiptCount = 2;
    f.snapshot.receipts[0]!.rejectReason = "x".repeat(
      MAX_EVIDENCE_PACKET_BYTES,
    );
    expect(() => buildExportEvidencePacket(f.snapshot, f.input)).toThrow(
      "evidence_packet_too_large",
    );
  });
});

it("accepts exactly the canonical envelope byte limit and rejects one byte more", () => {
  const f = packetFixture();
  const initial = buildExportEvidencePacket(f.snapshot, f.input);
  f.snapshot.receipts[0]!.rejectReason = "x".repeat(
    MAX_EVIDENCE_PACKET_BYTES - initial.byteLength + 3,
  );
  expect(buildExportEvidencePacket(f.snapshot, f.input).byteLength).toBe(
    MAX_EVIDENCE_PACKET_BYTES,
  );
  f.snapshot.receipts[0]!.rejectReason += "x";
  expect(() => buildExportEvidencePacket(f.snapshot, f.input)).toThrow(
    "evidence_packet_too_large",
  );
});

it.each([
  "legacy",
  "not-ready",
  "wrong-receipt-version",
  "wrong-product",
  "missing-source",
  "wrong-row-digest",
])("refuses %s evidence", (kind) => {
  const f = packetFixture();
  if (kind === "legacy") (f.snapshot.attempt as any).provenance = null;
  if (kind === "not-ready")
    (f.snapshot.attempt as any).artifactStatus = "pending";
  if (kind === "wrong-receipt-version")
    f.snapshot.receipts[0]!.versionId = "wrong";
  if (kind === "wrong-product")
    f.snapshot.comparison.comparison.products[0]!.productId = "other";
  if (kind === "missing-source")
    f.snapshot.attempt.provenance.evidence[0]!.sourceSnapshotId = "";
  if (kind === "wrong-row-digest")
    f.snapshot.comparison.provenance.evidence[0]!.rowDigest = "d".repeat(64);
  expect(() => buildExportEvidencePacket(f.snapshot, f.input)).toThrow();
});
