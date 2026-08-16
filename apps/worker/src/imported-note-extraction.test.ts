import { describe, expect, it } from "vitest";

import { FakeListingProvider } from "@wukong/ai";
import {
  renderBulkFormSource,
  type BulkFormColumnKey,
} from "@wukong/shopline";

/**
 * The renderer and the fake provider live in different packages and had no test
 * between them, so their note formats silently diverged: the renderer emits
 * labelled lines (`SKU: DEMO0001`) and the fake's regexes were written for a
 * comma-separated one-liner (`SKU DEMO0001, ...`). The result was that every
 * imported draft failed to enrich whenever `AI_PROVIDER=fake` — a mode
 * `docs/runbooks/production-ai-runtime.md` allows for preview.
 *
 * This is the only place the two meet, because the worker is what feeds a
 * draft's note to the provider. It runs the real renderer's output through the
 * real fake, so the formats cannot drift apart again unnoticed.
 */

/** Mirrors `importedDraftNote` in apps/web/lib/bulk-form-import.ts. */
const importedNote = (raw: Partial<Record<BulkFormColumnKey, string>>) =>
  [
    "Imported from a SHOPLINE bulk update form, row 7",
    "",
    renderBulkFormSource(raw),
  ].join("\n");

/**
 * A plausible Opak row: nothing here is shaped to suit the fake's regexes.
 * Volume and ABV ride in the promotion label because that is where the pilot
 * catalog actually carries them.
 */
const ROW: Partial<Record<BulkFormColumnKey, string>> = {
  nameEn: "Demo Estate Riesling 2024",
  sku: "DEMO0001",
  brand: "Demo Estate",
  regularPrice: "750.0",
  quantity: "6",
  onlineStoreCategories: "White Wine>Germany>Mosel",
  promotionLabelEn: "750ml 12.5% ABV",
};

describe("imported note extraction", () => {
  it("extracts every fact the form states from a rendered note", async () => {
    const result = await new FakeListingProvider().extract({
      assets: [],
      note: importedNote(ROW),
    });

    expect(result.facts).toMatchObject({
      sku: "DEMO0001",
      producer: "Demo Estate",
      productType: "wine",
      country: "Germany",
      region: "Mosel",
      vintage: 2024,
      volumeMl: 750,
      abvPercent: 12.5,
      priceHkd: 750,
      stockQuantity: 6,
    });
  });

  it("quotes evidence verbatim from the rendered note", async () => {
    const note = importedNote(ROW);
    const result = await new FakeListingProvider().extract({
      assets: [],
      note,
    });

    // Every excerpt must appear in the note as written. An excerpt the note
    // does not contain is a fabricated quote, which is what the evidence
    // contract exists to prevent.
    for (const item of result.evidence) {
      expect(note).toContain(item.excerpt);
    }
    expect(result.evidence.map((item) => item.field)).toEqual(
      expect.arrayContaining(["sku", "stockQuantity", "priceHkd"]),
    );
  });

  it("generates a listing from a rendered note without throwing", async () => {
    const provider = new FakeListingProvider();
    const extraction = await provider.extract({
      assets: [],
      note: importedNote(ROW),
    });

    const result = await provider.generate({
      facts: extraction.facts,
      evidence: extraction.evidence,
      profile: {
        name: "Opak Cellar",
        currency: "HKD",
        locales: ["en", "zh-Hant"],
        tone: "clear and restrained",
        claimPolicy: ["No invented claims"],
        requiredFields: [
          "sku",
          "producer",
          "country",
          "volumeMl",
          "abvPercent",
          "priceHkd",
        ],
      },
      imageAssetIds: [],
    });

    expect(result.listing.sku).toBe("DEMO0001");
    expect(result.listing.priceHkd).toBe(750);
  });
});
