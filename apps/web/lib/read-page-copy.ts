import type { Locale } from "./locale";
export const readPageCopy = {
  catalog: {
    "zh-Hant": {
      eyebrow: "商品營運",
      title: "由平台商品到可發佈草稿，一頁掌握營運狀態。",
      description:
        "查看 SHOPLINE 商品鏡像、草稿連結、審核進度與阻塞項目，優先處理最接近發佈的商品。",
    },
    en: {
      eyebrow: "Catalog operations",
      title: "Track platform products and listing drafts in one place.",
      description:
        "Review SHOPLINE source records, draft links, review progress and blockers.",
    },
  },
  dashboard: {
    "zh-Hant": {
      eyebrow: "工作區總覽",
      title: "今天先處理最接近上架的商品。",
      description: "AI 只提出有來源的建議；你保留最後的審核權。",
    },
    en: {
      eyebrow: "Workspace overview",
      title: "Focus on the products closest to delivery.",
      description:
        "AI suggests source-backed content. You keep the final review decision.",
    },
  },
  queue: {
    "zh-Hant": {
      eyebrow: "工作佇列",
      title: "依狀態排序的完整工作佇列",
      description: "檢視所有進行中商品，並批量批准已符合條件的項目。",
    },
    en: {
      eyebrow: "Work queue",
      title: "Your complete work queue, grouped by status",
      description:
        "Review workspace listings and approve eligible items in batches.",
    },
  },
  jobs: {
    "zh-Hant": {
      eyebrow: "作業記錄",
      title: "批次、發佈、AI 流程與匯出，一頁掌握所有內部作業。",
      description:
        "查看批次任務、發佈工作、AI 處理流程與匯出紀錄的最新狀態，快速找出卡住或失敗的作業。",
    },
    en: {
      eyebrow: "Jobs ledger",
      title: "Track batches, delivery, AI processing and exports.",
      description:
        "Review internal job status and identify stalled or failed work.",
    },
  },
  quality: {
    "zh-Hant": {
      eyebrow: "內容品質",
      title: "內容品質總覽，誠實反映目前內容。",
      description:
        "六項內容缺口訊號與 AI 總成本，皆根據商品目前的實際內容計算，而非匯入當下的舊快照。",
    },
    en: {
      eyebrow: "Quality",
      title: "Content quality based on current evidence.",
      description:
        "Six content gap signals reflect current product content. AI cost covers retained workspace history.",
    },
  },
} satisfies Record<
  string,
  Record<Locale, { eyebrow: string; title: string; description: string }>
>;
