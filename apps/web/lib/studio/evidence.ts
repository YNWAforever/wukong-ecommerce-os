import type { SkillDefinition, StudioRole, SourceKind } from "@wukong/core";

import type { StudioTurnLimits } from "./turn-limits";
import {
  runStudioTool,
  type ListingAssetEvidence,
  type ListingCopySnapshot,
  type ProductShotAttemptEvidence,
  type StudioReadDeps,
  type SupplierWorkbookEvidence,
  type ToolRun,
} from "./tools";
import {
  coverageMap,
  coverageRecord,
  translatedLine,
  type EvidenceCheck,
  type EvidenceCoverage,
  type EvidencePack,
  type EvidenceSource,
  type NeedsInput,
  type StudioTraceStep,
} from "./types";
import {
  merchantAuditPayloadSchema,
  type MerchantAuditPayload,
  type GapReportPayload,
} from "./report-payload";
import {
  auditPeriodPayload,
  isWithinAuditPeriod,
  mentionsUnparseablePeriod,
  parseAuditPeriod,
} from "./audit-period";
import type { CategoryMapContext } from "./category-map";
import {
  productShotAttemptFacts,
  productShotLimitations,
  splitProductShotAssets,
  type ProductShotPrepareContext,
} from "./product-shot";
import type { SupplierIntelContext } from "./supplier-intel";
import { CATALOG_QUERY_REF, type CatalogFacts } from "./catalog-facts";

/**
 * Deterministic evidence assembly (plan Task 5, spec section 3.3).
 *
 * The pack is built from canonical records only. A tool that cannot answer
 * marks the source `missing`/`unsupported` with a limitation; nothing here
 * guesses, interpolates or turns unknown into zero.
 */

export type BuildEvidenceInput = {
  skill: SkillDefinition;
  deps: StudioReadDeps;
  role: StudioRole;
  now: Date;
  query: string | null;
  listingIds?: readonly string[];
  listingId?: string | null;
  /** Source asset ids the operator attached to the turn (plan Task 10). */
  attachmentAssetIds?: readonly string[];
  /** Optional hard budgets for this turn (plan Task 14). */
  limits?: StudioTurnLimits;
  limit?: number;
};

export type BuildEvidenceResult =
  { status: "complete"; pack: EvidencePack } | NeedsInput;

const MAX_LISTINGS = 20;
const FOCUS_LISTINGS = 3;

function asOf(now: Date): string {
  return now.toISOString();
}

function markCoverage(
  pack: EvidencePack,
  kind: SourceKind,
  coverage: EvidenceCoverage,
): void {
  pack.coverage.set(kind, coverage);
}

function pushSource(
  pack: EvidencePack,
  source: Omit<EvidenceSource, "asOf" | "restricted">,
  now: Date,
): void {
  pack.sources.push({ ...source, asOf: asOf(now), restricted: false });
}

function pushCheck(
  pack: EvidencePack,
  check: Omit<EvidenceCheck, "values"> & {
    values?: EvidenceCheck["values"];
  },
): void {
  pack.checks.push({ ...check, values: check.values ?? {} });
}

function pushLimitation(
  pack: EvidencePack,
  key: string,
  values: Record<string, string | number | boolean> = {},
): void {
  pack.limitations.push(translatedLine(key, values));
}

async function callTool(
  pack: EvidencePack,
  input: {
    toolId: string;
    rawInput: unknown;
    deps: StudioReadDeps;
    role: StudioRole;
    limits?: StudioTurnLimits;
  },
): Promise<ToolRun> {
  input.limits?.beginTool(input.toolId);
  const run = await runStudioTool({
    toolId: input.toolId,
    rawInput: input.rawInput,
    role: input.role,
    deps: input.deps,
  });
  input.limits?.assertActive();
  const step: StudioTraceStep = {
    kind: "tool",
    toolId: input.toolId,
    state: run.state,
    durationMs: null,
    detail: run.detail,
  };
  pack.trace.push(step);
  return run;
}

function catalogSource(now: Date, listingId: string, title: string) {
  return {
    ref: `catalog:${listingId}`,
    kind: "catalog" as const,
    label: title.slice(0, 300),
    refId: listingId,
    version: null,
    coverage: "present" as const,
    deepLink: `/listings/${listingId}`,
    ...{ asOf: asOf(now), restricted: false },
  } satisfies EvidenceSource;
}

async function buildCatalogFind(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const query = input.query?.trim() ?? "";
  if (!query) throw new Error("query required before build");
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const search = await callTool(pack, {
    toolId: "catalog.search",
    rawInput: { query, limit },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (search.state !== "done") {
    pushLimitation(pack, "studio.limit.catalog_unavailable");
    return;
  }
  const hits = search.output as {
    items: Array<{ listingId: string; title: string; status: string }>;
    truncated: boolean;
  };
  markCoverage(pack, "catalog", "present");
  pushSource(
    pack,
    {
      ref: CATALOG_QUERY_REF,
      kind: "catalog",
      label: query,
      refId: query,
      version: null,
      coverage: "present",
      deepLink: "/catalog",
    },
    input.now,
  );
  pushCheck(pack, {
    key: "studio.check.catalog_query",
    values: { query },
    state: "ok",
  });
  const facts: CatalogFacts = {
    query: { text: query, evidenceRef: CATALOG_QUERY_REF },
    catalogRecords: hits.items.slice(0, 5).map((hit) => ({
      evidenceRef: `catalog:${hit.listingId}`,
      listingId: hit.listingId,
      title: hit.title.slice(0, 200),
      status: hit.status.slice(0, 40),
    })),
    jobs: [],
  };
  pack.context.catalogFacts = facts;
  for (const record of facts.catalogRecords)
    pushCheck(pack, {
      key: "studio.check.catalog_record",
      values: {
        listingId: record.listingId,
        title: record.title,
        status: record.status,
      },
      state: "ok",
    });
  pushCheck(pack, {
    key: "studio.check.catalog_matches",
    values: { count: hits.items.length, truncated: hits.truncated },
    state: "ok",
  });
  for (const hit of hits.items) {
    const source = catalogSource(input.now, hit.listingId, hit.title);
    pack.sources.push(source);
  }
  if (hits.items.length === 0) {
    // A real counted zero, not a missing source: there is no listing to read.
    markCoverage(pack, "listing", "unsupported");
  }

  const focus = hits.items.slice(0, FOCUS_LISTINGS);
  for (const hit of focus) {
    const detail = await callTool(pack, {
      toolId: "catalog.get",
      rawInput: { listingId: hit.listingId },
      deps: input.deps,
      role: input.role,
      limits: input.limits,
    });
    if (detail.state !== "done") {
      pushLimitation(pack, "studio.limit.listing_unavailable", {
        listingId: hit.listingId,
      });
      continue;
    }
    const listing = detail.output as {
      listingId: string;
      status: string;
      title: string;
      activeVersion: { versionId: string; sequence: number } | null;
    };
    markCoverage(pack, "listing", "present");
    pushSource(
      pack,
      {
        ref: `listing:${listing.listingId}:${
          listing.activeVersion ? `v${listing.activeVersion.sequence}` : "none"
        }`,
        kind: "listing",
        label: listing.title.slice(0, 300),
        refId: listing.listingId,
        version: listing.activeVersion
          ? String(listing.activeVersion.sequence)
          : null,
        coverage: "present",
        deepLink: `/listings/${listing.listingId}`,
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.listing_status",
      values: {
        listingId: listing.listingId,
        status: listing.status,
        activeVersion: listing.activeVersion ? "present" : "none",
      },
      state: "ok",
    });
  }

  // Per-listing content gaps stay in the reviewed tool plane.
  if (focus.length > 0) {
    const gaps = await callTool(pack, {
      toolId: "quality.get_gaps",
      rawInput: { listingIds: focus.map((hit) => hit.listingId) },
      deps: input.deps,
      role: input.role,
      limits: input.limits,
    });
    if (gaps.state !== "done")
      pushLimitation(pack, "studio.limit.quality_unavailable");
    else markCoverage(pack, "quality", "present");
  }

  // The workspace quality aggregate is a deterministic summary read; it is
  // evidence, never a tool-requestable action.
  try {
    const quality = await input.deps.getQuality();
    markCoverage(pack, "quality", "present");
    pushSource(
      pack,
      {
        ref: `quality:${quality.assessmentVersion}`,
        kind: "quality",
        label: quality.assessmentVersion,
        refId: quality.assessmentVersion,
        version: quality.assessmentVersion,
        coverage: "present",
        deepLink: "/quality",
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.quality_summary",
      values: {
        totalListings: quality.totalListings,
        totalAssessed: quality.totalAssessed,
        cleanCount: quality.cleanCount,
        hasGapsCount: quality.hasGapsCount,
        projectionState: quality.projectionState,
      },
      state:
        quality.projectionState === "ready"
          ? "ok"
          : quality.projectionState === "pending"
            ? "gap"
            : "missing",
    });
  } catch {
    pushLimitation(pack, "studio.limit.quality_unavailable");
  }

  const jobs = await callTool(pack, {
    toolId: "jobs.list",
    rawInput: { limit: 5 },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (jobs.state === "done") {
    const listed = jobs.output as {
      items: Array<{ jobId: string; state: string; createdAt: string }>;
    };
    markCoverage(pack, "job", "present");
    pushCheck(pack, {
      key: "studio.check.recent_jobs",
      values: { count: listed.items.length },
      state: "ok",
    });
    facts.jobs = listed.items.slice(0, 5).map((job) => ({
      evidenceRef: `job:${job.jobId}`,
      jobId: job.jobId,
      state: job.state.slice(0, 40),
      createdAt: job.createdAt.slice(0, 64),
    }));
    for (const job of facts.jobs)
      pushCheck(pack, {
        key: "studio.check.recent_job",
        values: {
          jobId: job.jobId,
          state: job.state,
          createdAt: job.createdAt,
        },
        state: "ok",
      });
    for (const job of facts.jobs)
      pushSource(
        pack,
        {
          ref: job.evidenceRef,
          kind: "job",
          label: job.state,
          refId: job.jobId,
          version: null,
          coverage: "present",
          deepLink: "/jobs",
        },
        input.now,
      );
  } else pushLimitation(pack, "studio.limit.jobs_unavailable");

  if (hits.truncated) pushLimitation(pack, "studio.limit.results_truncated");
}

async function buildGapReview(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const allRequested = [...new Set(input.listingIds ?? [])];
  const requested = allRequested.slice(0, MAX_LISTINGS);
  let targets = requested;
  const rows: NonNullable<GapReportPayload["listings"]> = [];
  const report: GapReportPayload = {
    schemaVersion: "wukong-gap-report/v1",
    asOf: asOf(input.now),
    scope: {
      mode: requested.length > 0 ? "selected" : "workspace_sample",
      listingIds: requested,
      truncated:
        requested.length > 0 ? allRequested.length > requested.length : null,
    },
    listings: requested.length > 0 ? rows : null,
    quality: null,
    checks: [],
    evidenceTruncated: false,
    coverage: {},
    limitations: [],
  };
  pack.context.gapReport = report;
  // With an explicit selection this turn does not query the catalog at all, so
  // the source is not applicable rather than missing.
  if (requested.length > 0) markCoverage(pack, "catalog", "unsupported");
  if (targets.length === 0) {
    const search = await callTool(pack, {
      toolId: "catalog.search",
      rawInput: { limit: MAX_LISTINGS },
      deps: input.deps,
      role: input.role,
      limits: input.limits,
    });
    if (search.state !== "done") {
      pushLimitation(pack, "studio.limit.catalog_unavailable");
      return;
    }
    const hits = search.output as {
      items: Array<{ listingId: string; title: string }>;
      truncated: boolean;
    };
    markCoverage(pack, "catalog", "present");
    for (const hit of hits.items)
      pack.sources.push(catalogSource(input.now, hit.listingId, hit.title));
    targets = hits.items.map((hit) => hit.listingId);
    report.listings = rows;
    report.scope.truncated = hits.truncated;
    if (hits.truncated) pushLimitation(pack, "studio.limit.results_truncated");
  }

  for (const listingId of targets) {
    const detail = await callTool(pack, {
      toolId: "catalog.get",
      rawInput: { listingId },
      deps: input.deps,
      role: input.role,
      limits: input.limits,
    });
    if (detail.state !== "done") {
      pushLimitation(pack, "studio.limit.listing_unavailable", { listingId });
      rows.push({
        listingId,
        title: null,
        status: null,
        activeVersion: null,
        gaps: null,
      });
      continue;
    }
    const listing = detail.output as {
      listingId: string;
      status: string;
      title: string;
      activeVersion: { versionId: string; sequence: number } | null;
    };
    rows.push({
      listingId: listing.listingId,
      title: listing.title.slice(0, 300),
      status: listing.status,
      activeVersion: listing.activeVersion,
      gaps: null,
    });
    markCoverage(pack, "listing", "present");
    pushSource(
      pack,
      {
        ref: `listing:${listing.listingId}:${
          listing.activeVersion ? `v${listing.activeVersion.sequence}` : "none"
        }`,
        kind: "listing",
        label: listing.title.slice(0, 300),
        refId: listing.listingId,
        version: listing.activeVersion
          ? String(listing.activeVersion.sequence)
          : null,
        coverage: "present",
        deepLink: `/listings/${listing.listingId}`,
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.listing_status",
      values: {
        listingId: listing.listingId,
        status: listing.status,
        activeVersion: listing.activeVersion ? "present" : "none",
      },
      state:
        listing.status === "approved" || listing.status === "published"
          ? "ok"
          : "gap",
    });
  }

  if (targets.length > 0) {
    const gaps = await callTool(pack, {
      toolId: "quality.get_gaps",
      rawInput: { listingIds: targets.slice(0, 50) },
      deps: input.deps,
      role: input.role,
      limits: input.limits,
    });
    if (gaps.state !== "done") {
      pushLimitation(pack, "studio.limit.quality_unavailable");
    } else {
      const output = gaps.output as {
        gaps: Array<{ listingId: string; code: string; blocking: boolean }>;
      };
      markCoverage(pack, "quality", "present");
      for (const row of rows)
        row.gaps = output.gaps
          .filter((gap) => gap.listingId === row.listingId)
          .map((gap) => ({ code: gap.code, blocking: gap.blocking }));
      for (const gap of output.gaps)
        pushCheck(pack, {
          key: "studio.check.content_gap",
          values: {
            listingId: gap.listingId,
            code: gap.code,
            blocking: gap.blocking,
          },
          state: gap.blocking ? "missing" : "gap",
        });
    }
  }

  try {
    const quality = await input.deps.getQuality();
    report.quality = {
      assessmentVersion: quality.assessmentVersion,
      projectionState: quality.projectionState,
      asOf: quality.asOf,
    };
    markCoverage(pack, "quality", "present");
    pushSource(
      pack,
      {
        ref: `quality:${quality.assessmentVersion}`,
        kind: "quality",
        label: quality.assessmentVersion,
        refId: quality.assessmentVersion,
        version: quality.assessmentVersion,
        coverage: "present",
        deepLink: "/quality",
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.quality_summary",
      values: {
        totalListings: quality.totalListings,
        totalAssessed: quality.totalAssessed,
        cleanCount: quality.cleanCount,
        hasGapsCount: quality.hasGapsCount,
        noActiveVersion: quality.noActiveVersion,
        projectionState: quality.projectionState,
      },
      state: quality.projectionState === "ready" ? "ok" : "missing",
    });
  } catch {
    pushLimitation(pack, "studio.limit.quality_unavailable");
  }

  const jobs = await callTool(pack, {
    toolId: "jobs.list",
    rawInput: { limit: 10 },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (jobs.state === "done") {
    const listed = jobs.output as { items: Array<{ jobId: string }> };
    markCoverage(pack, "job", "present");
    pushCheck(pack, {
      key: "studio.check.recent_jobs",
      values: { count: listed.items.length },
      state: "ok",
    });
  } else pushLimitation(pack, "studio.limit.jobs_unavailable");

  // The export ledger is not read by this v1 skill; say so instead of implying
  // there are no export attempts.
  pushLimitation(pack, "studio.limit.exports_not_read");
}

function pushFollowUps(pack: EvidencePack, skillKey: string): void {
  if (skillKey === "catalog.find") {
    pack.followUps.push(translatedLine("studio.followup.explain_status"));
    pack.followUps.push(translatedLine("studio.followup.review_gaps"));
  } else if (skillKey === "listing.copy_proposal") {
    pack.followUps.push(translatedLine("studio.followup.open_listing"));
    pack.followUps.push(translatedLine("studio.followup.review_gaps"));
  } else if (skillKey === "listing.draft_from_sources") {
    pack.followUps.push(translatedLine("studio.followup.confirm_dispatch"));
    pack.followUps.push(translatedLine("studio.followup.open_jobs"));
  } else if (skillKey === "merchant.audit") {
    pack.followUps.push(translatedLine("studio.followup.audit_export"));
  } else if (skillKey === "category.map_proposal") {
    pack.followUps.push(translatedLine("studio.followup.category_review"));
  } else if (skillKey === "product_shot.prepare") {
    pack.followUps.push(translatedLine("studio.followup.product_shot_review"));
  } else {
    pack.followUps.push(translatedLine("studio.followup.list_attention"));
    pack.followUps.push(translatedLine("studio.followup.open_listing"));
  }
}

/** A UUID token, used to read asset ids pinned in the operator's message. */
const UUID_TOKEN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const UUID_EXACT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Source asset ids for a draft turn (plan Task 10).
 *
 * The composer attachment flow supplies `attachmentAssetIds`; until that UI
 * ships, an operator can also pin asset ids in the message text. Both are
 * bounded to the reviewed eight, de-duplicated, and never read from anywhere
 * else. Returns an empty list when the turn names none.
 */
export function draftAssetIds(input: {
  attachmentAssetIds?: readonly string[];
  query: string | null;
}): string[] {
  const explicit = (input.attachmentAssetIds ?? []).filter((id) =>
    UUID_EXACT.test(id),
  );
  if (explicit.length > 0)
    return [...new Set(explicit.map((id) => id.toLowerCase()))].slice(0, 8);
  UUID_TOKEN.lastIndex = 0;
  const matches = (input.query ?? "").match(UUID_TOKEN) ?? [];
  UUID_TOKEN.lastIndex = 0;
  return [...new Set(matches.map((id) => id.toLowerCase()))].slice(0, 8);
}

/**
 * Draft-from-sources evidence (plan Task 10).
 *
 * Reads the operator's source assets inside the workspace and records exactly
 * what an explicit dispatch would send. It performs no writes and starts no
 * pipeline: the turn only prepares a dispatch-ready reference, and the reviewed
 * dispatch route creates the canonical listing after the operator confirms.
 */
async function buildDraftFromSources(
  input: BuildEvidenceInput,
  pack: EvidencePack,
  assetIds: readonly string[],
): Promise<void> {
  const resolved = await input.deps.getSourceAssets(assetIds);
  for (const asset of resolved.items) {
    markCoverage(pack, "source_import", "present");
    pushSource(
      pack,
      {
        ref: `asset:${asset.assetId}`,
        kind: "source_import",
        label: asset.contentType,
        refId: asset.assetId,
        version: null,
        coverage: "present",
        // Assets have no operator-facing record screen; never invent a link.
        deepLink: null,
      },
      input.now,
    );
  }
  if (resolved.items.length === 0)
    pushLimitation(pack, "studio.limit.draft_assets_missing", {
      count: resolved.missingAssetIds.length,
    });
  else if (resolved.missingAssetIds.length > 0)
    pushLimitation(pack, "studio.limit.draft_assets_missing", {
      count: resolved.missingAssetIds.length,
    });

  const attached = resolved.items.filter(
    (asset) => asset.listingId !== null,
  ).length;
  pushCheck(pack, {
    key: "studio.check.draft_assets",
    values: {
      count: resolved.items.length,
      missing: resolved.missingAssetIds.length,
      attached,
    },
    state:
      resolved.missingAssetIds.length > 0 || attached > 0
        ? "gap"
        : resolved.items.length > 0
          ? "ok"
          : "missing",
  });

  pack.trace.push({
    kind: "evidence",
    toolId: null,
    state: "done",
    durationMs: null,
    detail: translatedLine("studio.trace.assets_read", {
      count: resolved.items.length,
    }),
  });

  const dispatchAssetIds = resolved.items.map((asset) => asset.assetId);
  pack.context.draftDispatch =
    dispatchAssetIds.length > 0
      ? {
          kind: "listing_draft",
          assetIds: dispatchAssetIds,
          note: input.query?.trim() ? input.query.trim().slice(0, 2000) : null,
          ready: resolved.missingAssetIds.length === 0 && attached === 0,
        }
      : null;
}

/** Editable copy fields and where each current value lives in the snapshot. */
const COPY_FIELDS: ReadonlyArray<{
  field: string;
  value: (copy: ListingCopySnapshot) => string;
}> = [
  { field: "title.en", value: (copy) => copy.title.en },
  { field: "title.zh-Hant", value: (copy) => copy.title["zh-Hant"] },
  { field: "description.en", value: (copy) => copy.description.en },
  {
    field: "description.zh-Hant",
    value: (copy) => copy.description["zh-Hant"],
  },
  { field: "seo.title.en", value: (copy) => copy.seo.title.en },
  {
    field: "seo.title.zh-Hant",
    value: (copy) => copy.seo.title["zh-Hant"],
  },
  {
    field: "seo.description.en",
    value: (copy) => copy.seo.description.en,
  },
  {
    field: "seo.description.zh-Hant",
    value: (copy) => copy.seo.description["zh-Hant"],
  },
];

/**
 * Copy-proposal evidence (plan Task 9).
 *
 * The reviewed listing version and its current copy are read deterministically
 * and recorded as the immutable proposal target. The model may only propose
 * fields against this snapshot; the turn service persists the result as a
 * versioned artifact and never writes canonical listing data.
 */
async function buildCopyProposal(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  let observedGaps: Array<{ code: string; blocking: boolean }> | null = null;
  let observedAssessmentVersion: string | null = null;
  const listingId = input.listingId;
  if (!listingId) return;
  const detail = await callTool(pack, {
    toolId: "catalog.get",
    rawInput: { listingId },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (detail.state !== "done") {
    pushLimitation(pack, "studio.limit.listing_unavailable", { listingId });
  } else {
    const listing = detail.output as {
      listingId: string;
      status: string;
      title: string;
      activeVersion: { versionId: string; sequence: number } | null;
    };
    markCoverage(pack, "listing", "present");
    pushSource(
      pack,
      {
        ref: `listing:${listing.listingId}:${
          listing.activeVersion ? `v${listing.activeVersion.sequence}` : "none"
        }`,
        kind: "listing",
        label: listing.title.slice(0, 300),
        refId: listing.listingId,
        version: listing.activeVersion
          ? String(listing.activeVersion.sequence)
          : null,
        coverage: "present",
        deepLink: `/listings/${listing.listingId}`,
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.listing_status",
      values: {
        listingId: listing.listingId,
        status: listing.status,
        activeVersion: listing.activeVersion ? "present" : "none",
      },
      state: listing.activeVersion ? "ok" : "gap",
    });
  }

  let copy: ListingCopySnapshot | null = null;
  try {
    copy = await input.deps.getListingCopy(listingId);
  } catch {
    copy = null;
  }
  if (!copy) {
    pushLimitation(pack, "studio.limit.copy_unavailable");
    return;
  }
  markCoverage(pack, "listing", "present");
  pushSource(
    pack,
    {
      ref: `listing-copy:${copy.listingId}:v${copy.activeVersionSequence}`,
      kind: "listing",
      label: copy.title.en || copy.title["zh-Hant"],
      refId: copy.listingId,
      version: String(copy.activeVersionSequence),
      coverage: "present",
      deepLink: `/listings/${copy.listingId}`,
    },
    input.now,
  );
  for (const entry of COPY_FIELDS) {
    const value = entry.value(copy).trim();
    pushCheck(pack, {
      key: "studio.check.copy_current",
      values: { field: entry.field, present: value.length > 0 },
      state: value.length > 0 ? "ok" : "gap",
    });
  }

  const gaps = await callTool(pack, {
    toolId: "quality.get_gaps",
    rawInput: { listingIds: [listingId] },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (gaps.state === "done") {
    markCoverage(pack, "quality", "present");
    const output = gaps.output as {
      gaps: Array<{ listingId: string; code: string; blocking: boolean }>;
    };
    observedGaps = output.gaps
      .filter((gap) => gap.listingId === listingId)
      .map((gap) => ({ code: gap.code, blocking: gap.blocking }));
    for (const gap of output.gaps)
      pushCheck(pack, {
        key: "studio.check.copy_gap",
        values: {
          listingId: gap.listingId,
          code: gap.code,
          blocking: gap.blocking,
        },
        state: gap.blocking ? "missing" : "gap",
      });
  } else pushLimitation(pack, "studio.limit.quality_unavailable");

  try {
    const quality = await input.deps.getQuality();
    observedAssessmentVersion = quality.assessmentVersion;
    markCoverage(pack, "quality", "present");
    pushSource(
      pack,
      {
        ref: `quality:${quality.assessmentVersion}`,
        kind: "quality",
        label: quality.assessmentVersion,
        refId: quality.assessmentVersion,
        version: quality.assessmentVersion,
        coverage: "present",
        deepLink: "/quality",
      },
      input.now,
    );
  } catch {
    pushLimitation(pack, "studio.limit.quality_unavailable");
  }

  // Immutable proposal target for the turn service; never model-authored.
  pack.context = {
    copyQuality:
      observedGaps !== null && observedAssessmentVersion
        ? { assessmentVersion: observedAssessmentVersion, gaps: observedGaps }
        : null,
    copyProposal: {
      listingId: copy.listingId,
      activeVersionId: copy.activeVersionId,
      activeVersionSequence: copy.activeVersionSequence,
      currentCopy: copy,
      allowedFields: COPY_FIELDS.map((entry) => entry.field),
    },
  };
}

/**
 * Merchant/SEO audit report evidence (plan Task 11).
 *
 * Composes the deterministic report payload from canonical reads only: listing
 * counts by status, the quality projection and recent export attempts. It never
 * calls a model and never estimates. A source that cannot be read is `missing`
 * in coverage and `null` in the payload — never an empty table or a zero count
 * that reads as "there are none".
 */
async function buildMerchantAudit(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const period = parseAuditPeriod(input.query, input.now);
  let listings: MerchantAuditPayload["listings"] = null;
  try {
    const counts = await input.deps.getListingCounts();
    listings = Object.entries(counts)
      .map(([status, count]) => ({ status, count }))
      .sort((left, right) => left.status.localeCompare(right.status));
    markCoverage(pack, "catalog", "present");
    pushSource(
      pack,
      {
        ref: "catalog:counts",
        kind: "catalog",
        label: "workspace listing counts",
        refId: "listing-counts",
        version: null,
        coverage: "present",
        deepLink: "/dashboard",
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.audit_listing_counts",
      values: {
        total: listings.reduce((sum, row) => sum + row.count, 0),
      },
      state: "ok",
    });
  } catch {
    pushLimitation(pack, "studio.limit.catalog_unavailable");
  }

  let quality: MerchantAuditPayload["quality"] = null;
  try {
    const summary = await input.deps.getQuality();
    quality = {
      assessmentVersion: summary.assessmentVersion,
      totalListings: summary.totalListings,
      totalAssessed: summary.totalAssessed,
      cleanCount: summary.cleanCount,
      hasGapsCount: summary.hasGapsCount,
      projectionState: summary.projectionState,
      asOf: summary.asOf,
    };
    markCoverage(pack, "quality", "present");
    pushSource(
      pack,
      {
        ref: `quality:${summary.assessmentVersion}`,
        kind: "quality",
        label: summary.assessmentVersion,
        refId: summary.assessmentVersion,
        version: summary.assessmentVersion,
        coverage: "present",
        deepLink: "/quality",
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.audit_quality",
      values: {
        totalListings: summary.totalListings,
        cleanCount: summary.cleanCount,
        hasGapsCount: summary.hasGapsCount,
      },
      state: summary.projectionState === "ready" ? "ok" : "gap",
    });
  } catch {
    pushLimitation(pack, "studio.limit.quality_unavailable");
  }

  let exports: MerchantAuditPayload["exports"] = null;
  let attemptsInPeriod: MerchantAuditPayload["attemptsInPeriod"] = null;
  try {
    // A named period needs more than the five recent rows so the filter is not
    // truncated by the display window; no period keeps the original five.
    const attempts = await input.deps.getExportAttempts(period ? 20 : 5);
    const scoped = period
      ? attempts.filter((attempt) =>
          isWithinAuditPeriod(attempt.createdAt, period),
        )
      : attempts;
    attemptsInPeriod = period ? scoped.length : null;
    exports = scoped.map((attempt) => ({
      attemptId: attempt.attemptId,
      state: attempt.state,
      rowCount: attempt.rowCount,
      createdAt: attempt.createdAt,
    }));
    markCoverage(pack, "export_attempt", "present");
    for (const attempt of exports)
      pushSource(
        pack,
        {
          ref: `export:${attempt.attemptId}`,
          kind: "export_attempt",
          label: attempt.state,
          refId: attempt.attemptId,
          version: null,
          coverage: "present",
          deepLink: "/jobs?kind=export",
        },
        input.now,
      );
    pushCheck(pack, {
      key: "studio.check.audit_exports",
      values: {
        count: exports.length,
        ready: exports.filter((row) => row.state === "ready").length,
        failed: exports.filter((row) => row.state === "failed").length,
        ...(period ? { inPeriod: exports.length } : {}),
      },
      state: "ok",
    });
    if (period)
      pushCheck(pack, {
        key: "studio.check.audit_period",
        values: {
          from: period.from,
          to: period.to,
          days: period.days,
          attempts: exports.length,
        },
        state: "ok",
      });
  } catch {
    pushLimitation(pack, "studio.limit.audit_exports_unavailable");
  }

  // Listing counts and the quality projection are current-state snapshots, and
  // the period (when named) only scopes the export-attempt table. Say both
  // explicitly instead of letting a reader assume everything is period-scoped.
  pushLimitation(pack, "studio.limit.audit_counts_current");
  if (quality !== null)
    pushLimitation(pack, "studio.limit.audit_quality_current");
  if (period === null) {
    pushLimitation(pack, "studio.limit.audit_period_unset");
    if (mentionsUnparseablePeriod(input.query))
      pushLimitation(pack, "studio.limit.audit_period_invalid");
  } else {
    pushLimitation(pack, "studio.limit.audit_period_applied", {
      from: period.from,
      to: period.to,
    });
  }

  pack.trace.push({
    kind: "evidence",
    toolId: null,
    state: "done",
    durationMs: null,
    detail: translatedLine("studio.trace.audit_read", {
      datasets:
        (listings === null ? 0 : 1) +
        (quality === null ? 0 : 1) +
        (exports === null ? 0 : 1),
    }),
  });

  const payload = merchantAuditPayloadSchema.parse({
    schemaVersion: "wukong-merchant-audit/v2",
    generatedAt: input.now.toISOString(),
    asOf: input.now.toISOString(),
    period: auditPeriodPayload(period),
    attemptsInPeriod,
    scope: { workspaceScoped: true },
    listings,
    quality,
    exports,
    checks: pack.checks,
    coverage: coverageRecord(pack.coverage),
    limitations: pack.limitations,
  });
  pack.context.merchantAudit = payload;
}

/**
 * Category-map proposal evidence (C1).
 *
 * Reads the target listing with `catalog.get`, then similar catalog rows with
 * `catalog.search`. Nothing in canonical listing content carries a category
 * today, so `currentCategory` stays `null` with an explicit limitation rather
 * than an invented path. The pack context is the reviewed input the optional
 * model suggestions are allowed to cite; it never includes a write path.
 */
async function buildCategoryMapProposal(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const listingId = input.listingId;
  if (!listingId) throw new Error("listingId required before build");
  let listingTitle = "";
  let listingAvailable = false;
  const detail = await callTool(pack, {
    toolId: "catalog.get",
    rawInput: { listingId },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (detail.state === "done") {
    const listing = detail.output as {
      listingId: string;
      title: string;
      status: string;
      activeVersion: { versionId: string; sequence: number } | null;
    };
    listingAvailable = true;
    listingTitle = listing.title;
    markCoverage(pack, "listing", "present");
    pushSource(
      pack,
      {
        ref: `listing:${listing.listingId}:${
          listing.activeVersion ? `v${listing.activeVersion.sequence}` : "none"
        }`,
        kind: "listing",
        label: listing.title.slice(0, 300),
        refId: listing.listingId,
        version: listing.activeVersion
          ? String(listing.activeVersion.sequence)
          : null,
        coverage: "present",
        deepLink: `/listings/${listing.listingId}`,
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.category_listing",
      values: {
        listingId: listing.listingId,
        status: listing.status,
        activeVersion: listing.activeVersion ? "present" : "none",
      },
      state: "ok",
    });
  } else {
    pushLimitation(pack, "studio.limit.category_listing_unavailable", {
      listingId,
    });
    markCoverage(pack, "listing", "missing");
  }

  const catalogEvidence: CategoryMapContext["catalogEvidence"] = [];
  const search = await callTool(pack, {
    toolId: "catalog.search",
    rawInput: { query: listingTitle.trim() || listingId, limit: 8 },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (search.state === "done") {
    const hits = search.output as {
      items: Array<{ listingId: string; title: string; status: string }>;
      truncated: boolean;
    };
    markCoverage(pack, "catalog", "present");
    for (const hit of hits.items) {
      if (hit.listingId === listingId) continue;
      const ref = `catalog:${hit.listingId}`;
      pushSource(
        pack,
        catalogSource(input.now, hit.listingId, hit.title),
        input.now,
      );
      catalogEvidence.push({ ref, title: hit.title, status: hit.status });
    }
    pushCheck(pack, {
      key: "studio.check.category_catalog_candidates",
      values: {
        candidates: catalogEvidence.length,
        truncated: hits.truncated,
      },
      state: "ok",
    });
  } else {
    pushLimitation(pack, "studio.limit.category_catalog_unavailable");
    markCoverage(pack, "catalog", "missing");
  }

  // Canonical listing content has no category path field; keep it unknown.
  const currentCategory: string | null = null;
  pushCheck(pack, {
    key: "studio.check.category_current",
    values: { listingId, current: "unknown" },
    state: "missing",
  });
  if (currentCategory === null)
    pushLimitation(pack, "studio.limit.category_current_unknown");

  const context: CategoryMapContext = {
    listingId,
    listingTitle,
    currentCategory,
    catalogEvidence,
    allowedEvidenceRefs: pack.sources.map((source) => source.ref),
  };
  pack.context.categoryMap = context;
  pack.trace.push({
    kind: "evidence",
    toolId: null,
    state: listingAvailable ? "done" : "unavailable",
    durationMs: null,
    detail: translatedLine("studio.trace.category_evidence", {
      candidates: catalogEvidence.length,
    }),
  });
}

/**
 * Product-shot prepare evidence (C1, activated v1.1).
 *
 * Reads the listing with `catalog.get`, its attached assets with `assets.list`
 * and the persisted image-review attempt through the workspace read surface.
 * Only ids, content types and a source/derived label cross the boundary: the
 * provider is never called and no signed URL reaches the turn.
 */
async function buildProductShotPrepare(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const listingId = input.listingId;
  if (!listingId) throw new Error("listingId required before build");
  let listingTitle = "";
  let listingAvailable = false;
  const detail = await callTool(pack, {
    toolId: "catalog.get",
    rawInput: { listingId },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (detail.state === "done") {
    const listing = detail.output as {
      listingId: string;
      title: string;
      status: string;
      activeVersion: { versionId: string; sequence: number } | null;
    };
    listingAvailable = true;
    listingTitle = listing.title;
    markCoverage(pack, "listing", "present");
    pushSource(
      pack,
      {
        ref: `listing:${listing.listingId}:${
          listing.activeVersion ? `v${listing.activeVersion.sequence}` : "none"
        }`,
        kind: "listing",
        label: listing.title.slice(0, 300),
        refId: listing.listingId,
        version: listing.activeVersion
          ? String(listing.activeVersion.sequence)
          : null,
        coverage: "present",
        deepLink: `/listings/${listing.listingId}`,
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.listing_status",
      values: {
        listingId: listing.listingId,
        status: listing.status,
        activeVersion: listing.activeVersion ? "present" : "none",
      },
      state: "ok",
    });
  } else {
    pushLimitation(pack, "studio.limit.product_shot_listing_unavailable", {
      listingId,
    });
    markCoverage(pack, "listing", "missing");
  }

  let assetsReadable = false;
  let split = {
    eligibleAssetIds: [] as string[],
    derivedAssetCount: 0,
    ineligibleAssetCount: 0,
  };
  const assets = await callTool(pack, {
    toolId: "assets.list",
    rawInput: { listingId },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (assets.state === "done") {
    assetsReadable = true;
    split = splitProductShotAssets(
      (assets.output as { items: ListingAssetEvidence[] }).items,
    );
    pushCheck(pack, {
      key: "studio.check.product_shot_sources",
      values: {
        sources: split.eligibleAssetIds.length,
        derived: split.derivedAssetCount,
        ineligible: split.ineligibleAssetCount,
      },
      state: split.eligibleAssetIds.length > 0 ? "ok" : "gap",
    });
  } else {
    pushLimitation(pack, "studio.limit.product_shot_assets_unavailable");
  }

  // The attempt read is a server read, not a model-requestable tool: a failure
  // stays unknown instead of being reported as "no attempt".
  let attempt: ProductShotAttemptEvidence | null = null;
  try {
    attempt = await input.deps.getProductShotAttempt(listingId);
  } catch {
    attempt = null;
  }
  const facts = productShotAttemptFacts(attempt);
  pushCheck(pack, {
    key: "studio.check.product_shot_state",
    values: {
      state: facts.state ?? "unknown",
      candidate: facts.candidateReady,
    },
    state: facts.state === null ? "missing" : "ok",
  });

  const context: ProductShotPrepareContext = {
    listingId,
    listingTitle,
    ...split,
    ...facts,
    ready:
      listingAvailable && assetsReadable && split.eligibleAssetIds.length > 0,
  };
  pack.context.productShotPrepare = context;
  pack.limitations.push(
    ...productShotLimitations({
      listingAvailable,
      assetsReadable,
      stateKnown: facts.state !== null,
      eligibleAssets: split.eligibleAssetIds.length,
    }),
  );
  pack.trace.push({
    kind: "evidence",
    toolId: null,
    state: listingAvailable && assetsReadable ? "done" : "unavailable",
    durationMs: null,
    detail: translatedLine("studio.trace.product_shot_evidence", {
      sources: split.eligibleAssetIds.length,
    }),
  });
}

/**
 * Supplier-intel evidence (C1, activated v1.1).
 *
 * Reads the listing with `catalog.get` and resolves its linked workbook row
 * through the workspace read surface: the bulk-form import writes the canonical
 * row (supplier, identifiers, cost) plus its source-import receipt, so the
 * finding quotes only stored cells. Website records are workspace-level and not
 * listing-linked, so they are excluded with an explicit limitation instead of
 * being guessed as evidence.
 */
async function buildSupplierIntel(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const listingId = input.listingId;
  if (!listingId) throw new Error("listingId required before build");
  let listingTitle = "";
  let listingAvailable = false;
  const detail = await callTool(pack, {
    toolId: "catalog.get",
    rawInput: { listingId },
    deps: input.deps,
    role: input.role,
    limits: input.limits,
  });
  if (detail.state === "done") {
    const listing = detail.output as {
      listingId: string;
      title: string;
      status: string;
      activeVersion: { versionId: string; sequence: number } | null;
    };
    listingAvailable = true;
    listingTitle = listing.title;
    markCoverage(pack, "listing", "present");
    pushSource(
      pack,
      {
        ref: `listing:${listing.listingId}:${
          listing.activeVersion ? `v${listing.activeVersion.sequence}` : "none"
        }`,
        kind: "listing",
        label: listing.title.slice(0, 300),
        refId: listing.listingId,
        version: listing.activeVersion
          ? String(listing.activeVersion.sequence)
          : null,
        coverage: "present",
        deepLink: `/listings/${listing.listingId}`,
      },
      input.now,
    );
    pushCheck(pack, {
      key: "studio.check.supplier_listing",
      values: {
        listingId: listing.listingId,
        status: listing.status,
        activeVersion: listing.activeVersion ? "present" : "none",
      },
      state: "ok",
    });
  } else {
    pushLimitation(pack, "studio.limit.supplier_listing_unavailable", {
      listingId,
    });
    markCoverage(pack, "listing", "missing");
  }

  let workbook: SupplierWorkbookEvidence | null = null;
  try {
    workbook = await input.deps.getSupplierWorkbook(listingId);
  } catch {
    workbook = null;
  }
  if (workbook) {
    markCoverage(pack, "workbook", "present");
    pushSource(
      pack,
      {
        ref: `workbook:${workbook.productId}`,
        kind: "workbook",
        label: "Linked workbook row",
        refId: workbook.productId,
        version: null,
        coverage: "present",
        deepLink: `/listings/${listingId}`,
      },
      input.now,
    );
    if (workbook.sourceImport) {
      markCoverage(pack, "source_import", "present");
      pushSource(
        pack,
        {
          ref: `source_import:${workbook.sourceImport.importId}`,
          kind: "source_import",
          label: "Source import receipt",
          refId: workbook.sourceImport.importId,
          version: null,
          coverage: "present",
          deepLink: `/listings/${listingId}`,
        },
        input.now,
      );
    } else {
      markCoverage(pack, "source_import", "missing");
      pushLimitation(pack, "studio.limit.supplier_source_import_unavailable");
    }
    pushCheck(pack, {
      key: "studio.check.supplier_fields",
      values: {
        present: Object.keys(workbook.values).length,
        missing: workbook.missingFields.length,
      },
      state: workbook.missingFields.length > 0 ? "missing" : "ok",
    });
  } else {
    markCoverage(pack, "workbook", "missing");
    markCoverage(pack, "source_import", "missing");
    pushLimitation(pack, "studio.limit.supplier_workbook_unavailable", {
      listingId,
    });
  }
  if (workbook && workbook.missingFields.length > 0) {
    pushLimitation(pack, "studio.limit.supplier_fields_missing", {
      fields: workbook.missingFields.join(","),
    });
  }
  pushLimitation(pack, "studio.limit.supplier_not_applied");
  pushLimitation(pack, "studio.limit.supplier_website_unlinked");

  const context: SupplierIntelContext = {
    listingId,
    listingTitle,
    workbook,
    sourceImport: workbook?.sourceImport ?? null,
    allowedEvidenceRefs: pack.sources.map((source) => source.ref),
  };
  pack.context.supplierIntel = context;
  pack.trace.push({
    kind: "evidence",
    toolId: null,
    state: listingAvailable ? "done" : "unavailable",
    durationMs: null,
    detail: translatedLine("studio.trace.supplier_evidence", {
      fields: workbook ? Object.keys(workbook.values).length : 0,
      missing: workbook ? workbook.missingFields.length : 7,
    }),
  });
}

export async function buildEvidencePack(
  input: BuildEvidenceInput,
): Promise<BuildEvidenceResult> {
  const pack: EvidencePack = {
    sources: [],
    checks: [],
    coverage: coverageMap(input.skill.evidence.requiredSources),
    sections: [],
    limitations: [],
    followUps: [],
    trace: [],
    context: {},
  };
  const requiredQuery = input.skill.inputs.some(
    (field) => field.name === "query",
  );
  if (requiredQuery && !(input.query?.trim().length ?? 0))
    return {
      status: "needs_input",
      skill: input.skill,
      question: translatedLine("studio.needs_input.catalog_query"),
    };
  const requiresListing = input.skill.inputs.some(
    (field) => field.name === "listingId",
  );
  if (requiresListing && !input.listingId)
    return {
      status: "needs_input",
      skill: input.skill,
      question: translatedLine(
        input.skill.key === "category.map_proposal"
          ? "studio.needs_input.category_listing"
          : input.skill.key === "product_shot.prepare"
            ? "studio.needs_input.product_shot_listing"
            : input.skill.key === "supplier.intel_proposal"
              ? "studio.needs_input.supplier_listing"
              : "studio.needs_input.copy_listing",
      ),
    };
  const draftAssets = draftAssetIds({
    ...(input.attachmentAssetIds
      ? { attachmentAssetIds: input.attachmentAssetIds }
      : {}),
    query: input.query,
  });
  if (
    input.skill.key === "listing.draft_from_sources" &&
    draftAssets.length === 0
  )
    return {
      status: "needs_input",
      skill: input.skill,
      question: translatedLine("studio.needs_input.draft_assets"),
    };

  if (input.skill.key === "catalog.find") await buildCatalogFind(input, pack);
  else if (input.skill.key === "catalog.gap_review")
    await buildGapReview(input, pack);
  else if (input.skill.key === "listing.copy_proposal")
    await buildCopyProposal(input, pack);
  else if (input.skill.key === "listing.draft_from_sources")
    await buildDraftFromSources(input, pack, draftAssets);
  else if (input.skill.key === "merchant.audit")
    await buildMerchantAudit(input, pack);
  else if (input.skill.key === "category.map_proposal")
    await buildCategoryMapProposal(input, pack);
  else if (input.skill.key === "product_shot.prepare")
    await buildProductShotPrepare(input, pack);
  else if (input.skill.key === "supplier.intel_proposal")
    await buildSupplierIntel(input, pack);
  else throw new Error(`unsupported pilot skill ${input.skill.key}`);

  pushFollowUps(pack, input.skill.key);
  return { status: "complete", pack };
}
