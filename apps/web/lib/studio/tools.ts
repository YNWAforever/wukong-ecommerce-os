import { z } from "zod";

import {
  getTool,
  STUDIO_ROLE_RANK,
  type StudioRole,
  type ToolId,
} from "@wukong/core";

import {
  translatedLine,
  type TranslatedLine,
} from "./types.js";
import { readListingRunStatus } from "./tools/listing-run-status.js";

/**
 * Typed internal tool plane for the deterministic Studio (plan Task 5).
 *
 * The registry in `@wukong/core` owns tool ids, input/output schemas, role
 * floors and cost classes. This module owns execution against an injected
 * read-only dependency surface, so tests exercise the same allowlist,
 * validation and trace behaviour the routes will use.
 */

export type CatalogSearchHit = {
  listingId: string;
  title: string;
  status: string;
};

export type ListingEvidence = {
  listingId: string;
  status: string;
  title: string;
  activeVersion: { versionId: string; sequence: number } | null;
  blockingFlagCount: number;
};

export type QualityEvidence = {
  assessmentVersion: string;
  totalListings: number;
  totalAssessed: number;
  cleanCount: number;
  hasGapsCount: number;
  noActiveVersion: number;
  unassessableActiveVersion: number;
  projectionState: "ready" | "pending" | "failed";
  asOf: string | null;
};

export type JobEvidence = {
  jobId: string;
  state: string;
  createdAt: string;
};

export type ListingGap = { code: string; blocking: boolean };

/** A source asset the operator attached, resolved inside the workspace. */
export type SourceAssetEvidence = {
  assetId: string;
  contentType: string;
  listingId: string | null;
};

/** One listing-pipeline operation's persisted state, read for the UI. */
export type ListingRunStatus = {
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "superseded";
};

/** One recent export attempt, reduced to audit-safe fields (plan Task 11). */
export type ExportAttemptEvidence = {
  attemptId: string;
  state: "pending" | "ready" | "failed" | "recorded";
  rowCount: number;
  createdAt: string;
};

/** Current copy snapshot for the reviewed listing version (proposal context). */
export type ListingCopySnapshot = {
  listingId: string;
  activeVersionId: string;
  activeVersionSequence: number;
  title: { en: string; "zh-Hant": string };
  description: { en: string; "zh-Hant": string };
  seo: {
    title: { en: string; "zh-Hant": string };
    description: { en: string; "zh-Hant": string };
  };
};

/**
 * The only data the v1 read tools may touch. Task 6 binds this to
 * `db.forWorkspace` repositories; Task 1 integration proves the SQL underneath.
 */
export type StudioReadDeps = {
  searchCatalog(input: { query: string; limit: number }): Promise<{
    items: CatalogSearchHit[];
    truncated: boolean;
    unlinkedSkipped: number;
  }>;
  getListing(listingId: string): Promise<ListingEvidence | null>;
  getQuality(): Promise<QualityEvidence>;
  listJobs(limit: number): Promise<JobEvidence[]>;
  getListingGaps(
    listingId: string,
  ): Promise<{ gaps: ListingGap[] } | null>;
  /**
   * Current copy snapshot for the reviewed version. Used by the copy-proposal
   * skill as the immutable target/context; it is not a tool-requestable action.
   */
  getListingCopy(listingId: string): Promise<ListingCopySnapshot | null>;
  /**
   * Resolve operator-attached source asset ids inside the workspace (plan
   * Task 10). A missing id is reported, never silently dropped, and an asset
   * already attached to a listing is surfaced so the dispatch can be refused
   * honestly. This is a server read for evidence, not a model-requestable tool.
   */
  getSourceAssets(assetIds: readonly string[]): Promise<{
    items: SourceAssetEvidence[];
    missingAssetIds: string[];
  }>;
  /** Persisted state of one listing-pipeline operation (read tool support). */
  getListingRunStatus(
    listingId: string,
    runId: string,
  ): Promise<ListingRunStatus | null>;
  /** Workspace listing counts by status, for the audit report (Task 11). */
  getListingCounts(): Promise<Record<string, number>>;
  /** Recent export attempts, for the audit report (Task 11). */
  getExportAttempts(limit: number): Promise<ExportAttemptEvidence[]>;
};

export type ToolRun = {
  state: "done" | "unavailable" | "blocked";
  output: unknown;
  detail: TranslatedLine;
};

function elapsed(started: number, now: () => number): number {
  return Math.max(0, Math.round(now() - started));
}

async function runReadTool(
  toolId: ToolId,
  parsed: unknown,
  deps: StudioReadDeps,
): Promise<{ output: unknown } | { state: "unavailable" }> {
  switch (toolId) {
    case "catalog.search": {
      const input = parsed as { query?: string; limit?: number };
      const result = await deps.searchCatalog({
        query: input.query ?? "",
        limit: Math.min(Math.max(input.limit ?? 10, 1), 50),
      });
      // Tool output is the reviewed schema only; internal read metadata
      // (e.g. unlinked sources skipped) stays out of the tool plane.
      return {
        output: { items: result.items, truncated: result.truncated },
      };
    }
    case "catalog.get": {
      const input = parsed as { listingId: string };
      const listing = await deps.getListing(input.listingId);
      if (!listing) return { state: "unavailable" };
      const activeVersion = listing.activeVersion;
      return {
        output: {
          listingId: listing.listingId,
          status: listing.status,
          title: listing.title,
          activeVersion,
        },
      };
    }
    case "quality.get_gaps": {
      const input = parsed as { listingIds: string[] };
      const gaps: Array<{
        listingId: string;
        code: string;
        blocking: boolean;
      }> = [];
      for (const listingId of input.listingIds) {
        const result = await deps.getListingGaps(listingId);
        if (!result) continue;
        for (const gap of result.gaps)
          gaps.push({ listingId, code: gap.code, blocking: gap.blocking });
      }
      return { output: { gaps } };
    }
    case "jobs.list": {
      const input = parsed as { limit?: number };
      const jobs = await deps.listJobs(
        Math.min(Math.max(input.limit ?? 10, 1), 50),
      );
      return {
        output: {
          items: jobs.map((job) => ({
            jobId: job.jobId,
            state: job.state,
            createdAt: job.createdAt,
          })),
          truncated: jobs.length >= (input.limit ?? 10),
        },
      };
    }
    case "listing.get_run_status": {
      const input = parsed as { listingId: string; runId: string };
      const status = await readListingRunStatus(deps, input);
      if (!status) return { state: "unavailable" };
      return { output: status };
    }
    // Dispatch never runs through the tool plane: `listing.create_draft` is a
    // reviewed registry entry, but creating canonical listing data must go
    // through the explicit confirmed Studio dispatch route (plan Task 10).
    case "imports.list":
    case "exports.get":
    case "assets.list":
    case "listing.create_draft":
    case "listing.propose_copy":
      return { state: "unavailable" };
    default: {
      const never: never = toolId;
      throw new Error(`unhandled studio tool ${String(never)}`);
    }
  }
}

/**
 * Execute one registry tool. Throws only on programming errors; all expected
 * outcomes are explicit states so the turn trace stays honest.
 */
export async function runStudioTool(input: {
  toolId: string;
  rawInput: unknown;
  role: StudioRole;
  deps: StudioReadDeps;
  now?: () => number;
}): Promise<ToolRun> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const definition = getTool(input.toolId);
  if (!definition)
    return {
      state: "blocked",
      output: null,
      detail: translatedLine("studio.trace.tool.unknown", {
        tool: input.toolId,
      }),
    };
  if (STUDIO_ROLE_RANK[input.role] < STUDIO_ROLE_RANK[definition.minRole])
    return {
      state: "blocked",
      output: null,
      detail: translatedLine("studio.trace.tool.insufficient_role", {
        tool: definition.id,
      }),
    };
  let parsed: unknown;
  try {
    parsed = definition.input.parse(input.rawInput);
  } catch (error) {
    // A model argument that does not match the reviewed schema is rejected,
    // never repaired or retried inside the same turn.
    if (error instanceof z.ZodError)
      return {
        state: "blocked",
        output: null,
        detail: translatedLine("studio.trace.tool.invalid_arguments", {
          tool: definition.id,
        }),
      };
    throw error;
  }
  try {
    const result = await runReadTool(definition.id, parsed, input.deps);
    if ("state" in result)
      return {
        state: "unavailable",
        output: null,
        detail: translatedLine("studio.trace.tool.unavailable", {
          tool: definition.id,
          durationMs: elapsed(started, now),
        }),
      };
    const output = definition.output.parse(result.output);
    return {
      state: "done",
      output,
      detail: translatedLine("studio.trace.tool.done", {
        tool: definition.id,
        durationMs: elapsed(started, now),
      }),
    };
  } catch {
    // Never leak provider/repository text into the trace or the model.
    return {
      state: "unavailable",
      output: null,
      detail: translatedLine("studio.trace.tool.failed", {
        tool: definition.id,
        durationMs: elapsed(started, now),
      }),
    };
  }
}
