import type { BulkUpdateEligibilityReason } from "./bulk-update-eligibility";
import type { Locale } from "./locale";
export type LocalizedText = Readonly<Record<Locale, string>>;
export function localized(locale: Locale, zh: string, en: string) {
  return locale === "zh-Hant" ? zh : en;
}
export function formatHkDate(
  value: string | Date | null | undefined,
  locale: Locale,
): string {
  if (!value) return localized(locale, "未有資料", "not available");
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return localized(locale, "未有資料", "not available");
  return new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-HK" : "en-HK", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(date);
}
export function formatNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "zh-Hant" ? "zh-HK" : "en-HK").format(
    value,
  );
}
export const commonCopy = {
  "zh-Hant": {
    retry: "重試",
    refreshing: "正在更新結果…",
    unavailable: "未有資料",
    previous: "上一頁",
    next: "下一頁",
    clearSelection: "清除選取",
    actionError: "操作未能完成，請重試。",
    readError: "無法載入資料，請重試。",
    permissionDenied: "你沒有權限執行此操作。",
    loading: "正在載入…",
    createDraft: "建立上架草稿",
    empty: "目前沒有項目",
  },
  en: {
    retry: "Retry",
    refreshing: "Refreshing results…",
    unavailable: "not available",
    previous: "Previous",
    next: "Next",
    clearSelection: "Clear selection",
    actionError: "The action could not be completed. Please retry.",
    readError: "Unable to load data. Please retry.",
    permissionDenied: "You do not have permission to perform this action.",
    loading: "Loading…",
    createDraft: "Create draft",
    empty: "No items",
  },
} satisfies Record<Locale, Record<string, string>>;
export function safeUiError(
  error: unknown,
  locale: Locale,
  kind: "read" | "action" = "read",
) {
  return typeof error === "string" &&
    /\b(401|403|forbidden|permission)\b/i.test(error)
    ? commonCopy[locale].permissionDenied
    : kind === "action"
      ? commonCopy[locale].actionError
      : commonCopy[locale].readError;
}
const states: Record<string, readonly [string, string]> = {
  received: ["已接收", "Received"],
  processing: ["處理中", "Processing"],
  needs_info: ["需要資料", "Needs information"],
  in_review: ["待審核", "In review"],
  reopened: ["重新開啟", "Reopened"],
  approved: ["已批准", "Approved"],
  publishing: ["發佈中", "Publishing"],
  published: ["已發佈", "Published"],
  publish_failed: ["發佈失敗", "Publish failed"],
  failed: ["失敗", "Failed"],
  pending: ["待處理", "Pending"],
  running: ["進行中", "Running"],
  succeeded: ["成功", "Succeeded"],
  cancelled: ["已取消", "Cancelled"],
  ready: ["已準備", "Ready"],
  accepted: ["已回報接受", "Reported accepted"],
  rejected: ["已回報拒絕", "Reported rejected"],
};
export function stateLabel(state: string | null, locale: Locale) {
  if (state === null) return localized(locale, "未建立草稿", "No draft");
  const label = states[state];
  return label
    ? localized(locale, ...label)
    : localized(locale, "狀態未明", "Unknown status");
}
export const readinessReasons = {
  not_attested: [
    "操作員重新確認時效後可檢查資格",
    "Eligible after a fresh operator attestation",
  ],
  no_remote_link: [
    "未連結 SHOPLINE 匯入來源",
    "No imported SHOPLINE source is linked",
  ],
  header_contract_stale: [
    "匯入工作簿格式已過時",
    "Imported workbook format is outdated",
  ],
  remote_link_changed: [
    "目前 SHOPLINE 來源連結已變更",
    "The current SHOPLINE source link changed",
  ],
  version_mismatch: [
    "目前版本已變更或未能提供，請重新審核",
    "The active version changed or is unavailable. Review it again.",
  ],
  approval_receipt_missing: ["缺少批准證據", "Approval evidence is missing"],
  confirmation_missing: [
    "缺少已審核來源綁定",
    "Reviewed source binding is missing",
  ],
  source_changed: [
    "已審核來源與目前匯入不同",
    "Reviewed source differs from the current import",
  ],
  approval_required: ["需要先批准目前版本", "Approve the active version first"],
  blocking_flags: [
    "先處理未解決的阻塞標記",
    "Resolve open blocking flags first",
  ],
  confirmation_required: [
    "需要完成目前版本的全部審核確認",
    "Complete all review confirmations for the active version",
  ],
  confirmation_changed: [
    "審核確認已變更，請重新檢查並選取",
    "Review confirmations changed. Check and select the item again",
  ],
  not_import_origin: [
    "此商品不是來自批量匯入，不能使用批量更新",
    "This listing is not from a bulk import and cannot use Bulk Update",
  ],
  approval_binding_required: [
    "缺少與此版本及來源綁定的批准證據",
    "Approval evidence bound to this version and source is required",
  ],
  approval_binding_changed: [
    "批准證據與目前版本或來源不符，請重新批准",
    "Approval evidence no longer matches this version or source. Renew approval",
  ],
  source_snapshot_mismatch: [
    "保留的來源快照不符，請重新匯入及審核",
    "Retained source snapshot does not match. Reimport and review",
  ],
  raw_row_invalid: [
    "來源資料列不完整或格式無效，請重新匯入",
    "The source row is incomplete or invalid. Reimport the workbook",
  ],
  source_import_mismatch: [
    "匯入來源已變更，請重新審核來源",
    "The source import changed. Review the source again",
  ],
  row_digest_mismatch: [
    "來源資料內容已變更，請重新審核",
    "Source row content changed. Review it again",
  ],
} satisfies Record<BulkUpdateEligibilityReason, readonly [string, string]> &
  Record<string, readonly [string, string]>;
const reasons: Record<string, readonly [string, string]> = readinessReasons;
export function reasonLabel(reason: string, locale: Locale) {
  const label = reasons[reason];
  return label
    ? localized(locale, ...label)
    : localized(
        locale,
        "需要重新檢查來源及審核證據",
        "Source and review evidence need to be checked again",
      );
}
