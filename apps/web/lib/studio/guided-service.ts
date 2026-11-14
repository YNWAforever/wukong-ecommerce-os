import type { WorkspaceRepositories } from "@wukong/db";
import { ApiError } from "../route-support";
import { outputDigestMatches } from "./output-review";
import { outputPayloadDigest } from "./output-service";
import { buildStudioReadDeps } from "./read-deps";
import {
  gapReportPayloadSchema,
  merchantAuditPayloadSchema,
  type GapReportPayload,
} from "./report-payload";
import {
  GUIDED_REVIEW_VERSION,
  guidedListingSchema,
  guidedScopeSchema,
  type GuidedAction,
  type GuidedListing,
  type GuidedQuality,
  type GuidedScope,
} from "./guided-contracts";
import type { ListingGap } from "./tools";

export type PreparedGuidedReview = {
  kind: GuidedAction["kind"];
  listing: GuidedListing;
  rootRunId: string | null;
  parent: GuidedScope["parent"];
  quality: GuidedQuality | null;
};
function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}
export function guidedQualityFingerprint(
  listing: GuidedListing,
  assessmentVersion: string,
  gaps: readonly ListingGap[],
): GuidedQuality {
  const ordered = [...gaps]
    .map((gap) => ({ code: gap.code, blocking: gap.blocking }))
    .sort((a, b) =>
      a.code < b.code
        ? -1
        : a.code > b.code
          ? 1
          : Number(a.blocking) - Number(b.blocking),
    );
  return {
    assessmentVersion,
    gapsDigest: outputPayloadDigest({
      listing,
      assessmentVersion,
      gaps: ordered,
    }),
  };
}
export function qualityFromGapReport(
  report: GapReportPayload,
  listing: GuidedListing,
): GuidedQuality | null {
  const row = report.listings?.find(
    (entry) => entry.listingId === listing.listingId,
  );
  if (
    !row ||
    row.gaps === null ||
    !report.quality ||
    report.scope.mode !== "selected" ||
    report.listings?.length !== 1 ||
    row.activeVersion?.versionId !== listing.activeVersionId ||
    (row.activeVersion?.sequence ?? null) !== listing.activeVersionSequence
  )
    return null;
  return guidedQualityFingerprint(
    listing,
    report.quality.assessmentVersion,
    row.gaps,
  );
}
export async function currentGuidedQuality(
  repos: WorkspaceRepositories,
  listing: GuidedListing,
): Promise<GuidedQuality | null> {
  const reads = buildStudioReadDeps(repos);
  const quality = await reads.getQuality();
  const gaps = await reads.getListingGaps(listing.listingId);
  if (!gaps || !quality.assessmentVersion) return null;
  return guidedQualityFingerprint(
    listing,
    quality.assessmentVersion,
    gaps.gaps,
  );
}
async function currentListing(
  repos: WorkspaceRepositories,
  id: string,
): Promise<GuidedListing> {
  const value = await buildStudioReadDeps(repos).getListing(id);
  if (!value) throw new ApiError(404, "not_found", "Not found.");
  const parsed = guidedListingSchema.safeParse({
    listingId: value.listingId,
    activeVersionId: value.activeVersion?.versionId ?? null,
    activeVersionSequence: value.activeVersion?.sequence ?? null,
  });
  if (!parsed.success)
    conflict(
      "guided_listing_unavailable",
      "The listing version is unavailable. Reload the listing.",
    );
  return parsed.data;
}
function sameListing(a: GuidedListing, b: GuidedListing): boolean {
  return (
    a.listingId === b.listingId &&
    a.activeVersionId === b.activeVersionId &&
    a.activeVersionSequence === b.activeVersionSequence
  );
}
function sameQuality(
  a: GuidedQuality | null,
  b: GuidedQuality | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.assessmentVersion === b.assessmentVersion &&
    a.gapsDigest === b.gapsDigest
  );
}

/** Caller resolves the server session and validates target-thread visibility first. */
export async function prepareGuidedReview(input: {
  action: GuidedAction;
  threadId: string;
  repos: WorkspaceRepositories;
}): Promise<PreparedGuidedReview> {
  const { action, threadId, repos } = input;
  if (action.kind === "audit") {
    const listing = await currentListing(repos, action.listingId);
    if (listing.activeVersionId !== action.expectedActiveVersionId)
      conflict(
        "guided_source_stale",
        "The listing changed. Reload it before starting review.",
      );
    return {
      kind: action.kind,
      listing,
      rootRunId: null,
      parent: null,
      quality: null,
    };
  }
  const output = await repos.studio.outputs.get(action.sourceOutputId);
  // A transition stays in its original thread, including private conversations.
  if (!output || output.threadId !== threadId)
    throw new ApiError(404, "not_found", "Not found.");
  if (
    output.currentVersion !== action.sourceRevision ||
    output.status === "discarded"
  )
    conflict(
      "guided_source_stale",
      "The source artifact changed. Reload the conversation.",
    );
  const version = await repos.studio.outputs.getVersion(
    output.id,
    action.sourceRevision,
  );
  if (
    !version ||
    version.contentDigest !== action.sourceDigest ||
    !outputDigestMatches(version)
  )
    conflict(
      "guided_source_stale",
      "The source artifact changed. Reload the conversation.",
    );
  const parsed = guidedScopeSchema.safeParse(version.scope.guidedReview);
  const expectedStage = action.kind === "gap_review" ? "audit" : "gap_review";
  const expectedKind =
    action.kind === "gap_review" ? "merchant_audit" : "gap_report";
  if (
    !parsed.success ||
    parsed.data.stage !== expectedStage ||
    output.kind !== expectedKind ||
    !output.runId ||
    (expectedStage === "audit" && parsed.data.rootRunId !== output.runId)
  )
    conflict(
      "guided_source_invalid",
      "Start guided review from the listing screen.",
    );
  const scope = parsed.data;
  const listing = await currentListing(repos, scope.listing.listingId);
  if (!sameListing(listing, scope.listing))
    conflict(
      "guided_source_stale",
      "The listing changed. Refresh its gap review.",
    );
  if (action.kind === "gap_review") {
    if (!merchantAuditPayloadSchema.safeParse(version.payload).success)
      conflict("guided_source_invalid", "The audit snapshot is unavailable.");
    return {
      kind: action.kind,
      listing,
      rootRunId: scope.rootRunId,
      parent: {
        sourceOutputId: output.id,
        sourceRevision: version.revision,
        sourceDigest: version.contentDigest,
      },
      quality: null,
    };
  }
  if (listing.activeVersionId === null)
    conflict(
      "guided_listing_unavailable",
      "An active listing version is required for a copy proposal.",
    );
  const report = gapReportPayloadSchema.safeParse(version.payload);
  const recorded = report.success
    ? qualityFromGapReport(report.data, listing)
    : null;
  if (!recorded || !sameQuality(recorded, scope.quality))
    conflict(
      "guided_quality_unavailable",
      "The selected listing's quality evidence is unavailable. Refresh its gap review.",
    );
  const current = await currentGuidedQuality(repos, listing);
  if (!sameQuality(recorded, current))
    conflict(
      "guided_source_stale",
      "The quality assessment changed. Refresh its gap review.",
    );
  return {
    kind: action.kind,
    listing,
    rootRunId: scope.rootRunId,
    parent: {
      sourceOutputId: output.id,
      sourceRevision: version.revision,
      sourceDigest: version.contentDigest,
    },
    quality: recorded,
  };
}
export function guidedScopeForRun(
  context: PreparedGuidedReview,
  runId: string,
): GuidedScope {
  return guidedScopeSchema.parse({
    schemaVersion: GUIDED_REVIEW_VERSION,
    rootRunId: context.rootRunId ?? runId,
    stage: context.kind,
    listing: context.listing,
    parent: context.parent,
    quality: context.quality,
  });
}
export async function guidedFreshness(
  repos: WorkspaceRepositories,
  value: unknown,
): Promise<"current" | "stale" | "unavailable"> {
  const parsed = guidedScopeSchema.safeParse(value);
  if (!parsed.success) return "unavailable";
  const scope = parsed.data;
  const current = await buildStudioReadDeps(repos).getListing(
    scope.listing.listingId,
  );
  if (!current) return "unavailable";
  if (
    current.activeVersion?.versionId !==
      (scope.listing.activeVersionId ?? undefined) ||
    (current.activeVersion?.sequence ?? null) !==
      scope.listing.activeVersionSequence
  )
    return "stale";
  if (scope.stage !== "audit") {
    if (!scope.quality) return "unavailable";
    if (
      !sameQuality(
        scope.quality,
        await currentGuidedQuality(repos, scope.listing),
      )
    )
      return "stale";
  }
  return "current";
}
