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
      title: "工作佇列",
      description: "檢視所有進行中商品，並批量批准已符合條件的項目。",
    },
    en: {
      eyebrow: "Work queue",
      title: "Work Queue",
      description:
        "Review workspace listings and approve eligible items in batches.",
    },
  },
  jobs: {
    "zh-Hant": {
      eyebrow: "作業記錄",
      title: "所有作業",
      description:
        "查看批次任務、發佈工作、AI 處理流程與匯出紀錄的最新狀態，快速找出卡住或失敗的作業。",
    },
    en: {
      eyebrow: "Jobs ledger",
      title: "All jobs",
      description:
        "Review internal job status and identify stalled or failed work.",
    },
  },
  quality: {
    "zh-Hant": {
      eyebrow: "內容品質",
      title: "內容品質",
      description:
        "查看目前文案缺口、事實證據、人工核實與交付條件，並核對保留的 AI 成本。未完成更新的統計會清楚標示。",
    },
    en: {
      eyebrow: "Quality",
      title: "Content quality",
      description:
        "Inspect current copy gaps, fact evidence, human verification and delivery readiness alongside retained AI costs. Incomplete counts remain explicit.",
    },
  },
} satisfies Record<
  string,
  Record<Locale, { eyebrow: string; title: string; description: string }>
>;
