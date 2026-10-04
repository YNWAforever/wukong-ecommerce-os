"use client";
import { ReviewQualityMetricsPanel } from "./review-quality-metrics-panel";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  safeUiError,
  formatNumber,
  formatHkDate,
} from "../lib/ui-copy";

import { useCallback, useEffect, useId } from "react";
import Link from "next/link";
import { SupportRequestId } from "./support-request-id";
import { safeResponseError } from "../lib/support-request-id";

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
    labelZh: "名稱需檢查用字",
    labelEn: "Check name wording",
  },
  {
    key: "untranslatedSeoTitle",
    labelZh: "SEO 標題需檢查用字",
    labelEn: "Check SEO title wording",
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
    if (!response.ok) {
      const cause = await safeResponseError(response);
      if (response.status === 401 || response.status === 403)
        cause.message = "quality-access-unavailable";
      throw cause;
    }
    return (await response.json()) as QualitySummary;
  }, []);
  const { data, error, supportId, loading, stale, reload } = useLatestRequest(
    load,
    "Unable to load quality summary",
  );
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") reload();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  if (error && (!data || error === "quality-access-unavailable"))
    return (
      <div className="load-error" role="alert">
        <p>{safeUiError(error, locale)}</p>
        <SupportRequestId value={supportId} />
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
          <SupportRequestId value={supportId} />
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
      <button type="button" onClick={reload} disabled={loading}>
        {localized(locale, "更新統計", "Refresh counts")}
      </button>
      <section aria-label={localized(locale, "文案缺口", "Copy gaps")}>
        <h2>{localized(locale, "文案缺口", "Copy gaps")}</h2>
        <p className="helper-copy">
          {localized(
            locale,
            `工作區目前已儲存內容：共 ${data.totalListings ?? c.unavailable} 個商品，已評估 ${formatNumber(data.totalAssessed, locale)} 個；${data.missingCurrentContent ?? c.unavailable} 個未有內容；${data.invalidCurrentContent ?? c.unavailable} 個內容無法評估。只反映文案缺口，不代表事實已核實或可交付。專名相同可能合理，需檢查用字而非直接判錯。`,
            `Workspace current saved content: ${formatNumber(data.totalAssessed, locale)} assessed of ${data.totalListings ?? "unavailable"}; ${data.missingCurrentContent ?? "unavailable"} missing content; ${data.invalidCurrentContent ?? "unavailable"} invalid content. Copy signals do not establish factual accuracy or delivery readiness. Identical proper names can be valid; check wording instead of treating equality as an error.`,
          )}
          {data.scanStartedAt && data.scanCompletedAt ? (
            <span>
              {" "}
              {formatHkDate(data.scanStartedAt, locale)} –{" "}
              {formatHkDate(data.scanCompletedAt, locale)}
            </span>
          ) : null}
        </p>
        <p data-quality-projection role="status" className="helper-copy">
          {data.projection
            ? localized(
                locale,
                data.projection.stale || data.projection.state !== "ready"
                  ? `內容統計未完成：待重算 ${data.projection.pendingCount}；失敗 ${data.projection.failedCount}。待更新及失敗內容未計作無文案缺口。`
                  : "目前內容統計已更新；交付仍需逐件核對。",
                data.projection.stale || data.projection.state !== "ready"
                  ? `Counts are incomplete: ${data.projection.pendingCount} pending; ${data.projection.failedCount} failed. Pending and failed content is excluded from no-copy-gap counts.`
                  : "Current content counts updated; delivery still requires per-item checks.",
              )
            : localized(
                locale,
                "統計更新狀態未有資料；不能視為完成。",
                "Count freshness is unavailable; completion is unverified.",
              )}
          {data.projection?.asOf ? (
            <>
              {" "}
              <time dateTime={data.projection.asOf}>
                {formatHkDate(data.projection.asOf, locale)}
              </time>
            </>
          ) : null}
        </p>
        <div
          role="group"
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
              {localized(locale, "無文案缺口訊號", "No copy-gap signals")}
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
              {localized(locale, "已知 AI 成本", "Known AI cost")}
            </span>
          </div>
        </div>

        <table className="members-table">
          <thead>
            <tr>
              <th>{localized(locale, "文案缺口訊號", "Copy-gap signal")}</th>
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
      <section aria-label={localized(locale, "事實證據", "Fact evidence")}>
        <h2>{localized(locale, "事實證據", "Fact evidence")}</h2>
        <p>
          {localized(
            locale,
            "事實證據未彙總。請逐件查看來源、年份、容量、包裝及未確認事項；文案相同或沒有缺口不會核實產品事實。",
            "Fact evidence is not aggregated. Inspect each item's sources, vintage, volume, packaging and unknown facts. Copy equality or absence of copy gaps does not verify product facts.",
          )}
        </p>
        <Link href="/catalog">
          {localized(locale, "查看商品及来源", "Inspect items and sources")}
        </Link>
      </section>
      <section aria-label={localized(locale, "人工核實", "Human verification")}>
        <h2>{localized(locale, "人工核實", "Human verification")}</h2>
        <p>
          {localized(
            locale,
            "目前版本的人工核實未彙總，請逐件查看確認清單。下列最近 30 日指標是保留的審核證據，不能代替目前版本確認或 AI 準確度。",
            "Current-version human verification is not aggregated; inspect each item's checklist. The following 30-day retained review metrics do not replace current-version confirmation or measure AI accuracy.",
          )}
        </p>
        <ReviewQualityMetricsPanel metrics={data.reviewMetrics} />
      </section>
      <section aria-label={localized(locale, "交付條件", "Delivery readiness")}>
        <h2>{localized(locale, "交付條件", "Delivery readiness")}</h2>
        <p>
          {localized(
            locale,
            "交付條件須逐件即時核對目前版本、來源、人工確認及批准。這頁統計不會批准、匯出或證明商店已更新。",
            "Delivery requires live per-item checks of current version, sources, confirmations and approval. These counts neither authorize approval/export nor prove the store was updated.",
          )}
        </p>
        <Link href="/catalog">
          {localized(locale, "查看商品交付條件", "Inspect delivery readiness")}
        </Link>
      </section>
      <section
        data-quality-costs
        aria-label={localized(locale, "AI 成本對帳", "AI cost reconciliation")}
      >
        <h2>{localized(locale, "AI 成本對帳", "AI cost reconciliation")}</h2>
        <p>
          {localized(
            locale,
            "已知成本涵蓋工作區商品保留的全部 AI 執行歷史；未知成本另列，不能當作零。",
            "Known cost covers retained AI-run history for workspace listings. Unknown costs remain separate and are not zero.",
          )}
        </p>
        {data.unknownCostReferences?.asOf ? (
          <p>
            {localized(locale, "成本觀察時間：", "Cost observed at: ")}
            <time dateTime={data.unknownCostReferences.asOf}>
              {formatHkDate(data.unknownCostReferences.asOf, locale)}
            </time>
          </p>
        ) : null}
        {data.unknownCostRunCount > 0 && (
          <p className="helper-copy">
            {localized(
              locale,
              `另有 ${formatNumber(data.unknownCostRunCount, locale)} 次執行成本未確認`,
              `${formatNumber(data.unknownCostRunCount, locale)} runs have unknown cost`,
            )}
          </p>
        )}
        {data.unknownCostReferences?.items.length ? (
          <ul>
            {data.unknownCostReferences.items.map((item) => (
              <li key={item.aiRunId}>
                <code>{item.aiRunId}</code>
                {" · "}
                {item.batchId ? (
                  <Link href={`/batches/${encodeURIComponent(item.batchId)}`}>
                    {localized(locale, "查看批次對帳", "Reconcile batch")}
                  </Link>
                ) : (
                  <>
                    <Link
                      href={`/listings/${encodeURIComponent(item.listingId)}`}
                    >
                      {localized(locale, "查看商品", "Inspect listing")}
                    </Link>
                    {" · "}
                    {localized(
                      locale,
                      "未有批次綁定；執行編號保留供支援核對，目前商品可能已有新版本。",
                      "No batch binding; retain this run ID for support. Current listing content may be newer.",
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : data.unknownCostRunCount > 0 ? (
          <p>
            {localized(
              locale,
              "執行參照未有資料；請保留支援編號核對。",
              "Run references unavailable; retain the support ID for reconciliation.",
            )}
          </p>
        ) : null}
        {data.unknownCostReferences?.hasMore ? (
          <p>
            {localized(
              locale,
              "只顯示有界的執行參照；其餘紀錄仍計入總數。請按批次對帳或聯絡工作區管理員。",
              "Only a bounded set of run references is shown; remaining records still count toward the total. Reconcile by batch or contact a workspace admin.",
            )}
          </p>
        ) : null}
      </section>
    </section>
  );
}
