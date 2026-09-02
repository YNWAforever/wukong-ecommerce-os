import type { CanonicalListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import {
  computeQualitySummary,
  type QualityAssessedListing,
} from "./quality-summary.js";

function cleanContent(): CanonicalListing {
  return {
    sku: "SKU-1",
    producer: "Demo Estate",
    productType: "wine",
    country: "France",
    region: null,
    vintage: null,
    grapeVarieties: [],
    volumeMl: 750,
    abvPercent: 12.5,
    packQuantity: 1,
    priceHkd: 100,
    stockQuantity: null,
    criticScores: [],
    awards: [],
    title: { en: "Demo Wine", "zh-Hant": "示範美酒" },
    description: { en: "A fine wine.", "zh-Hant": "一款好酒。" },
    seo: {
      title: { en: "Demo Wine | Shop", "zh-Hant": "示範美酒 | 商店" },
      description: {
        en: "Buy Demo Wine today.",
        "zh-Hant": "立即購買示範美酒。",
      },
    },
    tags: ["wine", "demo"],
    imageAssetIds: [],
  };
}

function listingWith(
  content: CanonicalListing | null,
  id = "l1",
): QualityAssessedListing {
  return {
    id,
    activeVersion: content ? { id: `${id}-v1`, content } : null,
  };
}

describe("computeQualitySummary", () => {
  it("counts a listing with no gaps as clean", () => {
    const summary = computeQualitySummary([listingWith(cleanContent())], 0);
    expect(summary.totalAssessed).toBe(1);
    expect(summary.cleanCount).toBe(1);
    expect(summary.hasGapsCount).toBe(0);
  });

  it("counts a listing with at least one gap as has-gaps, and tallies the specific signal", () => {
    const summary = computeQualitySummary(
      [
        listingWith({
          ...cleanContent(),
          title: { en: "Demo Wine", "zh-Hant": "Demo Wine" },
        }),
      ],
      0,
    );
    expect(summary.hasGapsCount).toBe(1);
    expect(summary.cleanCount).toBe(0);
    expect(summary.gapCounts.untranslatedName).toBe(1);
    expect(summary.gapCounts.seoTitleMirrorsName).toBe(0);
  });

  it("excludes a listing with no active version from the assessed total", () => {
    const summary = computeQualitySummary([listingWith(null)], 0);
    expect(summary.totalAssessed).toBe(0);
    expect(summary.cleanCount).toBe(0);
    expect(summary.hasGapsCount).toBe(0);
  });

  it("passes through the total cost unchanged", () => {
    const summary = computeQualitySummary([listingWith(cleanContent())], 12.5);
    expect(summary.totalCostUsd).toBe(12.5);
  });

  it("tallies gap counts across multiple listings independently", () => {
    const summary = computeQualitySummary(
      [
        listingWith(cleanContent(), "l1"),
        listingWith(
          {
            ...cleanContent(),
            title: { en: "Demo Wine", "zh-Hant": "Demo Wine" },
          },
          "l2",
        ),
        listingWith(
          {
            ...cleanContent(),
            seo: {
              title: { en: "Demo Wine", "zh-Hant": "示範美酒" },
              description: {
                en: "Buy Demo Wine today.",
                "zh-Hant": "立即購買示範美酒。",
              },
            },
          },
          "l3",
        ),
      ],
      0,
    );
    expect(summary.totalAssessed).toBe(3);
    expect(summary.cleanCount).toBe(1);
    expect(summary.hasGapsCount).toBe(2);
    expect(summary.gapCounts.untranslatedName).toBe(1);
    expect(summary.gapCounts.seoTitleMirrorsName).toBe(1);
  });
});
