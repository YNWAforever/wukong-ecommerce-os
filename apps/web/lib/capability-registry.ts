/**
 * The single source of truth for capability maturity, consumed by both the
 * /admin "System Truth" tab and /system-map -- see the design doc at
 * docs/superpowers/specs/2026-09-01-capability-registry-system-map-admin-tab-design.md
 * for why this is a static, hand-maintained list rather than a live
 * environment-variable check: the most safety-critical entry here
 * (shopline-real-publish) is gated by SHOPLINE_PUBLISH_ENABLED, which is
 * only ever read in apps/worker, never apps/web -- there is no live signal
 * this module could read without introducing a second, driftable copy of
 * that flag into the Vercel deployment. Update an entry's `state` in the
 * SAME pull request that changes the underlying capability's real state.
 */

export type CapabilityState = "implemented" | "pilot" | "planned" | "blocked";

export type CapabilityEntry = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly labelZh: string;
  readonly descriptionZh: string;
  readonly state: CapabilityState;
};

const CAPABILITY_ENTRIES: readonly CapabilityEntry[] = [
  {
    id: "shopline-real-publish",
    label: "Real SHOPLINE publishing",
    labelZh: "SHOPLINE 正式發佈",
    description:
      "Real writes require separate authorization and operational verification. This registry does not inspect deployment configuration.",
    descriptionZh: "正式寫入需要獨立授權及操作驗證；本登記冊不讀取部署設定。",
    state: "blocked",
  },
  {
    id: "ai-listing-generation",
    label: "AI-assisted listing generation",
    labelZh: "AI 商品資訊生成",
    description:
      "AI listing generation and provider integration are implemented. Operational status requires separate verification.",
    descriptionZh:
      "已實作 AI 商品內容生成介面及供應商整合；操作狀態須另行驗證。",
    state: "implemented",
  },
  {
    id: "bulk-form-import-freshness-gate",
    label: "Bulk-form import + freshness gate",
    labelZh: "批次匯入與時效檢查",
    description:
      "Merchant-attested import time and source/version/digest checks are implemented. Merchant-side freshness is not independently verified.",
    descriptionZh:
      "已實作商戶確認的匯入時間及來源、版本、摘要檢查；不核實商戶端時效。",
    state: "implemented",
  },
  {
    id: "attended-enrichment-batches",
    label: "Attended AI-enrichment batches",
    labelZh: "AI 批次強化",
    description:
      "Batch creation, wave advancement and review views are implemented for pilot evaluation.",
    descriptionZh: "已實作批次建立、波次推進及審核介面，供試行評估。",
    state: "pilot",
  },
  {
    id: "multi-product-export",
    label: "Multi-product export",
    labelZh: "多商品匯出",
    description:
      "Export approved, source-checked listings as a workbook. Generation does not verify SHOPLINE acceptance.",
    descriptionZh:
      "將已批准且來源檢查通過的商品匯出為工作簿；匯出不等於 SHOPLINE 接受。",
    state: "pilot",
  },
  {
    id: "jobs-ledger",
    label: "Jobs ledger",
    labelZh: "作業總覽",
    description:
      "Read the complete workspace job history with pagination. Metrics have a separately stated time window.",
    descriptionZh: "以分頁檢視工作區完整作業歷史；指標另有明確時間範圍。",
    state: "pilot",
  },
];

// A runtime backstop alongside the type-level `readonly` above --
// `readonly CapabilityEntry[]` and per-field `readonly` are compile-time
// only, so without this a consumer could still write
// `CAPABILITY_REGISTRY[0].state = "implemented"` (or `.push(...)`) and silently
// mutate the shared singleton every future consumer imports. Object.freeze
// is shallow, so each entry is frozen individually before the array itself
// is frozen -- freezing only the array would leave the nested entry
// objects mutable.
export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = Object.freeze(
  CAPABILITY_ENTRIES.map((entry) => Object.freeze({ ...entry })),
);
