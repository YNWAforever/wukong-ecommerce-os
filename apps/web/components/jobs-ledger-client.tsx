"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { LedgerKind, NormalizedStatus } from "../lib/jobs-ledger";
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

const EMPTY_RESPONSE: JobsResponse = {
  entries: [],
  metrics: {
    publishRetries: 0,
    versionConflicts: 0,
    staleSourceRejections: 0,
    importedRows: 0,
  },
};

export function JobsLedgerClient() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  useEffect(() => {
    const controller = new AbortController();

    async function loadJobs() {
      try {
        const response = await fetch("/api/jobs", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Unable to load jobs (${response.status})`);
        }
        setData((await response.json()) as JobsResponse);
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        ) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load jobs",
        );
      }
    }

    void loadJobs();
    return () => controller.abort();
  }, []);

  const response = data ?? EMPTY_RESPONSE;
  const visibleEntries = useMemo(
    () =>
      kindFilter === "all"
        ? response.entries
        : response.entries.filter((entry) => entry.kind === kindFilter),
    [response.entries, kindFilter],
  );

  if (error) {
    return (
      <p className="inline-warning" role="alert">
        {error}
      </p>
    );
  }

  if (!data) {
    return (
      <p className="helper-copy" role="status">
        正在載入作業記錄… Loading jobs ledger…
      </p>
    );
  }

  return (
    <section aria-label="作業記錄">
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
            onClick={() => setKindFilter(option.value)}
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
