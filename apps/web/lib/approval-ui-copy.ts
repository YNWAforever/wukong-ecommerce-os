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
  // Used to mean two reads of the same link raced -- nothing an operator
  // could act on. It now means the source moved after they confirmed it,
  // which they can: review the current content and confirm again.
  row_digest_mismatch: [
    "來源資料在你確認之後已變更，請重新檢視並確認。",
    "The source changed after you confirmed it. Review it again and confirm.",
  ],
  attestation_incomplete: [
    "此確認未涵蓋你選取的商品，請重新確認後再試。",
    "This confirmation does not cover the listings you selected. Confirm again and retry.",
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

/**
 * The same failures, said to someone already looking at the listing.
 *
 * A separate table rather than a shared one, because every remedy above ends in
 * "select it again" -- correct on the bulk queue, meaningless on a screen with
 * no selection. The review screen showed none of them: it discarded the
 * response body and rendered one generic sentence for the whole 409/422 family,
 * so "the AI is still working on this", "your copy of this page is stale" and
 * "resolve the flags below" were indistinguishable.
 *
 * Returns null for an unrecognised code so the caller keeps its own fallback.
 * A code with copy here MUST be one a route this screen calls actually throws:
 * codes like `reason_short` are set locally by components and never appear in a
 * response body, so they do not belong in a table keyed on server codes.
 */
const reviewErrors = {
  stale_version: [
    "這個頁面顯示的是較舊的版本，請重新載入後再試一次，以免蓋掉別人的修改。",
    "This page is showing an older version. Reload before trying again, so you do not overwrite someone else's change.",
  ],
  version_conflict: [
    "版本在此頁面載入後已變更，請重新載入並再看一次內容，然後重新批准。",
    "The version changed after this page loaded. Reload, read the content again, then approve.",
  ],
  listing_busy: [
    "AI 仍在處理這個商品，請等它完成再儲存。",
    "The AI is still processing this listing. Wait for it to finish before saving.",
  ],
  listing_publishing: [
    "商品正在發佈中，完成之前無法修改。",
    "This listing is being published. It cannot be changed until that finishes.",
  ],
  confirmation_incomplete: [
    "請先完成下方的確認清單，再批准。",
    "Complete the confirmation checklist below before approving.",
  ],
  confirmation_ledger_stale: [
    "確認清單在此頁面載入後已變更，請重新載入並再檢查一次。",
    "The confirmation checklist changed after this page loaded. Reload and check it again.",
  ],
  confirmation_source_stale: [
    "確認清單屬於較舊的來源資料，請重新載入並重新審核來源。",
    "The checklist belongs to older source data. Reload and review the source again.",
  ],
  source_origin_changed: [
    "匯入來源連結已變更，請重新載入並重新審核來源。",
    "The imported source link changed. Reload and review the source again.",
  ],
  source_freshness_required: [
    "缺少已審核的來源資料，請重新載入並審核來源後再批准。",
    "Reviewed source details are missing. Reload, review the source, then approve.",
  ],
  source_snapshot_required: [
    "來源快照缺失或已變更，請重新匯入此商品後再批准。",
    "The source snapshot is missing or changed. Reimport this product before approving.",
  ],
  blocking_flags: [
    "請先處理下方未解決的合規標記。",
    "Resolve the open compliance flags below first.",
  ],
  image_approval_required: [
    "請先在商品照區接受最終白底商品照。",
    "Accept the final white-background image in the product image section first.",
  ],
  approval_required: [
    "沒有可交付的已批准版本，請先批准這個商品。",
    "There is no approved version to deliver. Approve this listing first.",
  ],
  published_delivery_missing: [
    "商品已標記為已發佈，但沒有留下交付紀錄，請聯絡管理員再重試。",
    "This listing is marked published but kept no delivery record. Ask an administrator before retrying.",
  ],
  flag_not_found: [
    "這個合規標記已不存在，請重新載入頁面。",
    "That compliance flag no longer exists. Reload the page.",
  ],
  listing_not_found: ["這個商品已不存在。", "This listing no longer exists."],
  invalid_request: [
    "送出的內容未通過驗證，請檢查欄位後再試。",
    "The submitted content did not pass validation. Check the fields and try again.",
  ],
  validation_error: [
    "送出的內容未通過驗證，請檢查欄位後再試。",
    "The submitted content did not pass validation. Check the fields and try again.",
  ],
} satisfies Record<string, readonly [string, string]>;

export function reviewErrorLabel(
  code: string | undefined,
  locale: Locale,
): string | null {
  if (!code) return null;
  const copy = (reviewErrors as Record<string, readonly [string, string]>)[
    code
  ];
  return copy ? localized(locale, ...copy) : null;
}

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
