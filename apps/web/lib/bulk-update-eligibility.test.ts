import {
  BULK_FORM_COLUMNS,
  hashBulkFormRow,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { describe, expect, it } from "vitest";
import type { ComplianceFlag, ListingStatus } from "@wukong/core";
import {
  checkBulkUpdateEligibility,
  type BulkUpdateEligibilityDeps,
} from "./bulk-update-eligibility";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "./review-confirmation-keys";

const input = {
  workspaceId: "workspace_test",
  listingId: "listing_test",
  versionId: "version_test",
  freshnessAttested: true,
};
function fixture() {
  const state = {
    status: "approved" as ListingStatus,
    activeVersionId: input.versionId,
    flags: [] as ComplianceFlag[],
  };
  const rawRow = Object.fromEntries(
    BULK_FORM_COLUMNS.map((column) => [
      column.key,
      column.key === "productId" ? "remote_test" : "synthetic",
    ]),
  );
  const digest = hashBulkFormRow(rawRow as never);
  const confirmation = {
    id: "confirmation_test",
    listingId: input.listingId,
    versionId: input.versionId,
    revision: 3,
    sourceImportId: "import_test",
    rowDigest: digest,
    fieldConfirmations: Object.fromEntries(
      CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
    ),
    negativeConfirmations: Object.fromEntries(
      CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
    ),
  };
  const link = {
    remoteProductId: "remote_test",
    rawRow,
    origin: "import" as const,
    connectionId: "connection_test",
    sourceImportId: "import_test",
    contentDigest: digest,
  };
  const snapshot = {
    id: "snapshot_test",
    workspaceId: input.workspaceId,
    listingId: input.listingId,
    sourceImportId: "import_test",
    connectionId: "connection_test",
    remoteProductId: "remote_test",
    sourceRowDigest: digest,
    rawRow: structuredClone(rawRow),
    specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION as string,
    headerContractSha256: "header_test",
    createdAt: new Date(),
  };
  const receipt = {
    ...snapshot,
    id: "receipt_test",
    sourceSnapshotId: snapshot.id,
    versionId: input.versionId,
    confirmationVersionId: input.versionId,
    confirmationRevision: confirmation.revision,
    approvedBy: "reviewer_test",
    createdAt: new Date(),
  };
  const deps: BulkUpdateEligibilityDeps = {
    getApprovalReceipt: async () => structuredClone(receipt),
    getSourceRow: async () => structuredClone(snapshot),
    getReviewState: async () => structuredClone(state),
    getReviewConfirmation: async () => structuredClone(confirmation),
    getPlatformProductLink: async () => structuredClone(link),
    getSourceImportHeaderContractSha256: async () => "header_test",
    currentHeaderContractSha256: () => "header_test",
  };
  return { deps, state, confirmation, link, receipt, snapshot };
}

describe("Bulk Update eligibility", () => {
  it.each(["approved", "published"] as const)(
    "accepts a complete current %s review",
    async (status) => {
      const { deps, state } = fixture();
      state.status = status;
      expect(await checkBulkUpdateEligibility(input, deps)).toMatchObject({
        ok: true,
        evidence: { versionId: input.versionId, confirmationRevision: 3 },
      });
    },
  );

  it.each([
    "draft",
    "processing",
    "in_review",
    "needs_info",
    "publishing",
    "failed",
  ] as ListingStatus[])("refuses %s status", async (status) => {
    const { deps, state } = fixture();
    state.status = status;
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "approval_required",
    });
  });

  it.each([
    ...CONFIRMATION_FIELD_KEYS.map(
      (key) => ["fieldConfirmations", key] as const,
    ),
    ...CONFIRMATION_NEGATIVE_KEYS.map(
      (key) => ["negativeConfirmations", key] as const,
    ),
  ])("refuses a revoked %s.%s confirmation", async (group, key) => {
    const { deps, confirmation } = fixture();
    confirmation[group][key] = false;
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "confirmation_required",
    });
  });

  it.each(["listingId", "versionId"] as const)(
    "refuses a ledger for another %s",
    async (key) => {
      const { deps, confirmation } = fixture();
      confirmation[key] = "foreign";
      expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
        ok: false,
        reason: "confirmation_required",
      });
    },
  );

  it("allows warnings and resolved blocking flags", async () => {
    const { deps, state } = fixture();
    state.flags = [
      {
        id: "flag_test",
        field: "title",
        rule: "health_claim",
        severity: "warning",
        status: "open",
        resolutionReason: null,
      },
      {
        id: "flag_test",
        field: "title",
        rule: "health_claim",
        severity: "blocking",
        status: "resolved",
        resolutionReason: "reviewed evidence",
      },
    ];
    expect(await checkBulkUpdateEligibility(input, deps)).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["status", "approval_required"],
    ["flag", "blocking_flags"],
  ])(
    "honors %s changes observed by the final state read",
    async (change, reason) => {
      const { deps, state } = fixture();
      let reads = 0;
      deps.getReviewState = async () => {
        if (++reads === 2) {
          if (change === "status") state.status = "in_review";
          else
            state.flags = [
              {
                id: "flag_test",
                field: "title",
                rule: "health_claim",
                severity: "blocking",
                status: "open",
                resolutionReason: null,
              },
            ];
        }
        return structuredClone(state);
      };
      expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it("honors a changed remote identity observed by the freshness link reread", async () => {
    const { deps, link } = fixture();
    let reads = 0;
    deps.getPlatformProductLink = async () => ({
      ...link,
      remoteProductId:
        ++reads === 1 ? link.remoteProductId : "different_product",
    });
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "remote_link_changed",
    });
  });

  it("honors confirmations revoked while freshness was being read", async () => {
    const { deps, confirmation } = fixture();
    deps.getSourceImportHeaderContractSha256 = async () => {
      confirmation.fieldConfirmations.nameZh = false;
      confirmation.revision += 1;
      return "header_test";
    };
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "confirmation_required",
    });
  });
  it("rejects an old approval with no durable receipt", async () => {
    const { deps } = fixture();
    deps.getApprovalReceipt = async () => null;
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "approval_binding_required",
    });
  });

  it("does not make a new checklist revision inherit an earlier approval", async () => {
    const { deps, confirmation } = fixture();
    confirmation.revision += 1;
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "confirmation_changed",
    });
  });

  it("rejects a reimport even after its new source has been fully reconfirmed", async () => {
    const { deps, link, confirmation } = fixture();
    link.sourceImportId = "import_new";
    confirmation.sourceImportId = "import_new";
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "approval_binding_changed",
    });
  });

  it("rejects pass-through source changes hidden behind an unchanged digest", async () => {
    const { deps, link } = fixture();
    link.rawRow.regularPrice = "999";
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "source_snapshot_mismatch",
    });
  });

  it("requires immutable source evidence rather than trusting the current mirror", async () => {
    const { deps } = fixture();
    deps.getSourceRow = async () => null;
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "source_snapshot_mismatch",
    });
  });

  it.each([
    "listingId",
    "versionId",
    "connectionId",
    "remoteProductId",
    "sourceSnapshotId",
    "specVersion",
    "headerContractSha256",
  ] as const)("rejects a mismatched receipt %s", async (key) => {
    const { deps, receipt } = fixture();
    receipt[key] = "other";
    expect((await checkBulkUpdateEligibility(input, deps)).ok).toBe(false);
  });

  it("honors receipt replacement at the final evidence boundary", async () => {
    const { deps, receipt } = fixture();
    const first = await checkBulkUpdateEligibility(input, deps);
    expect(first.ok).toBe(true);
    if (!first.ok) throw Error("fixture");
    receipt.id = "new_receipt";
    expect(
      await checkBulkUpdateEligibility(input, deps, first.evidence),
    ).toEqual({ ok: false, reason: "approval_binding_changed" });
  });
});

describe("promoted approval checklist ownership", () => {
  function promoted() {
    const f = fixture();
    f.receipt.confirmationVersionId = "reviewed_before_promotion";
    f.confirmation.versionId = "reviewed_before_promotion";
    return f;
  }
  it("retains the exact reviewed checklist until the promoted version gets its own checklist", async () => {
    const { deps, confirmation } = promoted();
    deps.getReviewConfirmation = async (id) =>
      id === input.versionId ? null : structuredClone(confirmation);
    expect((await checkBulkUpdateEligibility(input, deps)).ok).toBe(true);
  });
  it.each([false, true])(
    "requires renewed approval when a promoted-version checklist exists (confirmed=%s)",
    async (confirmed) => {
      const { deps, confirmation } = promoted();
      deps.getReviewConfirmation = async (id) =>
        id === input.versionId
          ? {
              ...structuredClone(confirmation),
              versionId: id,
              fieldConfirmations: { nameZh: confirmed },
            }
          : structuredClone(confirmation);
      expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
        ok: false,
        reason: "confirmation_changed",
      });
    },
  );
  it("rechecks promoted checklist creation at the final evidence boundary", async () => {
    const { deps, confirmation } = promoted();
    let currentExists = false;
    deps.getReviewConfirmation = async (id) =>
      id !== input.versionId
        ? structuredClone(confirmation)
        : currentExists
          ? {
              ...structuredClone(confirmation),
              versionId: id,
              fieldConfirmations: {},
            }
          : null;
    deps.getSourceImportHeaderContractSha256 = async () => {
      currentExists = true;
      return "header_test";
    };
    expect(await checkBulkUpdateEligibility(input, deps)).toEqual({
      ok: false,
      reason: "confirmation_changed",
    });
  });
});
