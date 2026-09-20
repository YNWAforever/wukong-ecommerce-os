"use client";
import type { WineProgress } from "../lib/wine-progress";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { wineStageLabels, wineStateLabels } from "../lib/review-ui-copy";
export function WineEnrichmentProgress({
  progress,
}: {
  progress: WineProgress;
}) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en);
  // Only persisted completed/current stages are shown. Branches that never ran are not inferred.
  const stages = [
    ...new Set([
      ...progress.completedStages,
      ...(progress.stage ? [progress.stage] : []),
    ]),
  ];
  return (
    <section
      className="panel"
      aria-label={t("酒類資料處理", "Wine enrichment")}
    >
      <h2>{t("酒類資料處理", "Wine enrichment")}</h2>
      <p role="status">
        {t(
          wineStateLabels[progress.state][0],
          wineStateLabels[progress.state][1],
        )}
      </p>
      <ol>
        {stages.map((stage) => (
          <li
            key={stage}
            data-stage={stage}
            aria-current={stage === progress.stage ? "step" : undefined}
          >
            {t(wineStageLabels[stage][0], wineStageLabels[stage][1])} ·{" "}
            {progress.completedStages.includes(stage)
              ? t("已儲存", "Saved")
              : t("目前階段", "Current stage")}
          </li>
        ))}
      </ol>
      {!stages.length && (
        <p>{t("等待工作程序開始。", "Waiting for a worker.")}</p>
      )}
      <p>
        {t("阻塞問題", "Blocking issues")}:{" "}
        {progress.issues.filter((issue) => issue.blocking).length}
      </p>
      {progress.issues.length > 0 && (
        <ul>
          {progress.issues.map((issue, i) => (
            <li key={i}>
              {issue.path}: {issue.code}{" "}
              {issue.blocking
                ? t("（需處理）", "(needs attention)")
                : t("（提示）", "(notice)")}
            </li>
          ))}
        </ul>
      )}
      <p>
        {t("AI 估算費用 (USD)", "AI estimated cost (USD)")}:{" "}
        {progress.goEstimatedUsd ?? t("未知", "Unknown")} · Tavily{" "}
        {t("點數", "credits")}: {progress.tavilyCredits ?? t("未知", "Unknown")}
      </p>
      <p>
        {t(
          "商戶貨號、售價及庫存只取自你提供的資料；可稍後補充。",
          "Merchant SKU, price and stock come only from your input and can be added later.",
        )}
      </p>
      {progress.adoptedVersionId && (
        <p>
          {t(
            "歷史採納版本（可能並非目前版本）",
            "Historical adopted version (may differ from current version)",
          )}
          : <code>{progress.adoptedVersionId}</code>
        </p>
      )}
      <details>
        <summary>{t("處理參考", "Operation reference")}</summary>
        <code>{progress.runId}</code>
      </details>
    </section>
  );
}
