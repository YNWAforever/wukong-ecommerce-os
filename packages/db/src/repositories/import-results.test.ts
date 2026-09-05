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
