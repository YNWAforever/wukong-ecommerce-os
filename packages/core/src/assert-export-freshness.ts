export type PlatformProductLink = {
  sourceImportId: string | null;
  contentDigest: string | null;
};

export type AssertExportFreshnessDeps = {
  getPlatformProductLink(
    listingId: string,
  ): Promise<PlatformProductLink | null>;
  getActiveVersionId(listingId: string): Promise<string | null>;
  getSourceImportHeaderContractSha256(
    sourceImportId: string,
  ): Promise<string | null>;
  currentHeaderContractSha256(): string;
};

export type AssertExportFreshnessInput = {
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
  listingId: string;
  expectedSourceImportId: string;
  /** Compared against `PlatformProductLink.contentDigest` — same value, named from the caller's point of expectation rather than the port's point of storage. */
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
  { ok: true } | { ok: false; reason: FreshnessFailureReason };

export type ContentFreshnessInput = {
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
};

export type ContentFreshnessDeps = {
  getPlatformProductLink(
    listingId: string,
  ): Promise<PlatformProductLink | null>;
  getActiveVersionId(listingId: string): Promise<string | null>;
};

export type ContentFreshnessFailureReason =
  | "no_remote_link"
  | "source_import_mismatch"
  | "row_digest_mismatch"
  | "version_mismatch";

export type ContentFreshnessResult =
  { ok: true } | { ok: false; reason: ContentFreshnessFailureReason };

/**
 * The four checks shared by `assertExportFreshness` (which adds an
 * attestation gate and a header-contract check on top, for the export
 * moment) and `assertApprovalFreshness` (which uses only this core, for the
 * approval moment) — kept in one place so the two gates can never silently
 * drift on what "the content still matches" means.
 */
export async function assertContentFreshness(
  input: ContentFreshnessInput,
  deps: ContentFreshnessDeps,
): Promise<ContentFreshnessResult> {
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

  return { ok: true };
}

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
