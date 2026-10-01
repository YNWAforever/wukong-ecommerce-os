import type { ReviewQualityMetrics } from "./review-quality-metrics";
import type { BulkFormContentGaps } from "@wukong/shopline";
import type { ReviewableListing, WorkingListing } from "@wukong/core";

import {
  computeCurrentContentGaps,
  type ContentAssessmentState,
} from "./current-content-gaps";

export type QualityAssessedListing = {
  id: string;
  activeVersion: { id: string; content: ReviewableListing } | null;
  currentContent?: WorkingListing | ReviewableListing | null;
  assessmentState?: ContentAssessmentState;
};

export type QualitySummary = {
  reviewMetrics?: ReviewQualityMetrics;
  totalAssessed: number;
  cleanCount: number;
  hasGapsCount: number;
  gapCounts: Record<keyof BulkFormContentGaps, number>;
  totalCostUsd: number;
  unknownCostRunCount: number;
  totalListings?: number;
  noActiveVersion?: number;
  unassessableActiveVersion?: number;
  missingCurrentContent?: number;
  invalidCurrentContent?: number;
  scope?: "workspace_active_versions" | "workspace_current_content";
  costScope?: "all_history_for_workspace_listings";
  consistency?: "bounded_scan";
  scanStartedAt?: string;
  scanCompletedAt?: string;
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
  unknownCostRunCount = 0,
): QualitySummary {
  const gapCounts = { ...EMPTY_GAP_COUNTS };
  let cleanCount = 0;
  let hasGapsCount = 0;
  let totalAssessed = 0;

  for (const listing of listings) {
    const assessment = computeCurrentContentGaps({
      content:
        listing.currentContent !== undefined
          ? listing.currentContent
          : (listing.activeVersion?.content ?? null),
      assessmentState:
        listing.assessmentState ??
        (listing.activeVersion ? "assessed" : "missing"),
    });
    if (!assessment.gaps) continue;
    totalAssessed += 1;
    const gaps = assessment.gaps;
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

  return {
    totalAssessed,
    cleanCount,
    hasGapsCount,
    gapCounts,
    totalCostUsd,
    unknownCostRunCount,
  };
}
