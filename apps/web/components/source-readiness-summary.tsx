"use client";
import type { SourceReadiness } from "../lib/source-readiness";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  formatHkDate,
  reasonLabel,
} from "../lib/ui-copy";
export function SourceReadinessSummary({
  readiness,
  compact = false,
}: {
  readiness?: SourceReadiness;
  compact?: boolean;
}) {
  const locale = useLocale();
  const c = commonCopy[locale];
  if (!readiness)
    return (
      <span className="source-readiness unknown">
        {localized(locale, "來源準備狀態不明", "Source readiness unknown")}
      </span>
    );
  const reviewed = readiness.reviewedBinding;
  return (
    <div className={compact ? "source-readiness compact" : "source-readiness"}>
      <strong>
        {readiness.eligibleAfterAttestation
          ? localized(
              locale,
              "來源可供資格檢查",
              "Source ready for eligibility check",
            )
          : localized(locale, "來源需要處理", "Source action required")}
      </strong>
      <span>{reasonLabel(readiness.reason, locale)}</span>
      <span>
        {localized(locale, "匯入", "Import")}:{" "}
        {readiness.sourceImportId ?? c.unavailable}
      </span>
      <span>
        {localized(
          locale,
          "商戶確認的匯出時間",
          "Merchant-attested export time",
        )}
        : {formatHkDate(readiness.merchantAttestedExportAt, locale)}
      </span>
      <span>
        {localized(locale, "已審核綁定", "Reviewed binding")}:{" "}
        {reviewed ? (
          <>
            {localized(locale, "修訂", "revision")} {reviewed.revision} ·{" "}
            {localized(locale, "版本", "version")} {reviewed.versionId} ·{" "}
            {localized(locale, "匯入", "import")}{" "}
            {reviewed.sourceImportId ?? c.unavailable}
          </>
        ) : (
          c.unavailable
        )}
      </span>
      <small>
        {localized(
          locale,
          "僅供參考。尚未確認時效，SHOPLINE 接受結果未經核實。",
          "Advisory only. Freshness is not attested and SHOPLINE acceptance is unverified.",
        )}
      </small>
    </div>
  );
}
