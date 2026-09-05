"use client";

import { useCallback, useId } from "react";

import type { QualitySummary } from "../lib/quality-summary";
import { useLatestRequest } from "../lib/use-latest-request";

type GapKey = keyof QualitySummary["gapCounts"];

const GAP_LABELS: ReadonlyArray<{ key: GapKey; label: string }> = [
  { key: "untranslatedName", label: "名稱未翻譯 Untranslated name" },
  {
    key: "untranslatedSeoTitle",
    label: "SEO 標題未翻譯 Untranslated SEO title",
  },
  {
    key: "seoTitleMirrorsName",
    label: "SEO 標題與商品名稱相同 SEO title mirrors name",
  },
  {
    key: "seoDescriptionMirrorsSeoTitle",
    label: "SEO 簡介與 SEO 標題相同 SEO description mirrors SEO title",
  },
  {
    key: "keywordsMirrorName",
    label: "關鍵字與商品名稱相同 Keywords mirror name",
  },
  { key: "summaryMissing", label: "缺少摘要 Summary missing" },
];

function formatUsd(amountUsd: number): string {
  return `$${amountUsd.toFixed(2)}`;
}

export function QualitySummaryClient() {
  const totalAssessedLabelId = useId();
  const cleanLabelId = useId();
  const hasGapsLabelId = useId();
  const totalCostLabelId = useId();

  const load = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/quality", { cache: "no-store", signal });
    if (!response.ok)
      throw new Error(`Unable to load quality summary (${response.status})`);
    return (await response.json()) as QualitySummary;
  }, []);
  const { data, error, loading, stale, reload } = useLatestRequest(
    load,
    "Unable to load quality summary",
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
        正在載入內容品質摘要… Loading quality summary…
      </p>
    );
  }

  return (
    <section aria-label="內容品質摘要" aria-busy={loading}>
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
          Refreshing quality summary…
        </p>
      ) : null}
      <p className="helper-copy">
        Workspace active versions: {data.totalAssessed} assessed of{" "}
        {data.totalListings ?? "unavailable"};{" "}
        {data.noActiveVersion ?? "unavailable"} without an active version;{" "}
        {data.unassessableActiveVersion ?? "unavailable"} unassessable. Counts
        were observed during a bounded scan
        {data.scanStartedAt && data.scanCompletedAt
          ? ` from ${data.scanStartedAt} to ${data.scanCompletedAt}`
          : ""}
        . AI cost covers all history for workspace listings.
      </p>
      <div
        className="metric-strip quality-metric-strip"
        aria-label="內容品質統計"
      >
        <div role="group" aria-labelledby={totalAssessedLabelId}>
          <span className="metric-value">{data.totalAssessed}</span>
          <span className="metric-label" id={totalAssessedLabelId}>
            已評估商品 <small>Total assessed</small>
          </span>
        </div>
        <div role="group" aria-labelledby={cleanLabelId}>
          <span className="metric-value">{data.cleanCount}</span>
          <span className="metric-label" id={cleanLabelId}>
            無缺口 <small>Clean</small>
          </span>
        </div>
        <div role="group" aria-labelledby={hasGapsLabelId}>
          <span className="metric-value">{data.hasGapsCount}</span>
          <span className="metric-label" id={hasGapsLabelId}>
            有缺口 <small>Has gaps</small>
          </span>
        </div>
        <div role="group" aria-labelledby={totalCostLabelId}>
          <span className="metric-value">{formatUsd(data.totalCostUsd)}</span>
          <span className="metric-label" id={totalCostLabelId}>
            AI 總成本 <small>Total AI cost</small>
          </span>
        </div>
      </div>

      <table className="members-table">
        <thead>
          <tr>
            <th>內容缺口訊號 Gap signal</th>
            <th>數量 Count</th>
          </tr>
        </thead>
        <tbody>
          {GAP_LABELS.map((gap) => (
            <tr key={gap.key}>
              <td>{gap.label}</td>
              <td>{data.gapCounts[gap.key]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
