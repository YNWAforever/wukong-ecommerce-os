"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import type { LedgerKind, NormalizedStatus } from "../lib/jobs-ledger";
import { useLatestRequest } from "../lib/use-latest-request";
import {
  ExportReconciliationPanel,
  type WireExportReconciliationDetail,
} from "./export-reconciliation-panel";

// The wire shape of `LedgerEntry` (see lib/jobs-ledger.ts): `createdAt` is a
// real `Date` server-side, but `jsonResponse` runs it through
// `JSON.stringify`, so it arrives here as an ISO string, not a `Date`
// instance -- `new Date(entry.createdAt)` below is required before any
// formatting, not optional convenience.
type WireLedgerEntry = {
  kind: LedgerKind;
  id: string;
  listingId: string | null;
  normalizedStatus: NormalizedStatus;
  rawStatus: string;
  createdAt: string;
  summary: string;
};

type JobsMetrics = {
  publishRetries: number;
  versionConflicts: number;
  staleSourceRejections: number;
  importedRows: number;
};

type JobsResponse = {
  entries: WireLedgerEntry[];
  metrics: JobsMetrics;
  exportReconciliations?: Array<
    Omit<WireExportReconciliationDetail, "capabilities">
  >;
  capabilities?: WireExportReconciliationDetail["capabilities"];
  page: number;
  pageSize: number;
  totalMatching: number;
  total: number;
  counts: Record<LedgerKind, number>;
  scope: "workspace_all_history";
  metricsScope: { windowDays: number; since: string };
};

type KindFilter = "all" | LedgerKind;

const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "全部 All" },
  { value: "batch", label: "批次 Batch" },
  { value: "publish_job", label: "發佈工作 Publish job" },
  { value: "pipeline_run", label: "AI 流程 Pipeline run" },
  { value: "export", label: "匯出 Export" },
  { value: "import_result", label: "匯入結果 Import result" },
];

const KIND_LABELS: Record<LedgerKind, string> = {
  batch: "批次 Batch",
  publish_job: "發佈工作 Publish job",
  pipeline_run: "AI 流程 Pipeline run",
  export: "匯出 Export",
  import_result: "匯入結果 Import result",
};

// Each of the 5 normalizedStatus values gets its own `status-*` tone class
// (see globals.css) so they read as genuinely distinct states rather than a
// couple of colors reused ambiguously: pending is neutral grey, running is
// amber (active), succeeded is green, failed is red (reusing the
// `status-failed` class already used by the review/connection status
// pills), and cancelled is navy -- the one status none of the other pills on
// this branch needed a color for yet.
const STATUS_LABELS: Record<NormalizedStatus, string> = {
  pending: "待處理 Pending",
  running: "進行中 Running",
  succeeded: "成功 Succeeded",
  failed: "失敗 Failed",
  cancelled: "已取消 Cancelled",
};

export function JobsLedgerClient() {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "50",
      });
      if (kindFilter !== "all") params.set("kind", kindFilter);
      const response = await fetch(`/api/jobs?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(`Unable to load jobs (${response.status})`);
      return (await response.json()) as JobsResponse;
    },
    [page, kindFilter],
  );
  const { data, error, loading, stale, reload } = useLatestRequest(
    load,
    "Unable to load jobs",
  );

  if (!data && error)
    return (
      <div className="load-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  if (!data) {
    return (
      <p className="helper-copy" role="status">
        正在載入作業記錄… Loading jobs ledger…
      </p>
    );
  }

  const response = data;
  const visibleEntries =
    kindFilter === "all"
      ? response.entries
      : response.entries.filter((entry) => entry.kind === kindFilter);
  return (
    <section aria-label="作業記錄" aria-busy={loading}>
      {error ? (
        <div className="load-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : null}
      {stale ? (
        <p className="refresh-status" role="status">
          Refreshing jobs ledger…
        </p>
      ) : null}
      {response.metricsScope ? (
        <p className="helper-copy">
          All-history workspace ledger. Metrics cover the{" "}
          {response.metricsScope.windowDays}-day window since{" "}
          <time dateTime={response.metricsScope.since}>
            {response.metricsScope.since}
          </time>
          .
        </p>
      ) : null}
      <div className="metric-strip jobs-metric-strip" aria-label="作業指標統計">
        <div>
          <span className="metric-value">
            {response.metrics.publishRetries}
          </span>
          <span className="metric-label">
            發佈重試 <small>Publish retries</small>
          </span>
        </div>
        <div>
          <span className="metric-value">
            {response.metrics.versionConflicts}
          </span>
          <span className="metric-label">
            版本衝突 <small>Version conflicts</small>
          </span>
        </div>
        <div>
          <span className="metric-value">
            {response.metrics.staleSourceRejections}
          </span>
          <span className="metric-label">
            來源已過時 <small>Stale-source rejections</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{response.metrics.importedRows}</span>
          <span className="metric-label">
            近期匯入列數 <small>Recent imported rows</small>
          </span>
        </div>
      </div>

      <div className="admin-tab-list" role="group" aria-label="依類型篩選">
        {KIND_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={
              option.value === kindFilter ? "admin-tab active" : "admin-tab"
            }
            aria-pressed={option.value === kindFilter}
            onClick={() => {
              setKindFilter(option.value);
              setPage(1);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {response.exportReconciliations?.length ? (
        <section
          className="export-reconciliations"
          aria-label="Bulk Update XLSX reconciliations"
        >
          <h2>Bulk Update XLSX reconciliations</h2>
          {response.exportReconciliations.map((detail) => (
            <ExportReconciliationPanel
              key={detail.attempt.id}
              detail={{
                ...detail,
                capabilities: response.capabilities ?? {
                  canGenerateBulkUpdate: false,
                  canRecordImportResult: false,
                },
              }}
            />
          ))}
        </section>
      ) : null}

      <div className="pagination-controls" aria-label="Jobs pagination">
        <button
          type="button"
          onClick={() => setPage((value) => Math.max(1, value - 1))}
          disabled={page === 1 || loading}
        >
          Previous
        </button>
        <span>
          Page {page}
          {response.totalMatching !== undefined
            ? ` · ${response.totalMatching} matching / ${response.total} total`
            : ""}
        </span>
        <button
          type="button"
          onClick={() => setPage((value) => value + 1)}
          disabled={
            loading ||
            response.pageSize === undefined ||
            page * response.pageSize >= response.totalMatching
          }
        >
          Next
        </button>
      </div>

      {visibleEntries.length === 0 ? (
        <p className="helper-copy">
          找不到符合條件的作業紀錄。 <span>No jobs match this filter.</span>
        </p>
      ) : (
        <ul className="flag-list">
          {visibleEntries.map((entry) => {
            const createdAt = new Date(entry.createdAt);
            return (
              <li className="flag-item" key={`${entry.kind}:${entry.id}`}>
                <div className="flag-content">
                  <div className="jobs-row-header">
                    <h3>{KIND_LABELS[entry.kind]}</h3>
                    <span
                      className={`connection-status status-${entry.normalizedStatus}`}
                    >
                      <span aria-hidden="true" />
                      {STATUS_LABELS[entry.normalizedStatus]}
                    </span>
                  </div>
                  <p>{entry.summary}</p>
                  <div className="jobs-row-meta">
                    {entry.rawStatus} ·{" "}
                    <time dateTime={createdAt.toISOString()}>
                      {createdAt.toISOString()}
                    </time>
                  </div>
                  {entry.kind === "export" ? (
                    <ExportAttemptInspector attemptId={entry.id} />
                  ) : null}
                  {entry.listingId ? (
                    <Link
                      className="jobs-row-link"
                      href={`/listings/${entry.listingId}`}
                    >
                      查看上架流程 <span>View listing</span>
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ExportAttemptInspector({ attemptId }: { attemptId: string }) {
  const [opened, setOpened] = useState(false);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!opened) return null;
      const response = await fetch(`/api/listings/export/${attemptId}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(`Unable to load export attempt (${response.status})`);
      return (await response.json()) as WireExportReconciliationDetail;
    },
    [attemptId, opened],
  );
  const { data, error, loading, reload } = useLatestRequest(
    load,
    "Unable to load export attempt",
  );
  if (!opened)
    return (
      <button
        type="button"
        className="secondary-button"
        onClick={() => setOpened(true)}
      >
        Inspect export attempt
      </button>
    );
  return (
    <div className="export-attempt-detail">
      {loading && !data ? <span role="status">Loading attempt…</span> : null}
      {error ? (
        <div role="alert">
          <span>{error}</span>
          <button type="button" onClick={reload}>
            Retry detail
          </button>
        </div>
      ) : null}
      {data ? <ExportReconciliationPanel detail={data} /> : null}
    </div>
  );
}
