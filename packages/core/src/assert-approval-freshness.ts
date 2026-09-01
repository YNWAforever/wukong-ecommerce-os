import {
  assertContentFreshness,
  type ContentFreshnessDeps,
  type ContentFreshnessFailureReason,
  type ContentFreshnessInput,
} from "./content-freshness.js";

export type AssertApprovalFreshnessDeps = ContentFreshnessDeps;

export type AssertApprovalFreshnessInput = ContentFreshnessInput & {
  /**
   * Not read by this function — every `deps` lookup is keyed by
   * `listingId`/`sourceImportId` alone. Carried on the input for interface
   * fidelity with the caller that will wire real deps in later: tenancy
   * scoping happens entirely by how that caller closes over a
   * workspace-bound transaction when constructing `AssertApprovalFreshnessDeps`
   * (the same pattern every `packages/db` repository uses), not by this
   * pure function checking the id itself.
   */
  workspaceId: string;
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
