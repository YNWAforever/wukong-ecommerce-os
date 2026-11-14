import type { Locale } from "../locale";
const copy = {
  recovered: {
    en: "Recovered the recorded artifact from its run. No generation request was sent.",
    "zh-Hant": "已從執行記錄恢復成品，沒有再次傳送產生要求。",
  },
  artifacts: { en: "Review recorded artifacts", "zh-Hant": "檢視已記錄成品" },
  title: { en: "Improve this listing", "zh-Hant": "改善這個商品" },
  entry: { en: "Start guided review", "zh-Hant": "開始引導審核" },
  selected: { en: "Open selected listing", "zh-Hant": "開啟已選商品" },
  audit: { en: "Workspace audit", "zh-Hant": "工作區概況審查" },
  gap_review: { en: "Selected-listing gaps", "zh-Hant": "已選商品的缺口" },
  copy_proposal: { en: "Copy proposal", "zh-Hant": "文案建議" },
  handoff: { en: "Reviewer handoff", "zh-Hant": "交予審核人員" },
  scope: {
    en: "The audit covers workspace records. Gap review and copy stay with this listing version. Canonical listing data stays unchanged.",
    "zh-Hant":
      "概況審查涵蓋工作區記錄。缺口檢視及文案建議綁定此商品版本，不會更改正式商品資料。",
  },
  prepareGap: { en: "Prepare gap review", "zh-Hant": "準備缺口檢視" },
  prepareCopy: { en: "Prepare copy proposal", "zh-Hant": "準備文案建議" },
  prepareAgain: { en: "Prepare another attempt", "zh-Hant": "準備再次嘗試" },
  sendHint: {
    en: "Step controls fill the composer. Review the request and press Send to run it.",
    "zh-Hant": "步驟按鈕只會填入輸入框。請檢視要求，再按「傳送」執行。",
  },
  draft: {
    en: "Send or clear your draft first. A pending retry keeps its original request.",
    "zh-Hant": "請先傳送或清除草稿。待重試的要求會保留原有內容。",
  },
  pending: {
    en: "This recorded attempt needs checking. Reload the conversation to check its result; no new request is sent.",
    "zh-Hant":
      "這次執行的結果仍需確認。請重新載入對話查閱結果；此操作不會傳送新要求。",
  },
  unavailable: {
    en: "This step has no usable result. Read the latest reply and run details before trying again.",
    "zh-Hant":
      "此步驟沒有可用結果。請先查閱最新回覆及執行詳情，再決定是否重試。",
  },
  stale: {
    en: "The selected version or quality evidence changed or is unavailable. Open the listing to start a current review.",
    "zh-Hant":
      "已選版本或品質證據已變更或無法取得。請開啟商品，開始檢視最新版本。",
  },
  noVersion: {
    en: "An active listing version is required before proposing copy.",
    "zh-Hant": "必須先有生效的商品版本，才能提出文案建議。",
  },
  aiOff: {
    en: "Copy generation needs the workspace's configured AI. Audit and gap snapshots remain available.",
    "zh-Hant": "產生文案需要工作區已設定的 AI。概況審查及缺口快照仍可使用。",
  },
  refresh: { en: "Refresh journey status", "zh-Hant": "重新整理流程狀態" },
  saveHint: {
    en: "Review and save the exact proposal using its controls below, then refresh journey status for handoff.",
    "zh-Hant":
      "請使用下方建議的控制項檢視並儲存此版本，再重新整理流程狀態以交予審核。",
  },
  ready: {
    en: "This exact proposal is saved for reviewer handoff. Reviewers use the artifact's sign-off controls; saving or signing off does not apply copy.",
    "zh-Hant":
      "此文案建議版本已儲存，可交予審核。審核人員可使用建議內的確認控制項；儲存或確認均不會套用文案。",
  },
  review: {
    en: "Open pinned listing review",
    "zh-Hant": "開啟已綁定版本的商品審核",
  },
  initialStale: {
    en: "The selected version is unavailable or changed. Reopen the listing before starting guided review.",
    "zh-Hant": "已選版本無法取得或已變更。請重新開啟商品，再開始引導審核。",
  },
  auditRequest: {
    en: "Audit workspace records before reviewing the selected listing.",
    "zh-Hant": "請先審查工作區記錄，再檢視已選商品。",
  },
  gapRequest: {
    en: "Review the recorded gaps for the selected listing version.",
    "zh-Hant": "請檢視已選商品版本的已記錄缺口。",
  },
  copyRequest: {
    en: "Propose evidence-backed copy for the selected listing version for human review.",
    "zh-Hant": "請根據已選商品版本的證據提出文案建議，供人員審核。",
  },
  gapTitle: { en: "Recorded listing gaps", "zh-Hant": "已記錄的商品缺口" },
  sample: { en: "Bounded workspace sample", "zh-Hant": "有上限的工作區樣本" },
  unknown: { en: "Not available", "zh-Hant": "無法取得" },
  noGaps: {
    en: "No gaps reported by these checks",
    "zh-Hant": "這些檢查未有記錄缺口",
  },
  more: {
    en: "Some rows or evidence are omitted by the report's bounds.",
    "zh-Hant": "部分資料或證據因報告上限而未有列出。",
  },
  history: {
    en: "Showing recent messages. Earlier artifacts remain in Outputs.",
    "zh-Hant": "現顯示最近訊息。較早的建議仍保留於「輸出」。",
  },
} as const;
export function guidedCopy(locale: Locale, key: keyof typeof copy): string {
  return copy[key][locale];
}
