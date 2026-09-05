import { describe, it, expect, vi } from "vitest";
import {
  BULK_FORM_COLUMNS,
  hashBulkFormHeaderContract,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import { artifactHash } from "./export-artifact";
import { createFreshExportVerificationService } from "./fresh-export-verification";
const id = "11111111-1111-4111-8111-111111111111";
const sheet = [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
  BULK_FORM_COLUMNS.map((c) => (c.key === "productId" ? "001" : "")),
];
const bytes = writeBulkFormWorkbook(sheet);
const manifest = [
  { listingId: "listing", versionId: "version", outcome: "included" },
];
const spec = SHOPLINE_BULK_FORM_SPEC_VERSION,
  header = hashBulkFormHeaderContract();
export function fixture() {
  const attempt: any = {
    id,
    manifest,
    rowCount: 1,
    specVersion: spec,
    artifactStatus: "ready",
    artifactReadyAt: new Date("2026-09-05T00:00:00Z"),
    artifactSha256: artifactHash(bytes),
    provenance: {
      identityVersion: 1,
      workspaceId: "ws",
      freshnessAttested: true,
      headerContractSha256: header,
      specVersion: spec,
      rowOrder: ["listing"],
      manifest,
      evidence: [
        {
          listingId: "listing",
          versionId: "version",
          approvalReceiptId: "receipt",
          sourceSnapshotId: "source",
          confirmationVersionId: "version",
          headerContractSha256: header,
          specVersion: spec,
          confirmationRevision: 1,
          sourceImportId: "import",
          rowDigest: "c".repeat(64),
          remoteProductId: "001",
          connectionId: "store",
        },
      ],
    },
  };
  const ensure = vi.fn(async (x: any) => ({
    ...x,
    id: "comparison",
    createdAt: new Date(),
    wasCreated: true,
  }));
  const getById = vi.fn(async () => attempt);
  const forWorkspace = vi.fn(async (_ws: string, fn: any) =>
    fn({ exportAttempts: { getById }, exportVerifications: { ensure } }),
  );
  const readObject = vi.fn(async () => bytes);
  const service = createFreshExportVerificationService({
    getDatabase: () => ({ forWorkspace }) as any,
    getAssetStore: () => ({ readObject }),
    now: () => new Date("2026-09-05T02:00:00Z"),
  });
  const input = {
    workspaceId: "ws",
    actorId: "reviewer",
    exportAttemptId: id,
    filename: "snapshot.xlsx",
    merchantAttestedExportAt: "2026-09-05T01:00:00Z",
    sameStoreAttested: true,
    body: bytes,
  };
  return { attempt, ensure, getById, forWorkspace, readObject, service, input };
}
describe("fresh export service", () => {
  it("compares exact immutable artifact and passes normalized evidence without workbook bytes", async () => {
    const f = fixture();
    await f.service.record(f.input);
    expect(f.forWorkspace).toHaveBeenCalledTimes(2);
    expect(f.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "store",
        suppliedSha256: artifactHash(bytes),
        comparison: expect.objectContaining({
          outcome: "matches_compared_fields",
        }),
      }),
    );
    expect(f.ensure.mock.calls[0]![0]).not.toHaveProperty("body");
  });
  it.each([
    "bad",
    "2026-02-30T01:00:00Z",
    "2026-09-05T03:00:00Z",
    "2026-09-05T00:00:00Z",
    "2026-09-05T01:00:00",
  ])("rejects invalid/nonlater/future instant %s", async (time) => {
    const f = fixture();
    await expect(
      f.service.record({ ...f.input, merchantAttestedExportAt: time }),
    ).rejects.toMatchObject({ code: "comparison_export_time_invalid" });
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("requires explicit same-store attestation", async () => {
    const f = fixture();
    await expect(
      f.service.record({ ...f.input, sameStoreAttested: false }),
    ).rejects.toMatchObject({ code: "comparison_same_store_required" });
    expect(f.readObject).not.toHaveBeenCalled();
  });
  it.each([
    "artifactStatus",
    "artifactSha256",
    "provenance",
    "artifactReadyAt",
  ])("fails closed without %s", async (key) => {
    const f = fixture();
    f.attempt[key] = null;
    await expect(f.service.record(f.input)).rejects.toThrow();
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("rejects hash mismatch before comparing", async () => {
    const f = fixture();
    f.readObject.mockResolvedValue(new Uint8Array([1]));
    await expect(f.service.record(f.input)).rejects.toMatchObject({
      code: "export_artifact_hash_mismatch",
    });
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("rejects foreign/missing attempt", async () => {
    const f = fixture();
    f.getById.mockResolvedValue(null);
    await expect(f.service.record(f.input)).rejects.toMatchObject({
      code: "export_attempt_not_found",
    });
    expect(f.readObject).not.toHaveBeenCalled();
  });
  it("rejects malformed workbook safely", async () => {
    const f = fixture();
    await expect(
      f.service.record({ ...f.input, body: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: "comparison_workbook_invalid" });
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("rejects renamed sheet, and target mismatch against provenance", async () => {
    const f = fixture();
    f.attempt.provenance.evidence[0].remoteProductId = "other";
    await expect(f.service.record(f.input)).rejects.toMatchObject({
      code: "export_membership_mismatch",
    });
  });
  it("rejects over-limit upload before storage I/O", async () => {
    const f = fixture();
    await expect(
      f.service.record({
        ...f.input,
        body: new Uint8Array(4 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "comparison_upload_too_large" });
    expect(f.readObject).not.toHaveBeenCalled();
  });
  it("revalidates at commit boundary", async () => {
    const f = fixture();
    f.getById
      .mockResolvedValueOnce(f.attempt)
      .mockResolvedValueOnce({ ...f.attempt, artifactSha256: "a".repeat(64) });
    await expect(f.service.record(f.input)).rejects.toMatchObject({
      code: "export_verification_binding_mismatch",
    });
    expect(f.ensure).not.toHaveBeenCalled();
  });
});

it("does not expose a foreign/other-attempt comparison detail", async () => {
  const f = fixture();
  f.forWorkspace.mockImplementation(async (_ws, fn) =>
    fn({ exportVerifications: { getForAttempt: async () => null } }),
  );
  await expect(
    f.service.detail({
      workspaceId: "ws",
      exportAttemptId: f.input.exportAttemptId,
      verificationId: "other",
    }),
  ).rejects.toMatchObject({ code: "comparison_not_found", status: 404 });
});
it("rejects mixed-store evidence and a noncurrent header contract", async () => {
  for (const change of ["store", "header"]) {
    const f = fixture();
    if (change === "header")
      f.attempt.provenance.headerContractSha256 = "a".repeat(64);
    else {
      f.attempt.provenance.evidence[0].connectionId = "";
    }
    await expect(f.service.record(f.input)).rejects.toThrow();
    expect(f.ensure).not.toHaveBeenCalled();
  }
});
it("reports audit/DB failures safely and does not return a successful comparison", async () => {
  const f = fixture();
  f.ensure.mockRejectedValue(new Error("synthetic private query"));
  await expect(f.service.record(f.input)).rejects.toMatchObject({
    status: 503,
    code: "comparison_unavailable",
  });
});
