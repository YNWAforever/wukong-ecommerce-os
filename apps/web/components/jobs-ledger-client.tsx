"use client";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  safeUiError,
  formatNumber,
  formatHkDate,
  stateLabel,
} from "../lib/ui-copy";

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

const KIND_FILTERS: ReadonlyArray<{
  value: KindFilter;
  labelZh: string;
  labelEn: string;
}> = [
  { value: "all", labelZh: "全部", labelEn: "All" },
  { value: "batch", labelZh: "批次", labelEn: "Batch" },
  { value: "publish_job", labelZh: "發佈工作", labelEn: "Publish job" },
  { value: "pipeline_run", labelZh: "AI 流程", labelEn: "Pipeline run" },
  { value: "export", labelZh: "匯出", labelEn: "Export" },
  { value: "import_result", labelZh: "匯入結果", labelEn: "Import result" },
];

// Each of the 5 normalizedStatus values gets its own `status-*` tone class
// (see globals.css) so they read as genuinely distinct states rather than a
// couple of colors reused ambiguously: pending is neutral grey, running is
// amber (active), succeeded is green, failed is red (reusing the
// `status-failed` class already used by the review/connection status
// pills), and cancelled is navy -- the one status none of the other pills on
// this branch needed a color for yet.

export function JobsLedgerClient() {
  const locale = useLocale();
  const c = commonCopy[locale];
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
        <p>{safeUiError(error, locale)}</p>
        <button type="button" onClick={reload}>
          {c.retry}
        </button>
      </div>
    );
  if (!data) {
    return (
      <p className="helper-copy" role="status">
        {localized(locale, "正在載入作業記錄…", "Loading jobs ledger…")}
      </p>
    );
  }

  const response = data;
  const visibleEntries =
    kindFilter === "all"
      ? response.entries
      : response.entries.filter((entry) => entry.kind === kindFilter);
  return (
    <section
      aria-label={localized(locale, "作業記錄", "Jobs ledger")}
      aria-busy={loading}
    >
      {error ? (
        <div className="load-error" role="alert">
          <span>{safeUiError(error, locale)}</span>
          <button type="button" onClick={reload}>
            {c.retry}
          </button>
        </div>
      ) : null}
      {stale ? (
        <p className="refresh-status" role="status">
          {localized(locale, "正在更新作業記錄…", "Refreshing jobs ledger…")}
        </p>
      ) : null}
      {response.metricsScope ? (
        <p className="helper-copy">
          {localized(
            locale,
            `工作區完整歷史記錄。指標涵蓋 ${response.metricsScope.windowDays} 天，由以下時間起：`,
            `All-history workspace ledger. Metrics cover the ${response.metricsScope.windowDays}-day window since `,
          )}
          <time dateTime={response.metricsScope.since}>
            {formatHkDate(response.metricsScope.since, locale)}
          </time>
          .
        </p>
      ) : null}
      <div
        className="metric-strip jobs-metric-strip"
        aria-label={localized(locale, "作業指標統計", "Job metrics")}
      >
        <div>
          <span className="metric-value">
            {formatNumber(response.metrics.publishRetries, locale)}
          </span>
          <span className="metric-label">
            {localized(locale, "發佈重試", "Publish retries")}
          </span>
        </div>
        <div>
          <span className="metric-value">
            {formatNumber(response.metrics.versionConflicts, locale)}
          </span>
          <span className="metric-label">
            {localized(locale, "版本衝突", "Version conflicts")}
          </span>
        </div>
        <div>
          <span className="metric-value">
            {formatNumber(response.metrics.staleSourceRejections, locale)}
          </span>
          <span className="metric-label">
            {localized(locale, "來源已過時", "Stale-source rejections")}
          </span>
        </div>
        <div>
          <span className="metric-value">
            {formatNumber(response.metrics.importedRows, locale)}
          </span>
          <span className="metric-label">
            {localized(locale, "近期匯入列數", "Recent imported rows")}
          </span>
        </div>
      </div>

      <div
        className="admin-tab-list"
        role="group"
        aria-label={localized(locale, "依類型篩選", "Filter by kind")}
      >
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
            {localized(locale, option.labelZh, option.labelEn)}
          </button>
        ))}
      </div>

      {response.exportReconciliations?.length ? (
        <section
          className="export-reconciliations"
          aria-label={localized(
            locale,
            "批量更新 XLSX 結果對帳",
            "Bulk Update XLSX reconciliations",
          )}
        >
          <h2>
            {localized(
              locale,
              "批量更新 XLSX 結果對帳",
              "Bulk Update XLSX reconciliations",
            )}
          </h2>
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

      <div
        className="pagination-controls"
        aria-label={localized(locale, "作業分頁", "Jobs pagination")}
      >
        <button
          type="button"
          onClick={() => setPage((value) => Math.max(1, value - 1))}
          disabled={page === 1 || loading}
        >
          {c.previous}
        </button>
        <span>
          {localized(locale, `第 ${page} 頁`, `Page ${page}`)}
          {response.totalMatching !== undefined
            ? localized(
                locale,
                ` · 符合 ${response.totalMatching} / 共 ${response.total} 個`,
                ` · ${response.totalMatching} matching / ${response.total} total`,
              )
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
          {c.next}
        </button>
      </div>

      {visibleEntries.length === 0 ? (
        <p className="helper-copy">
          {localized(
            locale,
            "找不到符合條件的作業紀錄。",
            "No jobs match this filter.",
          )}
        </p>
      ) : (
        <ul className="flag-list">
          {visibleEntries.map((entry) => {
            const createdAt = new Date(entry.createdAt);
            return (
              <li className="flag-item" key={`${entry.kind}:${entry.id}`}>
                <div className="flag-content">
                  <div className="jobs-row-header">
                    <h3>
                      {localized(
                        locale,
                        KIND_FILTERS.find((item) => item.value === entry.kind)!
                          .labelZh,
                        KIND_FILTERS.find((item) => item.value === entry.kind)!
                          .labelEn,
                      )}
                    </h3>
                    <span
                      className={`connection-status status-${entry.normalizedStatus}`}
                    >
                      <span aria-hidden="true" />
                      {stateLabel(entry.normalizedStatus, locale)}
                    </span>
                  </div>
                  <details>
                    <summary>
                      {localized(
                        locale,
                        "原始作業證據",
                        "Original job evidence",
                      )}
                    </summary>
                    <p>{entry.summary}</p>
                    <code>{entry.rawStatus}</code>
                  </details>
                  <div className="jobs-row-meta">
                    {localized(locale, "紀錄 ID", "Record ID")}: {entry.id} ·{" "}
                    {stateLabel(entry.normalizedStatus, locale)} ·{" "}
                    <time dateTime={formatHkDate(createdAt, locale)}>
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
                      {localized(locale, "查看上架流程", "View listing")}
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
  const locale = useLocale();
  const c = commonCopy[locale];
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
        {localized(locale, "檢視匯出紀錄", "Inspect export attempt")}
      </button>
    );
  return (
    <div className="export-attempt-detail">
      {loading && !data ? (
        <span role="status">
          {localized(locale, "正在載入匯出紀錄…", "Loading attempt…")}
        </span>
      ) : null}
      {error ? (
        <div role="alert">
          <span>{safeUiError(error, locale)}</span>
          <button type="button" onClick={reload}>
            {localized(locale, "重試載入詳情", "Retry detail")}
          </button>
        </div>
      ) : null}
      {data ? <ExportReconciliationPanel detail={data} /> : null}
    </div>
  );
}
