import type { Locale } from "./locale";
import type { ExportManifestOutcome } from "./bulk-export-service";
import { readinessReasons, reasonLabel, localized } from "./ui-copy";
const outcomes = {
  excluded_unapproved: ["尚未批准，未納入", "Excluded, approval required"],
  excluded_blocked: ["仍有阻塞提示，未納入", "Excluded, blocking flags"],
  excluded_unconfirmed: [
    "審核確認未完成，未納入",
    "Excluded, confirmations incomplete",
  ],
  included: ["已納入", "Included"],
  excluded_no_op: ["無變更，未納入", "Excluded, no changes"],
  excluded_stale: ["來源已過時，未納入", "Excluded, stale source"],
  not_import_origin: ["非匯入來源，未納入", "Excluded, not import-origin"],
  raw_row_invalid: ["來源資料無效，未納入", "Excluded, invalid source row"],
  listing_not_found: ["找不到商品，未納入", "Excluded, listing not found"],
} satisfies Record<ExportManifestOutcome, readonly [string, string]>;
const outcomeLabels: Record<string, readonly [string, string]> = outcomes;
export function outcomeLabel(outcome: string, locale: Locale) {
  const value = outcomeLabels[outcome];
  return value
    ? localized(locale, ...value)
    : localized(
        locale,
        "未納入，請重新檢查資格",
        "Excluded; review eligibility again",
      );
}

export function manifestReasonLabel(
  reason: string | undefined,
  outcome: string,
  locale: Locale,
) {
  if (reason && Object.hasOwn(readinessReasons, reason))
    return reasonLabel(reason, locale);
  if (outcome === "excluded_no_op")
    return localized(
      locale,
      "可更新欄位沒有變更",
      "No enrichable fields changed",
    );
  if (reason) return reasonLabel(reason, locale);
  return localized(locale, "未提供其他原因", "No additional reason provided");
}
