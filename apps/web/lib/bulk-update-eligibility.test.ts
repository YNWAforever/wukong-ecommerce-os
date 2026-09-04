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
  const confirmation = {
    id: "confirmation_test",
    listingId: input.listingId,
    versionId: input.versionId,
    revision: 3,
    sourceImportId: "import_test",
    rowDigest: "digest_test",
    fieldConfirmations: Object.fromEntries(
      CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
    ),
    negativeConfirmations: Object.fromEntries(
      CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
    ),
  };
  const link = {
    remoteProductId: "remote_test",
    rawRow: null,
    origin: "import" as const,
    connectionId: "connection_test",
    sourceImportId: "import_test",
    contentDigest: "digest_test",
  };
  const deps: BulkUpdateEligibilityDeps = {
    getReviewState: async () => structuredClone(state),
    getReviewConfirmation: async () => structuredClone(confirmation),
    getPlatformProductLink: async () => structuredClone(link),
    getSourceImportHeaderContractSha256: async () => "header_test",
    currentHeaderContractSha256: () => "header_test",
  };
  return { deps, state, confirmation, link };
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
});
