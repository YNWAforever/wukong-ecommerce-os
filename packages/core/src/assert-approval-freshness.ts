import {
  assertContentFreshness,
  type ContentFreshnessDeps,
  type ContentFreshnessFailureReason,
} from "./assert-export-freshness.js";

export type AssertApprovalFreshnessDeps = ContentFreshnessDeps;

export type AssertApprovalFreshnessInput = {
  workspaceId: string;
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
};

export type ApprovalFreshnessFailureReason = ContentFreshnessFailureReason;

export type ApprovalFreshnessResult =
  { ok: true } | { ok: false; reason: ApprovalFreshnessFailureReason };

/**
 * Gate an approval against the listing's source content having drifted
 * since review started — the same identity/content checks
 * `assertExportFreshness` performs, without that function's attestation
 * gate (which means "a human confirmed this export specifically", not
 * relevant at approval time) or its header-contract check (an export-time
 * system-integrity check).
 */
export async function assertApprovalFreshness(
  input: AssertApprovalFreshnessInput,
  deps: AssertApprovalFreshnessDeps,
): Promise<ApprovalFreshnessResult> {
  return assertContentFreshness(input, deps);
}
