export type PlatformProductLink = {
  sourceImportId: string | null;
  contentDigest: string | null;
};

export type AssertExportFreshnessDeps = {
  getPlatformProductLink(listingId: string): Promise<PlatformProductLink | null>;
  getActiveVersionId(listingId: string): Promise<string | null>;
  getSourceImportHeaderContractSha256(
    sourceImportId: string,
  ): Promise<string | null>;
  currentHeaderContractSha256(): string;
};

export type AssertExportFreshnessInput = {
  workspaceId: string;
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
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
  | { ok: true }
  | { ok: false; reason: FreshnessFailureReason };

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

  const link = await deps.getPlatformProductLink(input.listingId);
  if (link === null) {
    return { ok: false, reason: "no_remote_link" };
  }
  if (link.sourceImportId !== input.expectedSourceImportId) {
    return { ok: false, reason: "source_import_mismatch" };
  }
  if (link.contentDigest !== input.expectedRowDigest) {
    return { ok: false, reason: "row_digest_mismatch" };
  }

  const activeVersionId = await deps.getActiveVersionId(input.listingId);
  if (activeVersionId !== input.expectedVersionId) {
    return { ok: false, reason: "version_mismatch" };
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
