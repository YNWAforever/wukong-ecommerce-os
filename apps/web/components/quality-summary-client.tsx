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

import { useCallback, useId } from "react";

import type { QualitySummary } from "../lib/quality-summary";
import { useLatestRequest } from "../lib/use-latest-request";

type GapKey = keyof QualitySummary["gapCounts"];

const GAP_LABELS: ReadonlyArray<{
  key: GapKey;
  labelZh: string;
  labelEn: string;
}> = [
  {
    key: "untranslatedName",
    labelZh: "名稱未翻譯",
    labelEn: "Untranslated name",
  },
  {
    key: "untranslatedSeoTitle",
    labelZh: "SEO 標題未翻譯",
    labelEn: "Untranslated SEO title",
  },
  {
    key: "seoTitleMirrorsName",
    labelZh: "SEO 標題與商品名稱相同",
    labelEn: "SEO title mirrors name",
  },
  {
    key: "seoDescriptionMirrorsSeoTitle",
    labelZh: "SEO 簡介與 SEO 標題相同",
    labelEn: "SEO description mirrors SEO title",
  },
  {
    key: "keywordsMirrorName",
    labelZh: "關鍵字與商品名稱相同",
    labelEn: "Keywords mirror name",
  },
  { key: "summaryMissing", labelZh: "缺少摘要", labelEn: "Summary missing" },
];

export function QualitySummaryClient() {
  const locale = useLocale();
  const c = commonCopy[locale];
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
        <p>{safeUiError(error, locale)}</p>
        <button type="button" onClick={reload}>
          {c.retry}
        </button>
      </div>
    );
  if (!data) {
    return (
      <p className="helper-copy" role="status">
        {localized(locale, "正在載入內容品質摘要…", "Loading quality summary…")}
      </p>
    );
  }

  return (
    <section
      aria-label={localized(locale, "內容品質摘要", "Quality summary")}
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
          {localized(
            locale,
            "正在更新內容品質摘要…",
            "Refreshing quality summary…",
          )}
        </p>
      ) : null}
      <p className="helper-copy">
        {localized(
          locale,
          `工作區目前版本：共 ${data.totalListings ?? c.unavailable} 個商品，已評估 ${formatNumber(data.totalAssessed, locale)} 個；${data.noActiveVersion ?? c.unavailable} 個未有目前版本；${data.unassessableActiveVersion ?? c.unavailable} 個無法評估。統計於有界掃描期間觀察，AI 成本涵蓋工作區完整歷史。`,
          `Workspace active versions: ${formatNumber(data.totalAssessed, locale)} assessed of ${data.totalListings ?? "unavailable"}; ${data.noActiveVersion ?? "unavailable"} without an active version; ${data.unassessableActiveVersion ?? "unavailable"} unassessable. Counts were observed during a bounded scan. AI cost covers all history for workspace listings.`,
        )}
        {data.scanStartedAt && data.scanCompletedAt ? (
          <span>
            {" "}
            {formatHkDate(data.scanStartedAt, locale)} –{" "}
            {formatHkDate(data.scanCompletedAt, locale)}
          </span>
        ) : null}
      </p>
      <div
        className="metric-strip quality-metric-strip"
        aria-label={localized(locale, "內容品質統計", "Quality metrics")}
      >
        <div role="group" aria-labelledby={totalAssessedLabelId}>
          <span className="metric-value">
            {formatNumber(data.totalAssessed, locale)}
          </span>
          <span className="metric-label" id={totalAssessedLabelId}>
            {localized(locale, "已評估商品", "Total assessed")}
          </span>
        </div>
        <div role="group" aria-labelledby={cleanLabelId}>
          <span className="metric-value">
            {formatNumber(data.cleanCount, locale)}
          </span>
          <span className="metric-label" id={cleanLabelId}>
            {localized(locale, "無缺口", "Clean")}
          </span>
        </div>
        <div role="group" aria-labelledby={hasGapsLabelId}>
          <span className="metric-value">
            {formatNumber(data.hasGapsCount, locale)}
          </span>
          <span className="metric-label" id={hasGapsLabelId}>
            {localized(locale, "有缺口", "Has gaps")}
          </span>
        </div>
        <div role="group" aria-labelledby={totalCostLabelId}>
          <span className="metric-value">
            {new Intl.NumberFormat(locale === "zh-Hant" ? "zh-HK" : "en-HK", {
              style: "currency",
              currency: "USD",
            }).format(data.totalCostUsd)}
          </span>
          <span className="metric-label" id={totalCostLabelId}>
            {localized(locale, "AI 總成本", "Total AI cost")}
          </span>
        </div>
      </div>

      <table className="members-table">
        <thead>
          <tr>
            <th>{localized(locale, "內容缺口訊號", "Gap signal")}</th>
            <th>{localized(locale, "數量", "Count")}</th>
          </tr>
        </thead>
        <tbody>
          {GAP_LABELS.map((gap) => (
            <tr key={gap.key}>
              <td>{localized(locale, gap.labelZh, gap.labelEn)}</td>
              <td>{formatNumber(data.gapCounts[gap.key], locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
