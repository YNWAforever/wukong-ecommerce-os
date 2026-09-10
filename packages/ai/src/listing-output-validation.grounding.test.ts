/**
 * Grounding behaviour against REAL label transcriptions.
 *
 * The pre-existing provider tests all ground their facts against a note written
 * as `product type wine; country Germany; volume 750 ml` -- a string engineered
 * so every value appears verbatim inside its own evidence excerpt. Under that
 * fixture `assertFactsGrounded` can only pass, so it never exercised what the
 * validator does to a photographed bottle label, which is the only input the
 * production journey actually has.
 *
 * These cases use excerpts of the shape a vision model genuinely returns when
 * it transcribes a label. Each one is a legitimate, correctly-extracted fact.
 *
 * The assertions below pin CURRENT behaviour, which rejects them. They are the
 * Phase 0 reproduction of audit findings F04 (normalization) and F02 (a null /
 * ungroundable fact stops the run), and they are inverted by the Phase 1 fix.
 */
import { describe, expect, it } from "vitest";

import { assertFactsGrounded, FACT_KEYS } from "./listing-output-validation.js";
import { ProviderOutputError } from "./listing-provider-errors.js";

import type { FieldEvidence, ListingFacts } from "@wukong/core";

const ASSET = "3f1c9d2e-6a44-4f0b-9e1a-8c5d2b7a4e11";

function evidenceFor(
  field: keyof ListingFacts,
  excerpt: string,
): FieldEvidence {
  return { field, sourceAssetId: ASSET, page: null, excerpt, confidence: 0.9 };
}

/** A fully-null fact set, so each case opts in to exactly the fact it exercises. */
function factsWith(overrides: Partial<ListingFacts>): ListingFacts {
  return {
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
    ...overrides,
  };
}

describe("assertFactsGrounded against real label transcriptions", () => {
  it("rejects an enum classification the label never spells out", () => {
    // A Bordeaux label states its appellation, never the English word "wine".
    // productType is a CLASSIFICATION over the schema's four-value enum, so no
    // correct extraction of any real wine label can quote "wine" from it.
    const facts = factsWith({ productType: "wine" });
    const evidence = [evidenceFor("productType", "GRAND VIN DE BORDEAUX")];

    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      ProviderOutputError,
    );
    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      "AI evidence did not support its fact value",
    );
  });

  it("rejects a classification the model declines to fabricate evidence for", () => {
    // EXTRACTION_INSTRUCTIONS tells the model "Do not emit evidence for an
    // unsupported fact". A model that obeys -- classifying productType but
    // quoting nothing, because the label has nothing to quote -- hits the
    // opposite branch and is rejected just the same. Both ways of handling an
    // honestly-classified fact are errors, so there is no output that passes.
    const facts = factsWith({ productType: "wine" });

    expect(() => assertFactsGrounded(facts, [])).toThrow(
      "AI fact had no supporting evidence",
    );
  });

  it("rejects a centilitre volume normalized to millilitres", () => {
    // EU bottles are labelled in centilitres. volumeMl is millilitres by
    // contract, so 75 cl MUST be stored as 750 -- and 750 is not a number that
    // appears in the excerpt.
    const facts = factsWith({ volumeMl: 750 });
    const evidence = [evidenceFor("volumeMl", "75 cl")];

    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      "AI evidence did not support its fact value",
    );
  });

  it("rejects a litre volume normalized to millilitres", () => {
    const facts = factsWith({ volumeMl: 1500 });
    const evidence = [evidenceFor("volumeMl", "1,5 L")];

    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      "AI evidence did not support its fact value",
    );
  });

  it("rejects a country name normalized out of its own language", () => {
    // A label printed for the Hong Kong market states the origin in Chinese.
    // The canonical country value is English, so the correct extraction can
    // never quote itself.
    const facts = factsWith({ country: "France" });
    const evidence = [evidenceFor("country", "法國波爾多")];

    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      "AI evidence did not support its fact value",
    );
  });

  it("rejects an ABV written with a decimal comma", () => {
    // "13,5 % vol." tokenizes to the numbers 13 and 5; neither equals 13.5.
    const facts = factsWith({ abvPercent: 13.5 });
    const evidence = [evidenceFor("abvPercent", "13,5 % vol.")];

    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      "AI evidence did not support its fact value",
    );
  });

  it("rejects a country correctly inferred from an appellation", () => {
    // The label prints only the appellation. Inferring France is right, and
    // there is no honest excerpt for it, so the fact is rejected outright.
    const facts = factsWith({ country: "France", region: "Margaux" });
    const evidence = [evidenceFor("region", "MARGAUX")];

    expect(() => assertFactsGrounded(facts, evidence)).toThrow(
      "AI fact had no supporting evidence",
    );
  });

  it("accepts the synthetic note shape the existing fixtures use", () => {
    // The control. The validator is not universally rejecting: it passes as
    // soon as the excerpt restates the value, which is what every pre-existing
    // fixture does and what no photographed label does.
    const facts = factsWith({
      productType: "wine",
      country: "Germany",
      volumeMl: 750,
      abvPercent: 12.5,
    });
    const evidence = [
      evidenceFor("productType", "product type wine"),
      evidenceFor("country", "country Germany"),
      evidenceFor("volumeMl", "volume 750 ml"),
      evidenceFor("abvPercent", "ABV 12.5%"),
    ];

    expect(() => assertFactsGrounded(facts, evidence)).not.toThrow();
  });
});

describe("missingFields contract divergence between providers", () => {
  it("counts every fact key, so an optional fact is treated as missing", () => {
    // OpenAIListingProvider computes missingFields as
    // FACT_KEYS.filter(key => facts[key] === null) -- all 14 keys. That folds
    // genuinely optional facts (region, vintage, stockQuantity) into the same
    // bucket as the merchant fields the journey really needs, and any one of
    // them being null routes the run to needs_info with no draft saved.
    expect(FACT_KEYS).toContain("region");
    expect(FACT_KEYS).toContain("vintage");
    expect(FACT_KEYS).toContain("stockQuantity");
    expect(FACT_KEYS).toHaveLength(14);

    const facts = factsWith({
      sku: "OPAK-1",
      producer: "Demo Estate",
      productType: "wine",
      country: "Germany",
      volumeMl: 750,
      abvPercent: 12.5,
      priceHkd: 288,
    });

    // Everything a listing needs to be generated is present, yet a non-vintage
    // spirit with no stated region is still reported as missing three fields.
    const missing = FACT_KEYS.filter((key) => facts[key] === null);
    expect(missing).toEqual(["region", "vintage", "stockQuantity"]);
  });
});
