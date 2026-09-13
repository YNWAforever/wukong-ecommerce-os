import type { ReviewableListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { CONFIRMATION_FIELD_KEYS } from "./review-confirmation-keys";
import { REVIEW_FIELD_BINDINGS } from "./review-field-bindings";

// Every localized string is distinct, so a binding that reads the wrong path
// returns a visibly wrong value rather than an accidentally equal one.
const content: ReviewableListing = {
  sku: null,
  producer: null,
  productType: null,
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "title-en", "zh-Hant": "title-zh" },
  description: { en: "description-en", "zh-Hant": "description-zh" },
  seo: {
    title: { en: "seo-title-en", "zh-Hant": "seo-title-zh" },
    description: { en: "seo-description-en", "zh-Hant": "seo-description-zh" },
  },
  tags: ["keyword-b", "keyword-a"],
  imageAssetIds: [],
};

describe("REVIEW_FIELD_BINDINGS", () => {
  it("binds exactly the confirmation field keys, in order", () => {
    expect(Object.keys(REVIEW_FIELD_BINDINGS)).toEqual(CONFIRMATION_FIELD_KEYS);
  });

  it.each([
    ["nameZh", "title-zh", "title.zh-Hant"],
    ["summaryEn", "description-en", "description.en"],
    ["summaryZh", "description-zh", "description.zh-Hant"],
    ["seoTitleEn", "seo-title-en", "seo.title.en"],
    ["seoTitleZh", "seo-title-zh", "seo.title.zh-Hant"],
    ["seoDescriptionEn", "seo-description-en", "seo.description.en"],
    ["seoDescriptionZh", "seo-description-zh", "seo.description.zh-Hant"],
  ] as const)("reads %s from its own path", (key, value, evidenceKey) => {
    expect(REVIEW_FIELD_BINDINGS[key].read(content)).toBe(value);
    expect(REVIEW_FIELD_BINDINGS[key].evidenceKey).toBe(evidenceKey);
  });

  it("reads seoKeywords as the stored array, not the joined display string", () => {
    expect(REVIEW_FIELD_BINDINGS.seoKeywords.read(content)).toEqual([
      "keyword-b",
      "keyword-a",
    ]);
    expect(REVIEW_FIELD_BINDINGS.seoKeywords.evidenceKey).toBe("tags");
  });
});
