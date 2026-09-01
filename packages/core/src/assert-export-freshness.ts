import {
  assertContentFreshness,
  type ContentFreshnessDeps,
  type ContentFreshnessInput,
} from "./content-freshness.js";

export type { PlatformProductLink } from "./content-freshness.js";

export type AssertExportFreshnessDeps = ContentFreshnessDeps & {
  getSourceImportHeaderContractSha256(
    sourceImportId: string,
  ): Promise<string | null>;
  currentHeaderContractSha256(): string;
};

export type AssertExportFreshnessInput = ContentFreshnessInput & {
  /**
   * Not read by this function — every `deps` lookup is keyed by
   * `listingId`/`sourceImportId` alone. Carried on the input for interface
   * fidelity with the caller that will wire real deps in later: tenancy
   * scoping happens entirely by how that caller closes over a
   * workspace-bound transaction when constructing `AssertExportFreshnessDeps`
   * (the same pattern every `packages/db` repository uses), not by this
   * pure function checking the id itself.
   */
  workspaceId: string;
  /**
   * Must come from an explicit human attestation before an export, never
   * from a time-since-import comparison — the master instruction bars a
   * hard-coded freshness threshold until Opak approves a policy.
   */
  freshnessAttested: boolean;
};

export type FreshnessFailureReason =
  | "not_attested"
  | "no_remote_link"
  | "source_import_mismatch"
  | "row_digest_mismatch"
  | "version_mismatch"
  | "header_contract_stale";

export type FreshnessResult =
  { ok: true } | { ok: false; reason: FreshnessFailureReason };

/**
 * Gate a listing's SHOPLINE export against everything that must still be
 * true since it was imported. Deliberately does not touch Postgres directly
 * — a future export flow (not part of this package) supplies real deps.
 */
export async function assertExportFreshness(
  input: AssertExportFreshnessInput,
  deps: AssertExportFreshnessDeps,
): Promise<FreshnessResult> {
  if (!input.freshnessAttested) {
    return { ok: false, reason: "not_attested" };
  }

  const contentFreshness = await assertContentFreshness(input, deps);
  if (!contentFreshness.ok) {
    return contentFreshness;
  }

  const storedHeaderContractSha256 =
    await deps.getSourceImportHeaderContractSha256(
      input.expectedSourceImportId,
    );
  if (storedHeaderContractSha256 !== deps.currentHeaderContractSha256()) {
    return { ok: false, reason: "header_contract_stale" };
  }

  return { ok: true };
}
