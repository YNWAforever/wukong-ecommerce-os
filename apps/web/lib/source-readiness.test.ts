import { describe, expect, it } from "vitest";
import {
  BULK_FORM_COLUMNS,
  hashBulkFormRow,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "./review-confirmation-keys";
import { evaluateSourceReadiness } from "./source-readiness";
function fixture() {
  const rawRow = Object.fromEntries(
    BULK_FORM_COLUMNS.map((c) => [
      c.key,
      c.key === "productId" ? "remote" : "synthetic",
    ]),
  );
  const digest = hashBulkFormRow(rawRow as never);
  const link = {
    origin: "import",
    connectionId: "connection",
    remoteProductId: "remote",
    sourceImportId: "source",
    contentDigest: digest,
    rawRow,
  };
  const state = { status: "approved", activeVersionId: "version", flags: [] };
  const confirmation = {
    listingId: "listing",
    versionId: "version",
    revision: 1,
    sourceImportId: "source",
    rowDigest: digest,
    fieldConfirmations: Object.fromEntries(
      CONFIRMATION_FIELD_KEYS.map((k) => [k, true]),
    ),
    negativeConfirmations: Object.fromEntries(
      CONFIRMATION_NEGATIVE_KEYS.map((k) => [k, true]),
    ),
  };
  const source = {
    id: "snapshot",
    listingId: "listing",
    sourceImportId: "source",
    connectionId: "connection",
    remoteProductId: "remote",
    sourceRowDigest: digest,
    headerContractSha256: "header",
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
    rawRow,
  };
  const receipt = {
    ...source,
    id: "receipt",
    sourceSnapshotId: "snapshot",
    versionId: "version",
    confirmationVersionId: "version",
    confirmationRevision: 1,
  };
  const deps = {
    getReviewState: async () => state,
    getReviewConfirmation: async () => confirmation,
    getApprovalReceipt: async () => receipt,
    getSourceRow: async () => source,
    getPlatformProductLink: async () => link,
    currentHeaderContractSha256: () => "header",
    getSourceImportHeaderContractSha256: async () => "header",
    getSourceImport: async () => ({
      merchantAttestedExportAt: new Date("2026-01-01"),
      headerContractSha256: "header",
    }),
  };
  return { deps, state };
}
describe("advisory source readiness", () => {
  it("shows bindings without granting freshness or downstream verification", async () => {
    const { deps } = fixture();
    const result = await evaluateSourceReadiness(
      { workspaceId: "workspace", listingId: "listing" },
      deps as never,
    );
    expect(result).toMatchObject({
      eligible: false,
      eligibleAfterAttestation: true,
      freshnessAttested: false,
      reason: "not_attested",
      downstreamVerification: "unverified",
      sourceImportId: "source",
      approvedBinding: { versionId: "version" },
      reviewedBinding: { versionId: "version" },
    });
  });
  it("checks current header even without freshness attestation", async () => {
    const { deps } = fixture();
    deps.getSourceImport = async () => ({
      merchantAttestedExportAt: new Date("2026-01-01"),
      headerContractSha256: "obsolete",
    });
    expect(
      await evaluateSourceReadiness(
        { workspaceId: "workspace", listingId: "listing" },
        deps as never,
      ),
    ).toMatchObject({
      eligible: false,
      eligibleAfterAttestation: false,
      headerContractCurrent: false,
      reason: "header_contract_stale",
    });
  });
  it("preserves the shared approval rejection", async () => {
    const { deps, state } = fixture();
    state.status = "in_review";
    expect(
      await evaluateSourceReadiness(
        { workspaceId: "workspace", listingId: "listing" },
        deps as never,
      ),
    ).toMatchObject({
      eligibleAfterAttestation: false,
      reason: "approval_required",
    });
  });
});
it("refuses an advisory catalog row when the current listing link points elsewhere", async () => {
  const { deps } = fixture();
  const other = {
    ...(await deps.getPlatformProductLink()),
    remoteProductId: "other",
  };
  expect(
    await evaluateSourceReadiness(
      { workspaceId: "workspace", listingId: "listing", link: other as never },
      deps as never,
    ),
  ).toMatchObject({
    eligibleAfterAttestation: false,
    reason: "remote_link_changed",
  });
});
it("keeps missing source/time explicit and rejects a stale reviewed binding", async () => {
  const { deps } = fixture();
  const missing = await evaluateSourceReadiness(
    { workspaceId: "workspace", listingId: "listing" },
    { ...deps, getSourceImport: async () => null } as never,
  );
  expect(missing).toMatchObject({
    merchantAttestedExportAt: null,
    headerContractCurrent: false,
    eligibleAfterAttestation: false,
  });
  const confirmation = await deps.getReviewConfirmation();
  const stale = await evaluateSourceReadiness(
    { workspaceId: "workspace", listingId: "listing" },
    {
      ...deps,
      getReviewConfirmation: async () => ({
        ...confirmation,
        sourceImportId: "older-source",
      }),
    } as never,
  );
  expect(stale).toMatchObject({
    reason: "source_import_mismatch",
    eligibleAfterAttestation: false,
    reviewedBinding: { sourceImportId: "older-source" },
  });
});

it("shows a replacement active-version checklist instead of an inherited predecessor binding", async () => {
  const { deps } = fixture();
  const base = await deps.getReviewConfirmation();
  const receipt = await deps.getApprovalReceipt();
  const result = await evaluateSourceReadiness(
    { workspaceId: "workspace", listingId: "listing" },
    {
      ...deps,
      getApprovalReceipt: async () => ({
        ...receipt,
        confirmationVersionId: "predecessor",
      }),
      getReviewConfirmation: async (id: string) => ({
        ...base,
        versionId: id,
        sourceImportId: id === "version" ? "replacement-source" : "source",
      }),
    } as never,
  );
  expect(result).toMatchObject({
    reason: "confirmation_changed",
    eligibleAfterAttestation: false,
    reviewedBinding: {
      versionId: "version",
      sourceImportId: "replacement-source",
    },
    approvedBinding: { confirmationVersionId: "predecessor" },
  });
});
