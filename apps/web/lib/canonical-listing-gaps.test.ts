import { bulkFormGaps } from "@wukong/shopline";
import type { CanonicalListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { canonicalListingToGapsInput } from "./canonical-listing-gaps.js";

function contentFor(
  overrides: Partial<CanonicalListing> = {},
): CanonicalListing {
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
    ...overrides,
  };
}

describe("canonicalListingToGapsInput + bulkFormGaps", () => {
  it("reports no gaps for fully-translated, non-mirroring content", () => {
    const gaps = bulkFormGaps(canonicalListingToGapsInput(contentFor()));
    expect(gaps).toEqual({
      untranslatedName: false,
      untranslatedSeoTitle: false,
      seoTitleMirrorsName: false,
      seoDescriptionMirrorsSeoTitle: false,
      keywordsMirrorName: false,
      summaryMissing: false,
    });
  });

  it("flags untranslatedName when English and Traditional Chinese titles match", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({ title: { en: "Demo Wine", "zh-Hant": "Demo Wine" } }),
      ),
    );
    expect(gaps.untranslatedName).toBe(true);
  });

  it("flags untranslatedSeoTitle when English and Traditional Chinese SEO titles match", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({
          seo: {
            title: { en: "Demo Wine | Shop", "zh-Hant": "Demo Wine | Shop" },
            description: {
              en: "Buy Demo Wine today.",
              "zh-Hant": "立即購買示範美酒。",
            },
          },
        }),
      ),
    );
    expect(gaps.untranslatedSeoTitle).toBe(true);
  });

  it("flags seoDescriptionMirrorsSeoTitle when the SEO description equals the SEO title", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({
          seo: {
            title: { en: "Demo Wine | Shop", "zh-Hant": "示範美酒 | 商店" },
            description: {
              en: "Demo Wine | Shop",
              "zh-Hant": "立即購買示範美酒。",
            },
          },
        }),
      ),
    );
    expect(gaps.seoDescriptionMirrorsSeoTitle).toBe(true);
  });

  it("flags seoTitleMirrorsName when the SEO title equals the product name", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({
          seo: {
            title: { en: "Demo Wine", "zh-Hant": "示範美酒" },
            description: {
              en: "Buy Demo Wine today.",
              "zh-Hant": "立即購買示範美酒。",
            },
          },
        }),
      ),
    );
    expect(gaps.seoTitleMirrorsName).toBe(true);
  });

  it("joins tags with a comma for the keywords field", () => {
    const input = canonicalListingToGapsInput(
      contentFor({ tags: ["a", "b", "c"] }),
    );
    expect(input.seoKeywords).toBe("a, b, c");
  });

  it("flags keywordsMirrorName when the joined tags equal the English name", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({
          title: { en: "wine, demo", "zh-Hant": "示範美酒" },
          tags: ["wine", "demo"],
        }),
      ),
    );
    expect(gaps.keywordsMirrorName).toBe(true);
  });
});
