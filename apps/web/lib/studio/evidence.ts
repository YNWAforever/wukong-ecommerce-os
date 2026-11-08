import type { SkillDefinition, StudioRole, SourceKind } from "@wukong/core";

import { runStudioTool, type StudioReadDeps, type ToolRun } from "./tools.js";
import {
  coverageMap,
  translatedLine,
  type EvidenceCheck,
  type EvidenceCoverage,
  type EvidencePack,
  type EvidenceSource,
  type NeedsInput,
  type StudioTraceStep,
} from "./types.js";

/**
 * Deterministic evidence assembly (plan Task 5, spec 禮3.3).
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
  limit?: number;
};

export type BuildEvidenceResult =
  | { status: "complete"; pack: EvidencePack }
  | NeedsInput;

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
  },
): Promise<ToolRun> {
  const run = await runStudioTool({
    toolId: input.toolId,
    rawInput: input.rawInput,
    role: input.role,
    deps: input.deps,
  });
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

  if (hits.truncated) pushLimitation(pack, "studio.limit.results_truncated");
}

async function buildGapReview(
  input: BuildEvidenceInput,
  pack: EvidencePack,
): Promise<void> {
  const requested = [...new Set(input.listingIds ?? [])].slice(0, MAX_LISTINGS);
  let targets = requested;
  // With an explicit selection this turn does not query the catalog at all, so
  // the source is not applicable rather than missing.
  if (requested.length > 0) markCoverage(pack, "catalog", "unsupported");
  if (targets.length === 0) {
    const search = await callTool(pack, {
      toolId: "catalog.search",
      rawInput: { query: "", limit: MAX_LISTINGS },
      deps: input.deps,
      role: input.role,
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
    if (hits.truncated) pushLimitation(pack, "studio.limit.results_truncated");
  }

  for (const listingId of targets) {
    const detail = await callTool(pack, {
      toolId: "catalog.get",
      rawInput: { listingId },
      deps: input.deps,
      role: input.role,
    });
    if (detail.state !== "done") {
      pushLimitation(pack, "studio.limit.listing_unavailable", { listingId });
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
    });
    if (gaps.state !== "done") {
      pushLimitation(pack, "studio.limit.quality_unavailable");
    } else {
      const output = gaps.output as {
        gaps: Array<{ listingId: string; code: string; blocking: boolean }>;
      };
      markCoverage(pack, "quality", "present");
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
  } else {
    pack.followUps.push(translatedLine("studio.followup.list_attention"));
    pack.followUps.push(translatedLine("studio.followup.open_listing"));
  }
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

  if (input.skill.key === "catalog.find")
    await buildCatalogFind(input, pack);
  else if (input.skill.key === "catalog.gap_review")
    await buildGapReview(input, pack);
  else throw new Error(`unsupported pilot skill ${input.skill.key}`);

  pushFollowUps(pack, input.skill.key);
  return { status: "complete", pack };
}
