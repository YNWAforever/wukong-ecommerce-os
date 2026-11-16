import type { Locale } from "../locale";

/**
 * Canonical Studio vocabulary, shared by every surface.
 *
 * The usability audit (docs/superpowers/specs/2026-11-16-studio-usability-audit.md)
 * found the same concept under three or four labels: "Merchant audit" vs
 * "Workspace audit", "Gap report" vs "Selected-listing gaps", "artifact" vs
 * "output", and two translation modules disagreeing. These terms are the single
 * source of truth for user-facing labels; surfaces read them instead of
 * re-translating, and `studio-terms.test.ts` pins the exact wording.
 *
 * Rule: these are *user* words. Implementation identifiers (`threadId`,
 * `runId`, `revision`, `digest`, `skillKey`, provider names) never become copy.
 */
export const STUDIO_TERMS = {
  listingReview: ["商品審查", "Listing review"],
  workspaceAudit: ["工作區稽核", "Workspace audit"],
  gapReview: ["缺口檢視", "Gap review"],
  copyProposal: ["文案建議", "Copy proposal"],
  reviewSignOff: ["覆核", "Review sign-off"],
  savedWork: ["已儲存成果", "Saved work"],
  batchReview: ["批次審查", "Batch review"],
  conversation: ["對話", "Conversation"],
  needsAttention: ["待辦", "Needs attention"],
  catalogSearch: ["商品搜尋", "Catalog search"],
  listingDraft: ["商品草稿", "Listing draft"],
  imagePreparation: ["圖片準備", "Image preparation"],
  categoryMapping: ["分類對應", "Category mapping"],
  supplierIntel: ["供應商情報", "Supplier intel"],
  guidedReview: ["引導審查", "Guided review"],
  tool: ["工具", "Tool"],
} as const satisfies Record<string, readonly [string, string]>;

export type StudioTermKey = keyof typeof STUDIO_TERMS;

/** Read one canonical term for the active locale. */
export function studioTerm(locale: Locale, key: StudioTermKey): string {
  return STUDIO_TERMS[key][locale === "zh-Hant" ? 0 : 1];
}

/** The same term as the `{ en, "zh-Hant" }` shape `guided-copy` uses. */
export function studioTermMessage(key: StudioTermKey): {
  en: string;
  "zh-Hant": string;
} {
  const [zh, en] = STUDIO_TERMS[key];
  return { en, "zh-Hant": zh };
}

/**
 * Human names for skill identifiers. A thread stores a `skillKey`; the UI shows
 * the matching term and never the raw identifier. Unknown skills fall back to a
 * neutral "Tool" term rather than leaking `some.skill_key` to the operator.
 */
export const STUDIO_SKILL_TERMS: Record<string, StudioTermKey> = {
  "catalog.find": "catalogSearch",
  "catalog.gap_review": "gapReview",
  "listing.copy_proposal": "copyProposal",
  "listing.draft_from_sources": "listingDraft",
  "merchant.audit": "workspaceAudit",
  "product_shot.prepare": "imagePreparation",
  "category.map_proposal": "categoryMapping",
  "supplier.intel_proposal": "supplierIntel",
  "customer.reply_draft": "copyProposal",
  "logistics.followup": "tool",
};

export function studioSkillTerm(
  locale: Locale,
  skillKey: string | null,
): string | null {
  if (skillKey === null) return null;
  return studioTerm(locale, STUDIO_SKILL_TERMS[skillKey] ?? "tool");
}
