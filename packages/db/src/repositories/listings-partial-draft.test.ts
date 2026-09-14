/**
 * Which schema each listing read path parses with.
 *
 * `loadListingWithFlags` deliberately returns the active version's content
 * unparsed so each caller validates it "against the schema appropriate to what
 * it's about to do with it". That leaves the choice per call site, and getting
 * it wrong is silent: `safeParse` failing sets `activeVersion` to null, and the
 * catalog then renders the row as an unnamed product with no SKU rather than
 * raising anything.
 *
 * Once a draft can be saved without a SKU or a price, the list paths have to be
 * permissive or every partial draft disappears from its own catalog row. These
 * cases pin the distinction that makes that safe: display is reviewable,
 * publishing is canonical.
 */
import { canonicalListingSchema, reviewableListingSchema } from "@wukong/core";
import { describe, expect, it } from "vitest";

const localized = {
  en: "Demo Estate Riesling",
  "zh-Hant": "Demo Estate 麗絲玲",
};

/** What an operator can honestly record from a label alone. */
const partialDraft = {
  sku: null,
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: localized,
  description: localized,
  seo: { title: localized, description: localized },
  tags: ["Riesling"],
  imageAssetIds: ["asset_1"],
};

describe("a draft with unknown merchant data", () => {
  it("parses as reviewable, so a list path can still show its name", () => {
    const parsed = reviewableListingSchema.safeParse(partialDraft);

    expect(parsed.success).toBe(true);
    // The catalog row falls back to the note and then to "unnamed product" when
    // activeVersion is null, so this is what keeps the title on screen.
    expect(parsed.success && parsed.data.title["zh-Hant"]).toBe(
      "Demo Estate 麗絲玲",
    );
    expect(parsed.success && parsed.data.priceHkd).toBeNull();
  });

  it("does not parse as canonical, so publishing still refuses it", () => {
    // requireForPublish parses with this schema and throws. Widening the list
    // paths must not widen the delivery gate.
    expect(canonicalListingSchema.safeParse(partialDraft).success).toBe(false);
  });

  it("parses as canonical once the merchant data arrives", () => {
    const complete = { ...partialDraft, sku: "OPAK-1", priceHkd: 288 };

    expect(canonicalListingSchema.safeParse(complete).success).toBe(true);
  });
});

describe("reviewable is permissive about facts, not about content", () => {
  it("still requires the bilingual copy a reviewer reads", () => {
    for (const missing of ["title", "description", "seo", "tags"] as const) {
      const withoutIt: Record<string, unknown> = { ...partialDraft };
      delete withoutIt[missing];

      expect(reviewableListingSchema.safeParse(withoutIt).success).toBe(false);
    }
  });

  it("still rejects a value that is wrong rather than absent", () => {
    // Absent and invalid must stay different, or "not known yet" becomes a way
    // to smuggle bad data past validation.
    expect(
      reviewableListingSchema.safeParse({ ...partialDraft, volumeMl: -750 })
        .success,
    ).toBe(false);
    expect(
      reviewableListingSchema.safeParse({ ...partialDraft, abvPercent: 150 })
        .success,
    ).toBe(false);
    expect(
      reviewableListingSchema.safeParse({ ...partialDraft, vintage: 1500 })
        .success,
    ).toBe(false);
  });
});
