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

/**
 * Failure copy for the export route's own error codes -- returned instead of
 * a manifest at all, before any per-listing outcome exists. Distinct from
 * `manifestReasonLabel`/`readinessReasons`, which explain why one listing
 * inside a completed manifest was excluded.
 *
 * A separate table from `approvalErrors` in `approval-ui-copy.ts` rather than
 * a shared one, even where a code and its meaning coincide (`attestation_incomplete`
 * is currently only ever thrown by this route, not the approve routes) --
 * that table's own doc comment explains why approval and export remedies are
 * kept apart, and `approvalErrorLabel`'s generic fallback ("Approval could
 * not be completed...") would be wrong copy for an export failure.
 *
 * Returns null for an unrecognised code so the caller keeps its own generic
 * fallback (mirrors `reviewErrorLabel`).
 */
const exportErrors = {
  attestation_incomplete: [
    "此確認未涵蓋你選取的商品，請重新確認後再試。",
    "This confirmation does not cover the listings you selected. Confirm again and retry.",
  ],
} satisfies Record<string, readonly [string, string]>;

export function exportErrorLabel(
  code: string | undefined,
  locale: Locale,
): string | null {
  if (!code) return null;
  const copy = (exportErrors as Record<string, readonly [string, string]>)[
    code
  ];
  return copy ? localized(locale, ...copy) : null;
}
