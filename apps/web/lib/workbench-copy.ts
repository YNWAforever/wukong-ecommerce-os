import type {
  WorkbenchReason,
  WorkbenchState,
  WorkbenchKind,
} from "@wukong/db";
import type { Locale } from "./locale";
type Copy = {
  title: string;
  intro: string;
  import: string;
  readonly: string;
  loading: string;
  error: string;
  retry: string;
  refresh: string;
  stale: string;
  observed: string;
  empty: string;
  noWork: string;
  noWorkReadonly: string;
  exportAttempt: string;
  countUnavailable: string;
  reportedQualifier: string;
  all: string;
  kind: string;
  tasks: string;
  products: string;
  recorded: string;
  updated: string;
  untitled: string;
  view: string;
  review: string;
  result: string;
  previous: string;
  next: string;
  page: string;
  guidance: string;
  steps: string[];
  caution: string;
  states: Record<WorkbenchState, string>;
  kinds: Record<WorkbenchKind, string>;
  reasons: Record<WorkbenchReason, string>;
};
export const workbenchCopy: Record<Locale, Copy> = {
  en: {
    title: "Workbench",
    intro: "Your next actions, progress and results in one place.",
    import: "Import products",
    readonly: "Read-only access. An operator can import products.",
    loading: "Loading workbench…",
    error: "Unable to load the workbench. Please retry.",
    retry: "Retry",
    refresh: "Refresh",
    stale: "Stale — showing the last successful observation.",
    observed: "Observed",
    empty: "No tasks match these filters.",
    noWork: "No work yet. Import products to get started.",
    noWorkReadonly:
      "No work yet. An operator can import products to get started.",
    exportAttempt: "Export attempt",
    countUnavailable: "Product count unavailable",
    reportedQualifier: "Operator reported; not independently verified",
    all: "All sources",
    kind: "Task source",
    tasks: "tasks · not product count",
    products: "products",
    recorded: "Recorded",
    updated: "Updated",
    untitled: "Untitled listing",
    view: "View details",
    review: "Review content",
    result: "View and report result",
    previous: "Previous",
    next: "Next",
    page: "Page",
    guidance: "Every step has a direction",
    steps: [
      "Import and preview products",
      "Inspect source data and limitations",
      "Review eligible listing content",
      "Export and record the import result",
    ],
    caution:
      "Source records do not automatically become listing drafts. A ready export does not mean SHOPLINE accepted it.",
    states: {
      attention: "Needs attention",
      progress: "In progress",
      completed: "Completed",
      unclassified: "Status unavailable",
    },
    kinds: {
      listing: "Listings",
      export: "Exports",
      website_scan: "Website scans",
      workbook_import: "Workbook imports",
    },
    reasons: {
      failed: "Failed — inspect details",
      needs_info: "More information needed",
      review: "Content awaiting review",
      delivery: "Ready for delivery",
      result_needed: "Import result needs attention",
      processing: "Processing",
      published: "Published",
      result_reported: "Import result reported",
      preview_ready: "Preview ready",
      preview_partial: "Partial preview — inspect limitations",
      imported: "Products imported",
      unknown: "Status unavailable — inspect history",
    },
  },
  "zh-Hant": {
    title: "工作台",
    intro: "集中查看待辦、進度與結果，清楚知道下一步。",
    import: "匯入商品",
    readonly: "唯讀權限。具備操作權限的成員可以匯入商品。",
    loading: "正在載入工作台…",
    error: "無法載入工作台，請重試。",
    retry: "重試",
    refresh: "重新整理",
    stale: "資料可能已過時 — 顯示上次成功讀取的資料。",
    observed: "觀察時間",
    empty: "沒有符合目前篩選條件的工作。",
    noWork: "尚未有工作。匯入商品即可開始。",
    noWorkReadonly: "尚未有工作。具備操作權限的成員可以匯入商品以開始。",
    exportAttempt: "匯出記錄",
    countUnavailable: "商品數量不可用",
    reportedQualifier: "由操作人員回報；未經獨立驗證",
    all: "全部來源",
    kind: "工作來源",
    tasks: "項工作 · 並非商品數量",
    products: "件商品",
    recorded: "記錄時間",
    updated: "更新時間",
    untitled: "未命名商品",
    view: "查看詳情",
    review: "審核內容",
    result: "查看並回報結果",
    previous: "上一頁",
    next: "下一頁",
    page: "頁",
    guidance: "每一步，都有方向",
    steps: [
      "匯入並預覽商品",
      "查看來源資料與限制",
      "審核符合條件的商品內容",
      "匯出並記錄匯入結果",
    ],
    caution:
      "來源資料不會自動成為上架草稿。匯出檔案就緒不代表 SHOPLINE 已接受。",
    states: {
      attention: "需要處理",
      progress: "處理中",
      completed: "已完成",
      unclassified: "狀態不可用",
    },
    kinds: {
      listing: "上架",
      export: "匯出",
      website_scan: "網站掃描",
      workbook_import: "工作簿匯入",
    },
    reasons: {
      failed: "未能完成 — 請查看詳情",
      needs_info: "需要補充資料",
      review: "內容等待審核",
      delivery: "準備交付",
      result_needed: "匯入結果需要處理",
      processing: "處理中",
      published: "已發佈",
      result_reported: "已回報匯入結果",
      preview_ready: "預覽已就緒",
      preview_partial: "部分預覽 — 請查看限制",
      imported: "商品已匯入",
      unknown: "狀態不可用 — 請查看紀錄",
    },
  },
};
