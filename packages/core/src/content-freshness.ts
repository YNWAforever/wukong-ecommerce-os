export type PlatformProductLink = {
  sourceImportId: string | null;
  contentDigest: string | null;
};

export type ContentFreshnessInput = {
  listingId: string;
  expectedSourceImportId: string;
  /** Compared against `PlatformProductLink.contentDigest` — same value, named from the caller's point of expectation rather than the port's point of storage. */
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
 * approval moment) — kept in one neutral module, depended on by both gates
 * equally, so they can never silently drift on what "the content still
 * matches" means.
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
