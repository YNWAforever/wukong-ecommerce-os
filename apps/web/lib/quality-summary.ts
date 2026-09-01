import { bulkFormGaps, type BulkFormContentGaps } from "@wukong/shopline";
import type { CanonicalListing } from "@wukong/core";

import { canonicalListingToGapsInput } from "./canonical-listing-gaps.js";

export type QualityAssessedListing = {
  id: string;
  activeVersion: { id: string; content: CanonicalListing } | null;
};

export type QualitySummary = {
  totalAssessed: number;
  cleanCount: number;
  hasGapsCount: number;
  gapCounts: Record<keyof BulkFormContentGaps, number>;
  totalCostUsd: number;
};

const EMPTY_GAP_COUNTS: Record<keyof BulkFormContentGaps, number> = {
  untranslatedName: 0,
  untranslatedSeoTitle: 0,
  seoTitleMirrorsName: 0,
  seoDescriptionMirrorsSeoTitle: 0,
  keywordsMirrorName: 0,
  summaryMissing: 0,
};

export function computeQualitySummary(
  listings: readonly QualityAssessedListing[],
  totalCostUsd: number,
): QualitySummary {
  const gapCounts = { ...EMPTY_GAP_COUNTS };
  let cleanCount = 0;
  let hasGapsCount = 0;
  let totalAssessed = 0;

  for (const listing of listings) {
    if (!listing.activeVersion) continue;
    totalAssessed += 1;
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(listing.activeVersion.content),
    );
    const gapKeys = Object.keys(gaps) as (keyof BulkFormContentGaps)[];
    const hasAnyGap = gapKeys.some((key) => gaps[key]);
    if (hasAnyGap) {
      hasGapsCount += 1;
    } else {
      cleanCount += 1;
    }
    for (const key of gapKeys) {
      if (gaps[key]) gapCounts[key] += 1;
    }
  }

  return { totalAssessed, cleanCount, hasGapsCount, gapCounts, totalCostUsd };
}
