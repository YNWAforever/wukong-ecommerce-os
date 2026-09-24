import type { Locale } from "./locale";
import { localized } from "./ui-copy";
const rules: Record<
  string,
  { label: readonly [string, string]; description: readonly [string, string] }
> = {
  health_claim: {
    label: ["健康功效聲稱", "Health claim"],
    description: [
      "移除未有來源支持的健康功效描述，或記錄審核理由。",
      "Remove unsupported health claims or record the review rationale.",
    ],
  },
  guarantee: {
    label: ["保證式聲稱", "Guarantee claim"],
    description: [
      "移除無法證實的保證式描述，或記錄審核理由。",
      "Remove unsubstantiated guarantees or record the review rationale.",
    ],
  },
  rating_without_evidence: {
    label: ["評分欠缺來源", "Rating without evidence"],
    description: [
      "補充評分來源，或記錄移除／保留理由。",
      "Add rating evidence or record why it was removed or retained.",
    ],
  },
  superlative: {
    label: ["最高級聲稱", "Superlative claim"],
    description: [
      "核對最高級聲稱的來源，或記錄處理理由。",
      "Check the source for superlatives or record the resolution rationale.",
    ],
  },
};
export function complianceLabel(
  code: string,
  locale: Locale,
  kind: "label" | "description",
) {
  const entry = rules[code]?.[kind];
  return entry
    ? localized(locale, ...entry)
    : localized(locale, "請審核合規提示", "Review compliance evidence");
}

const fields: Record<string, readonly [string, string]> = {
  "title.zh-Hant": ["商品名稱（繁中）", "Title (Traditional Chinese)"],
  "title.en": ["商品名稱（英文）", "Title (English)"],
  "description.zh-Hant": [
    "商品描述（繁中）",
    "Description (Traditional Chinese)",
  ],
  "description.en": ["商品描述（英文）", "Description (English)"],
  "seo.title.en": ["SEO 標題（英文）", "SEO title (English)"],
  "seo.title.zh-Hant": ["SEO 標題（繁中）", "SEO title (Traditional Chinese)"],
  "seo.description.en": ["SEO 描述（英文）", "SEO description (English)"],
  "seo.description.zh-Hant": [
    "SEO 描述（繁中）",
    "SEO description (Traditional Chinese)",
  ],
  tags: ["標籤", "Tags"],
  sku: ["SKU", "SKU"],
  producer: ["生產者", "Producer"],
  productType: ["商品類型", "Product type"],
  country: ["國家", "Country"],
  region: ["地區", "Region"],
  vintage: ["年份", "Vintage"],
  grapeVarieties: ["葡萄品種", "Grape varieties"],
  volumeMl: ["容量（毫升）", "Volume (ml)"],
  abvPercent: ["酒精濃度（%）", "ABV (%)"],
  packQuantity: ["每套數量", "Pack quantity"],
  priceHkd: ["售價（HKD）", "Price (HKD)"],
  stockQuantity: ["庫存數量", "Stock quantity"],
};
export function evidenceFieldLabel(field: string, locale: Locale) {
  const label = fields[field];
  return label
    ? localized(locale, ...label)
    : localized(locale, "其他來源欄位", "Other source field");
}

export const wineSectionLabels = {
  selling_points: ["賣點", "Selling points"],
  introduction: ["介紹", "Introduction"],
  tasting: ["品飲筆記", "Tasting"],
  pairing: ["餐酒配搭", "Pairing"],
  serving: ["飲用建議", "Serving"],
  brand_background: ["品牌背景", "Brand background"],
} as const;
export const wineStageLabels = {
  extraction: ["識別標籤", "Identify label"],
  search_basic: ["搜尋資料", "Research sources"],
  verification: ["核實資料", "Verify evidence"],
  search_deep: ["深入搜尋", "Additional research"],
  verification_deep: ["核實補充資料", "Verify additional evidence"],
  generation: ["建立雙語文案", "Draft bilingual copy"],
  quality_check: ["品質檢查", "Quality check"],
  commit_candidate: ["儲存建議", "Save proposal"],
} as const;
export const wineStateLabels = {
  queued: ["已排隊", "Queued"],
  running: ["處理中", "Running"],
  needs_info: ["需要資料", "More information needed"],
  in_review: ["可供審核", "Ready for review"],
  awaiting_adoption: ["等待採納", "Awaiting adoption"],
  adopted: ["已採納", "Adopted"],
  failed: ["未完成", "Failed"],
  superseded: ["已有較新處理", "Superseded"],
  cancelled: ["已取消", "Cancelled"],
} as const;
