import type {
  EnrichmentBatch,
  ExportAttempt,
  PipelineRunSummary,
  PublishJob,
} from "@wukong/db";

export type LedgerKind = "batch" | "publish_job" | "pipeline_run" | "export";
export type NormalizedStatus =
  "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type LedgerEntry = {
  kind: LedgerKind;
  id: string;
  listingId: string | null;
  normalizedStatus: NormalizedStatus;
  rawStatus: string;
  createdAt: Date;
  summary: string;
};

export type JobsLedgerSources = {
  batches: readonly EnrichmentBatch[];
  publishJobs: readonly PublishJob[];
  pipelineRuns: readonly PipelineRunSummary[];
  exports: readonly ExportAttempt[];
};

const BATCH_STATUS: Record<EnrichmentBatch["status"], NormalizedStatus> = {
  open: "pending",
  running: "running",
  completed: "succeeded",
  budget_exhausted: "cancelled",
  cancelled: "cancelled",
};

const PUBLISH_JOB_STATUS: Record<PublishJob["status"], NormalizedStatus> = {
  pending_enqueue: "pending",
  queued: "pending",
  running: "running",
  published: "succeeded",
  failed: "failed",
};

const PIPELINE_RUN_STATUS: Record<
  PipelineRunSummary["status"],
  NormalizedStatus
> = {
  started: "running",
  succeeded: "succeeded",
  failed: "failed",
};

// `publish_jobs.status` and `listing_pipeline_runs.status` are plain `text()`
// columns, not real Postgres enums like `enrichment_batches.status` -- their
// narrowed types only exist via an `as` cast in the repository layer. A row
// holding a value outside that union (a manual DB fix, a retired status, an
// incident-response patch) makes the lookups above return `undefined` at
// runtime with no compile error. Falling back to "failed" instead of letting
// `normalizedStatus` silently become `undefined` means an unrecognized status
// reads as "something's wrong" -- the honest answer -- rather than as a
// broken-looking blank on a page whose whole purpose is spotting problems.
const FALLBACK_STATUS: NormalizedStatus = "failed";

// Driven by `job.status` rather than just `remoteProductId`/`error`, so a
// freshly-created job sitting in `pending_enqueue` or `queued` (neither has
// started any real work, and both fields are still null) doesn't fall
// through to the "Publishing" branch and read as active progress. This page
// exists for "why is this stuck" investigations, where that distinction is
// the whole point.
function publishJobSummary(job: PublishJob): string {
  switch (job.status) {
    case "pending_enqueue":
    case "queued":
      return "Queued for publish";
    case "running":
      return "Publishing";
    case "published":
      return job.remoteProductId
        ? `Published as ${job.remoteProductId}`
        : "Published";
    case "failed":
      return job.error ? `Error: ${job.error}` : "Publish failed";
    default: {
      // Unmapped status -- see FALLBACK_STATUS above for why this can happen
      // despite the exhaustive-looking union. Wording matches
      // FALLBACK_STATUS's "failed" framing so normalizedStatus and summary
      // never disagree on the same row.
      const _exhaustive: never = job.status;
      return `Status unrecognized, treated as failed: ${_exhaustive as string}`;
    }
  }
}

export function buildJobsLedger(
  sources: JobsLedgerSources,
  limit: number,
): LedgerEntry[] {
  // Matches the bounds every sibling `listForWorkspace(limit?)` repository
  // enforces (see enrichment-batches.ts, publish-jobs.ts, pipeline-runs.ts,
  // export-attempts.ts). Without this, a negative limit would silently hit
  // `Array.prototype.slice`'s negative-index semantics -- "all but the last
  // N" -- instead of throwing, which is exactly the kind of surprise a route
  // that parses a query-string limit could hand this function by accident.
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("jobs ledger limit must be between 1 and 100");
  }

  const entries: LedgerEntry[] = [
    ...sources.batches.map((batch): LedgerEntry => ({
      kind: "batch",
      id: batch.id,
      listingId: null,
      normalizedStatus: BATCH_STATUS[batch.status],
      rawStatus: batch.status,
      createdAt: batch.createdAt,
      summary: `${batch.label} (wave ${batch.waveSize}, $${batch.budgetUsd.toFixed(2)})`,
    })),
    ...sources.publishJobs.map((job): LedgerEntry => ({
      kind: "publish_job",
      id: job.id,
      listingId: job.listingId,
      normalizedStatus: PUBLISH_JOB_STATUS[job.status] ?? FALLBACK_STATUS,
      rawStatus: job.status,
      createdAt: job.createdAt,
      summary: publishJobSummary(job),
    })),
    ...sources.pipelineRuns.map((run): LedgerEntry => ({
      kind: "pipeline_run",
      id: run.id,
      listingId: run.listingId,
      normalizedStatus: PIPELINE_RUN_STATUS[run.status] ?? FALLBACK_STATUS,
      rawStatus: run.status,
      createdAt: run.createdAt,
      summary: run.errorCode ? `Error: ${run.errorCode}` : "AI pipeline run",
    })),
    ...sources.exports.map((attempt): LedgerEntry => {
      const included = attempt.manifest.filter(
        (entry) => entry.outcome === "included",
      ).length;
      const excluded = attempt.manifest.length - included;
      return {
        kind: "export",
        id: attempt.id,
        listingId: null,
        normalizedStatus: "succeeded",
        rawStatus: "export_attempts",
        createdAt: attempt.createdAt,
        summary:
          excluded > 0
            ? `Export: ${included} row(s), ${excluded} excluded`
            : `Export: ${included} row(s)`,
      };
    }),
  ];

  // Primary sort is createdAt descending. Ties are possible and not rare:
  // Task 1 (see git history on the 4 `listForWorkspace` queries) hit exactly
  // this within a single source, because rows written inside one shared
  // `db.forWorkspace` transaction share Postgres's per-transaction `now()`.
  // Here it's worse -- a tie can also happen *across* sources (a batch and a
  // publish job created in the same instant), which a per-source id tiebreak
  // can't help with. `Array.prototype.sort` has been spec-guaranteed stable
  // since ES2019, so ties would already come out deterministic by relying on
  // this array's concatenation order (batches, then publishJobs, then
  // pipelineRuns, then exports) -- but that "insertion order" tiebreak is
  // meaningless as a business rule and silently depends on the concatenation
  // order above never being reshuffled for readability. `id` is an explicit,
  // self-documenting tiebreak that doesn't rely on that.
  entries.sort((a, b) => {
    const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    // Descending, matching Task 1's listForWorkspace tiebreak convention
    // (desc(createdAt), desc(id)) -- keeps a same-instant tie ordered the
    // same way whether it's read via a repository directly or through here.
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });
  return entries.slice(0, limit);
}
