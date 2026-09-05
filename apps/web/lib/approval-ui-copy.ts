import type { Locale } from "./locale";
import { localized } from "./ui-copy";

// Approval remedies intentionally differ from export eligibility: an absent
// approvable version cannot be resolved by asking the operator to approve it.
const approvalErrors = {
  review_context_required: [
    "開啟商品，完成審核後重新選取。",
    "Open the listing, complete its review, then select it again.",
  ],
  listing_not_found: [
    "商品已不存在，請重新載入佇列並清除選取。",
    "The listing no longer exists. Reload the queue and clear its selection.",
  ],
  approval_required: [
    "沒有可批准的 SHOPLINE 版本，請開啟商品並檢查目標及目前草稿。",
    "No approvable SHOPLINE version is available. Open the listing and check its target and current draft.",
  ],
  version_conflict: [
    "版本已變更，請重新載入商品、審核並重新選取。",
    "The listing version changed. Reload the listing, review it and select it again.",
  ],
  version_mismatch: [
    "目前版本已變更或不存在，請重新載入商品、審核並重新選取。",
    "The active version changed or is unavailable. Reload the listing, review it and select it again.",
  ],
  confirmation_ledger_stale: [
    "確認清單已變更，請重新載入商品、檢查清單並重新選取。",
    "The confirmation checklist changed. Reload the listing, check the checklist and select it again.",
  ],
  confirmation_incomplete: [
    "請開啟商品並完成確認清單，再重新選取。",
    "Open the listing and complete the confirmation checklist, then select it again.",
  ],
  source_origin_changed: [
    "匯入來源連結已變更，請重新審核商品並重新選取。",
    "The imported source link changed. Review the listing and select it again.",
  ],
  source_freshness_required: [
    "缺少已審核的來源資料，請重新載入商品、審核來源並重新選取。",
    "Reviewed source details are missing. Reload the listing, review its source and select it again.",
  ],
  no_remote_link: [
    "找不到來源連結，請重新匯入商品並審核。",
    "The source link is missing. Reimport the product and review it.",
  ],
  source_import_mismatch: [
    "匯入來源已變更，請重新載入商品、審核來源並重新選取。",
    "The source import changed. Reload the listing, review its source and select it again.",
  ],
  row_digest_mismatch: [
    "來源內容已變更，請重新載入商品、審核來源並重新選取。",
    "The source content changed. Reload the listing, review its source and select it again.",
  ],
  confirmation_source_stale: [
    "確認清單屬於舊來源，請重新載入商品、審核來源及清單並重新選取。",
    "The confirmation checklist belongs to older source data. Reload the listing, review its source and checklist, then select it again.",
  ],
  source_snapshot_required: [
    "來源快照缺失或已變更，請重新匯入此商品並審核後再批准。",
    "The source snapshot is missing or changed. Reimport this product and review it before approving.",
  ],
  blocking_flags: [
    "請先處理商品未解決的合規標記，再重新選取。",
    "Resolve the listing's open compliance flags, then select it again.",
  ],
  forbidden: [
    "你沒有權限批准此商品。",
    "You do not have permission to approve this listing.",
  ],
} satisfies Record<string, readonly [string, string]>;

export function approvalErrorLabel(code: string, locale: Locale): string {
  const copy = (approvalErrors as Record<string, readonly [string, string]>)[
    code
  ];
  return copy
    ? localized(locale, ...copy)
    : localized(
        locale,
        "批准未能完成，請重新載入佇列並檢查商品，再重新選取。",
        "Approval could not be completed. Reload the queue and inspect the listing, then select it again.",
      );
}
