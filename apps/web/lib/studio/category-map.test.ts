import { describe, expect, it } from "vitest";

import { FakeStudioModel } from "@wukong/ai";

import {
  categoryMapProposalPayloadSchema,
  deterministicCategoryLimitations,
  sanitizeCategorySuggestions,
} from "./category-map.js";

/**
 * Category-map proposal contract tests (C1): payload shape, grounding/dedupe
 * drops, confidence bounds, the explicit current-category-unknown rule, and the
 * scripted model's own identity/evidence validation. No provider call.
 */

const listingId = "11111111-1111-4111-8111-111111111111";
const payload = {
  schemaVersion: "wukong-category-map/v1" as const,
  listingId,
  listingTitle: "Synthetic wine",
  currentCategory: null,
  suggestions: [
    {
      path: "Beverages > Wine > Red",
      confidence: 0.8,
      rationale: "Similar catalog rows are red wines.",
      evidenceRefs: ["catalog:22222222-2222-4222-8222-222222222222"],
    },
  ],
  limitations: [
    { key: "studio.limit.category_not_applied", values: {} },
    { key: "studio.limit.category_current_unknown", values: {} },
  ],
  asOf: "2026-11-08T10:00:00.000Z",
};

describe("categoryMapProposalPayloadSchema", () => {
  it("accepts the stored payload and rejects invalid/extra fields", () => {
    expect(categoryMapProposalPayloadSchema.safeParse(payload).success).toBe(
      true,
    );
    for (const invalid of [
      { ...payload, schemaVersion: "other" },
      { ...payload, listingId: "" },
      { ...payload, currentCategory: 5 },
      {
        ...payload,
        suggestions: [{ ...payload.suggestions[0], confidence: 1.5 }],
      },
      {
        ...payload,
        suggestions: [{ ...payload.suggestions[0], evidenceRefs: [] }],
      },
      { ...payload, extra: true },
    ]) {
      expect(categoryMapProposalPayloadSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });
});

describe("sanitizeCategorySuggestions", () => {
  const allowed = [
    "listing:11111111-1111-4111-8111-111111111111:v2",
    "catalog:22222222-2222-4222-8222-222222222222",
  ];
  const base = {
    path: "Beverages > Wine > Red",
    confidence: 0.7,
    rationale: null,
    evidenceRefs: [allowed[1]!],
  };

  it("keeps grounded suggestions and counts each dropped reason", () => {
    const result = sanitizeCategorySuggestions({
      allowedEvidenceRefs: allowed,
      currentCategory: "Beverages > Wine > White",
      proposed: [
        base,
        // duplicate path, different case
        { ...base, path: "beverages > wine > red" },
        // ungrounded ref
        { ...base, path: "Other", evidenceRefs: ["catalog:not-in-pack"] },
        // no refs
        { ...base, path: "No evidence", evidenceRefs: [] },
        // confidence out of range
        { ...base, path: "Too sure", confidence: 1.2 },
        // equals the current category
        { ...base, path: "Beverages > Wine > White", confidence: 0.9 },
      ],
    });
    expect(result.suggestions).toEqual([
      {
        path: "Beverages > Wine > Red",
        confidence: 0.7,
        rationale: null,
        evidenceRefs: [allowed[1]!],
      },
    ]);
    expect(result.droppedCount).toBe(5);
  });

  it("does not treat unknown current category as a duplicate", () => {
    const result = sanitizeCategorySuggestions({
      allowedEvidenceRefs: allowed,
      currentCategory: null,
      proposed: [base],
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });
});

describe("deterministicCategoryLimitations", () => {
  it("always says nothing is applied and names each missing source honestly", () => {
    const lines = deterministicCategoryLimitations({
      catalogUnavailable: true,
      listingUnavailable: true,
      currentCategory: null,
    });
    const keys = lines.map((line) => line.key);
    expect(keys).toContain("studio.limit.category_not_applied");
    expect(keys).toContain("studio.limit.category_current_unknown");
    expect(keys).toContain("studio.limit.category_listing_unavailable");
    expect(keys).toContain("studio.limit.category_catalog_unavailable");
    expect(keys).toContain("studio.limit.category_model_unavailable");

    const complete = deterministicCategoryLimitations({
      catalogUnavailable: false,
      listingUnavailable: false,
      currentCategory: "Known > Path",
    });
    expect(complete.map((line) => line.key)).not.toContain(
      "studio.limit.category_current_unknown",
    );
    expect(complete.map((line) => line.key)).not.toContain(
      "studio.limit.category_catalog_unavailable",
    );
  });
});

describe("FakeStudioModel category proposals", () => {
  const modelInput = {
    locale: "en" as const,
    question: "map this listing",
    skill: {
      key: "category.map_proposal",
      version: "1.1.0",
      title: { "zh-Hant": "建議分類對應", en: "Propose category mapping" },
      outcome: {
        "zh-Hant": "建議分類對應。",
        en: "Suggest category mappings.",
      },
      limitation: {
        "zh-Hant": "只提出建議。",
        en: "Suggestions only.",
      },
      inputNames: ["listingId"],
      allowedTools: ["catalog.search", "catalog.get"],
      requiredSources: ["catalog", "listing"],
    },
    listing: {
      listingId,
      title: "Synthetic wine",
      currentCategory: null,
    },
    catalogEvidence: [
      {
        ref: "catalog:22222222-2222-4222-8222-222222222222",
        title: "Similar wine",
        status: "in_review",
      },
    ],
    allowedEvidenceRefs: [
      "listing:11111111-1111-4111-8111-111111111111:v2",
      "catalog:22222222-2222-4222-8222-222222222222",
    ],
  };

  it("returns a scripted, validated category proposal without a provider call", async () => {
    const model = new FakeStudioModel({
      categoryProposals: [
        {
          listingId,
          suggestions: [
            {
              path: "Beverages > Wine > Red",
              confidence: 0.6,
              rationale: "Similar row",
              evidenceRefs: ["catalog:22222222-2222-4222-8222-222222222222"],
            },
          ],
          limitations: [],
        },
      ],
    });
    const result = await model.proposeCategory!(modelInput);
    expect(result.proposal.suggestions[0]?.path).toBe("Beverages > Wine > Red");
    expect(result.usage.model).toBe("fake-studio-model");
  });

  it("rejects a retargeted listing or evidence outside the pack", async () => {
    const wrongListing = new FakeStudioModel({
      categoryProposals: [
        { listingId: "other", suggestions: [], limitations: [] },
      ],
    });
    await expect(wrongListing.proposeCategory!(modelInput)).rejects.toThrow(
      /wrong_listing/,
    );

    const ungrounded = new FakeStudioModel({
      categoryProposals: [
        {
          listingId,
          suggestions: [
            {
              path: "Invented",
              confidence: 0.9,
              rationale: null,
              evidenceRefs: ["catalog:not-in-pack"],
            },
          ],
          limitations: [],
        },
      ],
    });
    await expect(ungrounded.proposeCategory!(modelInput)).rejects.toThrow(
      /unknown_evidence/,
    );
  });
});
