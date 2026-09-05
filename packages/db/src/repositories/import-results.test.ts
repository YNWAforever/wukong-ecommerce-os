import { describe, it, expect } from "vitest";
import { validateExportResultBinding } from "./import-results.js";
const member = {
  listingId: "listing",
  versionId: "exported",
  outcome: "included" as const,
};
const attempt: any = {
  id: "attempt",
  manifest: [member],
  rowCount: 1,
  specVersion: "spec",
  artifactStatus: "ready",
  artifactSha256: "a".repeat(64),
  provenance: {
    identityVersion: 1,
    workspaceId: "ws",
    freshnessAttested: true,
    headerContractSha256: "b".repeat(64),
    specVersion: "spec",
    rowOrder: ["listing"],
    manifest: [member],
    evidence: [
      {
        listingId: "listing",
        versionId: "exported",
        approvalReceiptId: "receipt",
        sourceSnapshotId: "source",
        confirmationVersionId: "version",
        headerContractSha256: "b".repeat(64),
        specVersion: "spec",
        confirmationRevision: 1,
        sourceImportId: "import",
        rowDigest: "c".repeat(64),
        remoteProductId: "remote",
        connectionId: "connection",
      },
    ],
  },
};
describe("export result binding", () => {
  it("binds the immutable included version", () =>
    expect(() =>
      validateExportResultBinding(attempt, "ws", "listing", "exported"),
    ).not.toThrow());
  it.each(["missing", "new-active"])(
    "rejects absent membership or wrong version %s",
    (version) =>
      expect(() =>
        validateExportResultBinding(attempt, "ws", "listing", version),
      ).toThrow(),
  );
  it("rejects nonmembers", () =>
    expect(() =>
      validateExportResultBinding(attempt, "ws", "other", "exported"),
    ).toThrow());
  it.each(["pending", "failed", null])(
    "rejects artifact state %s",
    (artifactStatus) =>
      expect(() =>
        validateExportResultBinding(
          { ...attempt, artifactStatus },
          "ws",
          "listing",
          "exported",
        ),
      ).toThrow(),
  );
  it("rejects incomplete provenance", () =>
    expect(() =>
      validateExportResultBinding(
        { ...attempt, provenance: { identityVersion: 1 } },
        "ws",
        "listing",
        "exported",
      ),
    ).toThrow());
  it("rejects excluded/noop membership", () =>
    expect(() =>
      validateExportResultBinding(
        { ...attempt, manifest: [{ ...member, outcome: "excluded_no_op" }] },
        "ws",
        "listing",
        "exported",
      ),
    ).toThrow());
});

it("validates every version and rejects duplicates even when asked about the first of 5000 members", () => {
  const count = 5000;
  const manifest = Array.from({ length: count }, (_, i) => ({
    listingId: "listing-" + i,
    versionId: "version-" + i,
    outcome: "included" as const,
  }));
  const evidence = manifest.map((m) => ({
    ...attempt.provenance.evidence[0],
    listingId: m.listingId,
    versionId: m.versionId,
  }));
  const large = {
    ...attempt,
    manifest,
    rowCount: count,
    provenance: {
      ...attempt.provenance,
      manifest,
      rowOrder: manifest.map((m) => m.listingId),
      evidence,
    },
  };
  expect(() =>
    validateExportResultBinding(large, "ws", "listing-0", "version-0"),
  ).not.toThrow();
  evidence[count - 1]!.versionId = "wrong-last-version";
  expect(() =>
    validateExportResultBinding(large, "ws", "listing-0", "version-0"),
  ).toThrow("export_provenance_incomplete");
  evidence[count - 1] = { ...evidence[0]! };
  large.provenance.rowOrder = evidence.map((e) => e.listingId);
  expect(() =>
    validateExportResultBinding(large, "ws", "listing-0", "version-0"),
  ).toThrow("export_provenance_incomplete");
});
