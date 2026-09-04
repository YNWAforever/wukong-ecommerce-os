import type { ComplianceFlag, ListingStatus } from "@wukong/core";
import {
  assertExportFreshness,
  type FreshnessFailureReason,
} from "@wukong/core";
import type { ReviewConfirmation } from "@wukong/db";
import { allConfirmed } from "./review-confirmation-keys";

export type BulkUpdateLink = {
  remoteProductId: string;
  rawRow: Record<string, string | null> | null;
  origin: "import" | "created";
  sourceImportId: string | null;
  contentDigest: string | null;
  connectionId: string;
};

export type BulkUpdateEligibilityReason =
  | FreshnessFailureReason
  | "approval_required"
  | "blocking_flags"
  | "confirmation_required"
  | "confirmation_changed"
  | "not_import_origin"
  | "remote_link_changed";

// Request-local evidence, NOT a durable approval receipt. A renewed checklist
// cannot prove which source or ledger revision was approved (continuation Task 3).
export type BulkUpdateEvidence = {
  listingId: string;
  versionId: string;
  confirmationRevision: number;
  sourceImportId: string;
  rowDigest: string;
  remoteProductId: string;
  connectionId: string;
};

export type BulkUpdateEligibilityDeps = {
  getReviewState(listingId: string): Promise<{
    status: ListingStatus;
    activeVersionId: string | null;
    flags: ComplianceFlag[];
  } | null>;
  getReviewConfirmation(versionId: string): Promise<ReviewConfirmation | null>;
  getPlatformProductLink(listingId: string): Promise<BulkUpdateLink | null>;
  getSourceImportHeaderContractSha256(
    sourceImportId: string,
  ): Promise<string | null>;
  currentHeaderContractSha256(): string;
};

export type BulkUpdateEligibilityResult =
  | { ok: true; evidence: BulkUpdateEvidence; link: BulkUpdateLink }
  | { ok: false; reason: BulkUpdateEligibilityReason };

function reviewStateFailure(
  state: Awaited<ReturnType<BulkUpdateEligibilityDeps["getReviewState"]>>,
  versionId: string,
): BulkUpdateEligibilityReason | null {
  if (!state || state.activeVersionId !== versionId) return "version_mismatch";
  if (state.status !== "approved" && state.status !== "published")
    return "approval_required";
  if (
    state.flags.some(
      (flag) => flag.severity === "blocking" && flag.status === "open",
    )
  )
    return "blocking_flags";
  return null;
}

function confirmationMatches(
  confirmation: ReviewConfirmation | null,
  input: { listingId: string; versionId: string },
): confirmation is ReviewConfirmation {
  return (
    !!confirmation &&
    confirmation.listingId === input.listingId &&
    confirmation.versionId === input.versionId &&
    allConfirmed(
      confirmation.fieldConfirmations,
      confirmation.negativeConfirmations,
    )
  );
}

export async function checkBulkUpdateEligibility(
  input: {
    workspaceId: string;
    listingId: string;
    versionId: string;
    freshnessAttested: boolean;
  },
  deps: BulkUpdateEligibilityDeps,
  expected?: BulkUpdateEvidence,
): Promise<BulkUpdateEligibilityResult> {
  const state = await deps.getReviewState(input.listingId);
  const stateFailure = reviewStateFailure(state, input.versionId);
  if (stateFailure) return { ok: false, reason: stateFailure };
  if (
    expected &&
    (expected.listingId !== input.listingId ||
      expected.versionId !== input.versionId)
  )
    return { ok: false, reason: "version_mismatch" };
  const confirmation = await deps.getReviewConfirmation(input.versionId);
  if (!confirmationMatches(confirmation, input))
    return { ok: false, reason: "confirmation_required" };
  if (expected && confirmation.revision !== expected.confirmationRevision) {
    return { ok: false, reason: "confirmation_changed" };
  }
  const link = await deps.getPlatformProductLink(input.listingId);
  if (
    !link ||
    link.origin !== "import" ||
    !link.remoteProductId ||
    !link.connectionId
  ) {
    return { ok: false, reason: "not_import_origin" };
  }
  if (
    !link.sourceImportId ||
    confirmation.sourceImportId !== link.sourceImportId ||
    (expected && link.sourceImportId !== expected.sourceImportId)
  ) {
    return { ok: false, reason: "source_import_mismatch" };
  }
  if (
    !link.contentDigest ||
    confirmation.rowDigest !== link.contentDigest ||
    (expected && link.contentDigest !== expected.rowDigest)
  ) {
    return { ok: false, reason: "row_digest_mismatch" };
  }
  if (
    expected &&
    (link.remoteProductId !== expected.remoteProductId ||
      link.connectionId !== expected.connectionId)
  ) {
    return { ok: false, reason: "remote_link_changed" };
  }
  let latestState = state;
  let latestLink: BulkUpdateLink | null = link;
  const freshness = await assertExportFreshness(
    {
      workspaceId: input.workspaceId,
      listingId: input.listingId,
      expectedVersionId: input.versionId,
      expectedSourceImportId: link.sourceImportId,
      expectedRowDigest: link.contentDigest,
      freshnessAttested: input.freshnessAttested,
    },
    {
      ...deps,
      getPlatformProductLink: async (listingId) => {
        latestLink = await deps.getPlatformProductLink(listingId);
        return latestLink;
      },
      getActiveVersionId: async (listingId) => {
        latestState = await deps.getReviewState(listingId);
        return latestState?.activeVersionId ?? null;
      },
    },
  );
  if (!freshness.ok) return freshness;
  // Honor the complete values observed by the freshness rereads, including
  // same-version review changes and link identity, not only the digest/version.
  const latestFailure = reviewStateFailure(latestState, input.versionId);
  if (latestFailure) return { ok: false, reason: latestFailure };
  if (!latestLink || latestLink.origin !== "import")
    return { ok: false, reason: "not_import_origin" };
  if (
    latestLink.remoteProductId !== link.remoteProductId ||
    latestLink.connectionId !== link.connectionId
  )
    return { ok: false, reason: "remote_link_changed" };
  const latestConfirmation = await deps.getReviewConfirmation(input.versionId);
  if (!confirmationMatches(latestConfirmation, input))
    return { ok: false, reason: "confirmation_required" };
  if (latestConfirmation.revision !== confirmation.revision)
    return { ok: false, reason: "confirmation_changed" };
  if (latestConfirmation.sourceImportId !== link.sourceImportId)
    return { ok: false, reason: "source_import_mismatch" };
  if (latestConfirmation.rowDigest !== link.contentDigest)
    return { ok: false, reason: "row_digest_mismatch" };
  return {
    ok: true,
    link,
    evidence: {
      listingId: input.listingId,
      versionId: input.versionId,
      confirmationRevision: confirmation.revision,
      sourceImportId: link.sourceImportId,
      rowDigest: link.contentDigest,
      remoteProductId: link.remoteProductId,
      connectionId: link.connectionId,
    },
  };
}
