/**
 * What it takes to write a listing, as opposed to what is merely absent.
 *
 * Both providers report `missingFields` as every null fact, and the pipeline
 * used to treat a non-empty list as "cannot generate". That conflated three
 * different things: facts the label simply does not state (region on a spirit,
 * vintage on an NV), merchant data the model is forbidden to read off a
 * photograph at all (SKU, price, stock), and the product identity without which
 * there is genuinely nothing to write. Only the last one blocks.
 *
 * `missingFields` is deliberately unchanged -- the review screen shows it, and
 * an operator does want to know a region is missing. It just no longer decides
 * whether a draft exists.
 */
import { describe, expect, it } from "vitest";

import {
  factsSufficientForGeneration,
  GENERATION_REQUIRED_FACTS,
} from "./fact-grounding-rules.js";
import { buildSafeListing } from "./listing-output-validation.js";
import { ProviderOutputError } from "./listing-provider-errors.js";

import type { ListingFacts } from "@wukong/core";

function factsWith(overrides: Partial<ListingFacts> = {}): ListingFacts {
  return {
    sku: null,
    producer: "Demo Estate",
    productType: "wine",
    country: "Germany",
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
    ...overrides,
  };
}

const profile = {
  name: "Opak Cellar",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"] as const,
  tone: "clear and restrained",
  claimPolicy: ["No invented claims"],
  requiredFields: ["sku", "priceHkd"],
  brandBackgroundColor: null,
};

const input = (facts: ListingFacts) => ({
  facts,
  evidence: [],
  profile,
  imageAssetIds: ["asset_1"],
});

describe("factsSufficientForGeneration", () => {
  it("does not require merchant data the model may never read", () => {
    // The exact shape of the audited production upload: a label with no SKU,
    // no price and no stock quantity.
    expect(factsSufficientForGeneration(factsWith())).toBe(true);
    expect(GENERATION_REQUIRED_FACTS).not.toContain("sku");
    expect(GENERATION_REQUIRED_FACTS).not.toContain("priceHkd");
    expect(GENERATION_REQUIRED_FACTS).not.toContain("stockQuantity");
  });

  it("does not require facts a label may legitimately omit", () => {
    // A non-vintage spirit with no stated region. Previously three missing
    // fields, therefore needs_info, therefore no draft at all.
    expect(
      factsSufficientForGeneration(
        factsWith({ productType: "spirits", region: null, vintage: null }),
      ),
    ).toBe(true);
  });

  it("requires an identifiable product", () => {
    expect(factsSufficientForGeneration(factsWith({ producer: null }))).toBe(
      false,
    );
    expect(factsSufficientForGeneration(factsWith({ producer: "   " }))).toBe(
      false,
    );
  });
});

describe("buildSafeListing on a partly-known product", () => {
  it("writes bilingual copy from a label alone", () => {
    const listing = buildSafeListing(input(factsWith()));

    expect(listing.title.en).toBe("Demo Estate");
    expect(listing.description.en).toContain("Demo Estate");
    expect(listing.description["zh-Hant"]).toContain("葡萄酒");
    // Absent stays absent rather than being invented to fill the schema.
    expect(listing.sku).toBeNull();
    expect(listing.priceHkd).toBeNull();
  });

  it("omits a clause rather than printing a null", () => {
    const listing = buildSafeListing(input(factsWith()));

    // The old builder interpolated unconditionally, so an unknown volume would
    // have read "Volume: null ml." to the merchant's customers.
    for (const copy of [
      listing.description.en,
      listing.description["zh-Hant"],
    ]) {
      expect(copy).not.toContain("null");
      expect(copy).not.toContain("undefined");
    }
    expect(listing.description.en).not.toContain("Volume");
    expect(listing.description["zh-Hant"]).not.toContain("容量");
  });

  it("includes each clause once its fact is known", () => {
    const listing = buildSafeListing(
      input(
        factsWith({
          region: "Mosel",
          vintage: 2024,
          volumeMl: 750,
          abvPercent: 12.5,
          grapeVarieties: ["Riesling"],
        }),
      ),
    );

    expect(listing.title.en).toBe("Demo Estate 2024");
    expect(listing.description.en).toContain("Origin: Mosel, Germany.");
    expect(listing.description.en).toContain("Volume: 750 ml.");
    expect(listing.description.en).toContain("ABV: 12.5%.");
    expect(listing.description["zh-Hant"]).toContain("容量：750毫升。");
    expect(listing.tags).toEqual(
      expect.arrayContaining(["wine", "Germany", "Mosel", "2024", "Riesling"]),
    );
  });

  it("refuses a product it cannot identify", () => {
    expect(() =>
      buildSafeListing(input(factsWith({ producer: null }))),
    ).toThrow(ProviderOutputError);
  });
});
