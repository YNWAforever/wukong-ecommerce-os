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

export type CapabilityState = "live" | "pilot" | "planned" | "blocked";

export type CapabilityEntry = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly state: CapabilityState;
};

const CAPABILITY_ENTRIES: readonly CapabilityEntry[] = [
  {
    id: "shopline-real-publish",
    label: "SHOPLINE 正式發佈 / Real SHOPLINE publishing",
    description:
      "Production runs with real SHOPLINE writes disabled by configuration. Enabling them requires separate written authorization outside this plan.",
    state: "blocked",
  },
  {
    id: "ai-listing-generation",
    label: "AI 商品資訊生成 / AI-assisted listing generation",
    description:
      "Production runs the real AI listing provider for listing content generation.",
    state: "live",
  },
  {
    id: "bulk-form-import-freshness-gate",
    label: "批次匯入與新鮮度檢查 / Bulk-form import + freshness gate",
    description:
      "Merchant-attested bulk-form catalog import, with the freshness gate validating source/version/digest before publish or export.",
    state: "live",
  },
  {
    id: "attended-enrichment-batches",
    label: "AI 批次強化 / Attended AI-enrichment batches",
    description:
      "Batch creation and wave advancement are live in production. The list/detail read UI for reviewing an existing batch is built but not yet merged to main.",
    state: "pilot",
  },
  {
    id: "multi-product-export",
    label: "多商品匯出 / Multi-product export",
    description:
      "Export multiple approved, freshness-checked listings as one SHOPLINE-importable workbook. Built, not yet merged to main.",
    state: "pilot",
  },
  {
    id: "jobs-ledger",
    label: "作業總覽 / Jobs ledger",
    description:
      "A read-only view of recent enrichment batches, publish jobs, AI pipeline runs, and exports in one time-sorted list. Built, not yet merged to main.",
    state: "pilot",
  },
];

// A runtime backstop alongside the type-level `readonly` above --
// `readonly CapabilityEntry[]` and per-field `readonly` are compile-time
// only, so without this a consumer could still write
// `CAPABILITY_REGISTRY[0].state = "live"` (or `.push(...)`) and silently
// mutate the shared singleton every future consumer imports. Object.freeze
// is shallow, so each entry is frozen individually before the array itself
// is frozen -- freezing only the array would leave the nested entry
// objects mutable.
export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = Object.freeze(
  CAPABILITY_ENTRIES.map((entry) => Object.freeze({ ...entry })),
);
