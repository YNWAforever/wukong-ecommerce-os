/**
 * Grounding behaviour against REAL label transcriptions.
 *
 * The pre-existing provider tests all ground their facts against a note written
 * as `product type wine; country Germany; volume 750 ml` -- a string engineered
 * so every value appears verbatim inside its own evidence excerpt. Under that
 * fixture `assertFactsGrounded` could only pass, so it never exercised what the
 * validator does to a photographed bottle label, which is the only input the
 * production journey actually has.
 *
 * These cases use excerpts of the shape a vision model genuinely returns when
 * it transcribes a label. Each accepted case was rejected before
 * `fact-grounding-rules.ts` existed, and each rejected case must stay rejected:
 * widening what grounds is only safe if a WRONG value still fails.
 */
import { describe, expect, it } from "vitest";

import { assertFactsGrounded, FACT_KEYS } from "./listing-output-validation.js";
import { ProviderOutputError } from "./listing-provider-errors.js";

import type { FieldEvidence, ListingFacts } from "@wukong/core";

const ASSET = "3f1c9d2e-6a44-4f0b-9e1a-8c5d2b7a4e11";

function evidenceFor(
  field: keyof ListingFacts,
  excerpt: string,
  sourceAssetId = ASSET,
): FieldEvidence {
  return { field, sourceAssetId, page: null, excerpt, confidence: 0.9 };
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

describe("facts a real label states in another form", () => {
  it("accepts an enum classification cited against the text it read", () => {
    // A Bordeaux label states its appellation, never the English word "wine".
    // productType is a CLASSIFICATION over a four-value enum, so it is grounded
    // by pointing at the text that was classified, not by quoting the value.
    const facts = factsWith({ productType: "wine" });

    expect(() =>
      assertFactsGrounded(facts, [
        evidenceFor("productType", "GRAND VIN DE BORDEAUX"),
      ]),
    ).not.toThrow();
  });

  it("accepts a centilitre volume normalized to millilitres", () => {
    const facts = factsWith({ volumeMl: 750 });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("volumeMl", "75 cl")]),
    ).not.toThrow();
  });

  it("accepts a litre volume written with a decimal comma", () => {
    const facts = factsWith({ volumeMl: 1500 });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("volumeMl", "1,5 L")]),
    ).not.toThrow();
  });

  it("accepts a country name printed in its own language", () => {
    const facts = factsWith({ country: "France" });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("country", "法國波爾多")]),
    ).not.toThrow();
  });

  it("accepts an ABV written with a decimal comma", () => {
    const facts = factsWith({ abvPercent: 13.5 });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("abvPercent", "13,5 % vol.")]),
    ).not.toThrow();
  });

  it("still accepts the synthetic note shape the existing fixtures use", () => {
    // Normalization widens what grounds; it must never narrow it.
    const facts = factsWith({
      productType: "wine",
      country: "Germany",
      volumeMl: 750,
      abvPercent: 12.5,
    });

    expect(() =>
      assertFactsGrounded(facts, [
        evidenceFor("productType", "product type wine"),
        evidenceFor("country", "country Germany"),
        evidenceFor("volumeMl", "volume 750 ml"),
        evidenceFor("abvPercent", "ABV 12.5%"),
      ]),
    ).not.toThrow();
  });
});

describe("a wrong value is still rejected", () => {
  it("rejects a volume that no reading of the excerpt produces", () => {
    // 75 cl is 750 ml, not 700. Accepting the conversion must not accept every
    // number near it.
    const facts = factsWith({ volumeMl: 700 });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("volumeMl", "75 cl")]),
    ).toThrow("AI evidence did not support its fact value");
  });

  it("rejects a country the alias table maps somewhere else", () => {
    const facts = factsWith({ country: "Italy" });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("country", "法國波爾多")]),
    ).toThrow("AI evidence did not support its fact value");
  });

  it("rejects a country alias it has never seen, rather than guessing", () => {
    // An unlisted language falls back to verbatim matching, so an unknown form
    // fails closed instead of being invented.
    const facts = factsWith({ country: "Poland" });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("country", "Polska")]),
    ).toThrow("AI evidence did not support its fact value");
  });

  it("rejects a substring collision on a verbatim fact", () => {
    // region is quoted off the label, so "Moselle" does not support "Mosel".
    const facts = factsWith({ region: "Mosel" });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("region", "Moselle")]),
    ).toThrow("AI evidence did not support its fact value");
  });

  it("rejects a classified fact that cites nothing at all", () => {
    // Classification still has to point at the source it judged. Evidence is
    // not optional -- only restating the value is.
    const facts = factsWith({ productType: "wine" });

    expect(() => assertFactsGrounded(facts, [])).toThrow(
      "AI fact had no supporting evidence",
    );
  });

  it("rejects a country inferred with no evidence at all", () => {
    const facts = factsWith({ country: "France", region: "Margaux" });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("region", "MARGAUX")]),
    ).toThrow("AI fact had no supporting evidence");
  });
});

describe("merchant data is never read off a photograph", () => {
  it("rejects a price grounded in an image asset", () => {
    // A price on a bottle is not the merchant's selling price. Even a perfectly
    // quoted number is a guess about someone else's business.
    const facts = factsWith({ priceHkd: 288 });

    expect(() =>
      assertFactsGrounded(facts, [evidenceFor("priceHkd", "HK$288")]),
    ).toThrow("AI read merchant data from a source that cannot state it");
  });

  it("rejects a SKU and a stock level grounded in an image asset", () => {
    expect(() =>
      assertFactsGrounded(factsWith({ sku: "OPAK-1" }), [
        evidenceFor("sku", "OPAK-1"),
      ]),
    ).toThrow(ProviderOutputError);

    expect(() =>
      assertFactsGrounded(factsWith({ stockQuantity: 6 }), [
        evidenceFor("stockQuantity", "6 bottles"),
      ]),
    ).toThrow(ProviderOutputError);
  });

  it("accepts merchant data the operator supplied in the note", () => {
    const facts = factsWith({ sku: "OPAK-1", priceHkd: 288, stockQuantity: 6 });

    expect(() =>
      assertFactsGrounded(facts, [
        evidenceFor("sku", "SKU: OPAK-1", "note"),
        evidenceFor("priceHkd", "HK$288", "note"),
        evidenceFor("stockQuantity", "Stock quantity: 6", "note"),
      ]),
    ).not.toThrow();
  });
});

describe("missingFields contract", () => {
  it("counts every fact key, so an optional fact is treated as missing", () => {
    // Both providers compute missingFields as
    // FACT_KEYS.filter(key => facts[key] === null) -- all 14 keys. That folds
    // genuinely optional facts (region, vintage, stockQuantity) into the same
    // bucket as the merchant fields the journey really needs, and any one of
    // them being null routes the run to needs_info with no draft saved.
    // Unchanged by the grounding fix; owned by the partial-draft work.
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
