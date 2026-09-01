import type { CanonicalListing } from "@wukong/core";
import type { BulkFormGapsInput } from "@wukong/shopline";

/**
 * `bulkFormGaps` (packages/shopline/src/bulk-form.ts) is normally fed the
 * frozen `platform_products.rawRow` import-time snapshot; this maps a
 * listing's current content onto the same input shape so the same 6 checks
 * run against live content instead, for every listing regardless of origin.
 *
 * `localizedTextSchema` enforces non-empty strings, so `summaryMissing`
 * (which only fires when both locales are `null`) is unreachable via this
 * adapter -- there is no empty-string case to special-case here.
 */
export function canonicalListingToGapsInput(
  content: CanonicalListing,
): BulkFormGapsInput {
  return {
    nameEn: content.title.en,
    nameZh: content.title["zh-Hant"],
    seoTitleEn: content.seo.title.en,
    seoTitleZh: content.seo.title["zh-Hant"],
    seoDescriptionEn: content.seo.description.en,
    summaryEn: content.description.en,
    summaryZh: content.description["zh-Hant"],
    seoKeywords: content.tags.join(", "),
  };
}
