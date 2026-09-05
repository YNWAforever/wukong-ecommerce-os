"use client";
import type { ReviewQualityMetrics } from "../lib/review-quality-metrics";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  formatHkDate,
  formatNumber,
} from "../lib/ui-copy";
export function ReviewQualityMetricsPanel({
  metrics,
}: {
  metrics?: ReviewQualityMetrics;
}) {
  const locale = useLocale(),
    c = commonCopy[locale];
  const rows = metrics
    ? [
        {
          label: localized(
            locale,
            "版本觀察批准比例",
            "Observed version approval fraction",
          ),
          metric: metrics.approvalFraction,
          unit: localized(locale, "版本", "versions"),
        },
        {
          label: localized(
            locale,
            "版本建立至首次批准平均時間（小時）",
            "Mean creation-to-first-approval time (hours)",
          ),
          metric: metrics.creationToApprovalMs,
          unit: localized(
            locale,
            "已批准版本；分子為毫秒",
            "approved versions; numerator in milliseconds",
          ),
          divisor: 3600000,
        },
        {
          label: localized(
            locale,
            "記錄編輯欄位變更比例",
            "Recorded edit field-change fraction",
          ),
          metric: metrics.humanEditedFieldFraction,
          unit: localized(
            locale,
            "合資格版本配對的內容欄位",
            "content fields across qualified version pairs",
          ),
        },
      ]
    : [];
  return (
    <section
      aria-label={localized(locale, "審核證據指標", "Review evidence metrics")}
    >
      <h2>{localized(locale, "審核證據指標", "Review evidence metrics")}</h2>
      <p className="helper-copy">
        {localized(
          locale,
          "最近 30 日工作區保留證據。批准比例以期間建立的所有版本為分母，截至統計時間；較新版本仍可能待批。時間由版本建立時計算，並非人工審核工時。欄位變更比例為每個合資格配對的變更欄位數除以八；只包括八個欄位齊全且非空白的配對，空白或缺漏內容不計算。並非 AI 準確度或字元編輯距離。",
          "Retained workspace evidence over 30 days. Approval uses all versions created in the window, observed as of the end; newer versions may still await approval. Time starts at version creation, not reviewer work. Field changes count changed fields / eight per qualified pair. Only pairs with all eight fields present and nonempty qualify; empty or missing content is excluded; this is not AI accuracy or character edit distance.",
        )}
      </p>
      {metrics ? (
        <>
          <p>
            {formatHkDate(metrics.window.start, locale)} –{" "}
            {formatHkDate(metrics.window.end, locale)}
          </p>
          <dl>
            {rows.map(({ label, metric, unit, divisor }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {metric.value === null
                    ? c.unavailable
                    : formatNumber(metric.value / (divisor ?? 1), locale)}{" "}
                  ·{" "}
                  {localized(locale, "分子 / 分母", "Numerator / denominator")}:{" "}
                  {metric.numerator === null
                    ? c.unavailable
                    : formatNumber(metric.numerator, locale)}{" "}
                  /{" "}
                  {metric.denominator === null
                    ? c.unavailable
                    : formatNumber(metric.denominator, locale)}{" "}
                  {unit}
                  {metric.reason ? (
                    <p>
                      {metric.reason === "evidence_limit"
                        ? localized(
                            locale,
                            "超過 1,000 筆編輯事件上限；不提供部分樣本比例。",
                            "More than 1,000 edit events; no partial-population fraction is reported.",
                          )
                        : localized(
                            locale,
                            "沒有完整合資格證據；不能視為零。",
                            "No complete qualifying evidence; unavailable is not zero.",
                          )}
                    </p>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="helper-copy">
            {localized(
              locale,
              `排除／合併：重複批准 ${metrics.exclusions.duplicateApprovals}；無效或群組外批准 ${metrics.exclusions.invalidOrOutsideCohortApprovals}；未符合資格編輯 ${metrics.exclusions.invalidEdits ?? c.unavailable}；重複編輯 ${metrics.exclusions.duplicateEdits ?? c.unavailable}。`,
              `Excluded / collapsed: duplicate approvals ${metrics.exclusions.duplicateApprovals}; invalid or outside-cohort approvals ${metrics.exclusions.invalidOrOutsideCohortApprovals}; unqualified edits ${metrics.exclusions.invalidEdits ?? c.unavailable}; duplicate edits ${metrics.exclusions.duplicateEdits ?? c.unavailable}.`,
            )}
          </p>
        </>
      ) : (
        <p>
          {localized(
            locale,
            "審核證據未能提供；分母未有資料。",
            "Review evidence unavailable; denominator unavailable.",
          )}
        </p>
      )}
    </section>
  );
}
