import { describe, expect, it } from "vitest";

import {
  applyListingFields,
  mapListingView,
  resolveListingViewState,
  type ListingViewResponse,
} from "./listing-review-client.js";

const response: ListingViewResponse = {
  listingId: "00000000-0000-4000-8000-000000000101",
  status: "in_review",
  activeVersion: {
    id: "00000000-0000-4000-8000-000000000201",
    sequence: 2,
    content: {
      sku: "OPAK-001",
      producer: "Opak Cellar",
      productType: "wine",
      country: "Germany",
      region: "Mosel",
      vintage: 2024,
      grapeVarieties: ["Riesling"],
      volumeMl: 750,
      abvPercent: 12.5,
      packQuantity: 1,
      priceHkd: 288,
      stockQuantity: null,
      criticScores: [],
      awards: [],
      title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
      description: {
        en: "Dry Mosel Riesling.",
        "zh-Hant": "摩澤爾乾型雷司令。",
      },
      seo: {
        title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
        description: {
          en: "Dry Mosel Riesling.",
          "zh-Hant": "摩澤爾乾型雷司令。",
        },
      },
      tags: ["wine"],
      imageAssetIds: [],
    },
  },
  evidence: [
    {
      field: "producer",
      sourceAssetId: "asset-1",
      page: 1,
      excerpt: "Producer: Opak Cellar",
      confidence: 0.96,
    },
  ],
  flags: [
    {
      id: "description:health_claim:0",
      field: "description",
      rule: "health_claim",
      severity: "blocking",
      status: "open",
      resolutionReason: null,
    },
  ],
  connection: "connected",
  delivery: null,
  queueStatus: null,
  permissions: {
    canProcess: true,
    canEdit: true,
    canResolveFlags: true,
    canApprove: true,
    canDeliver: true,
  },
};

describe("listing review client mapping", () => {
  it("maps the live API snapshot into editable bilingual fields and stable flags", () => {
    const mapped = mapListingView(response);

    expect(mapped.model).toMatchObject({
      id: response.listingId,
      versionId: response.activeVersion?.id,
      status: "in_review",
      title: "Opak 雷司令",
    });
    expect(mapped.model.fields).toContainEqual(
      expect.objectContaining({
        key: "producer",
        value: "Opak Cellar",
        confidence: 0.96,
        evidence: expect.objectContaining({ source: "asset-1" }),
      }),
    );
    expect(mapped.model.fields).toContainEqual(
      expect.objectContaining({ key: "titleEn", value: "Opak Riesling" }),
    );
    expect(mapped.model.fields).toContainEqual(
      expect.objectContaining({ key: "titleZhHant", value: "Opak 雷司令" }),
    );
    expect(mapped.model.blockingFlags).toEqual([
      expect.objectContaining({
        id: "description:health_claim:0",
        code: "health_claim",
        field: "description",
        status: "open",
      }),
    ]);
    expect(mapped.delivery).toMatchObject({
      connection: "connected",
      canReview: true,
      status: "in_review",
    });
  });

  it("applies edited scalar and localized fields without losing canonical metadata", () => {
    const { model } = mapListingView(response);
    const edited = model.fields.map((field) => {
      if (field.key === "priceHkd") return { ...field, value: "318" };
      if (field.key === "titleZhHant")
        return { ...field, value: "Opak 精選雷司令" };
      if (field.key === "stockQuantity") return { ...field, value: "12" };
      return field;
    });

    const listing = applyListingFields(response.activeVersion!.content, edited);

    expect(listing.priceHkd).toBe(318);
    expect(listing.stockQuantity).toBe(12);
    expect(listing.title).toEqual({
      en: "Opak Riesling",
      "zh-Hant": "Opak 精選雷司令",
    });
    expect(listing.seo).toEqual(response.activeVersion!.content.seo);
    expect(listing.tags).toEqual(["wine"]);
  });

  it("rejects a response without an active AI-generated version", () => {
    expect(() => mapListingView({ ...response, activeVersion: null })).toThrow(
      "Listing is not ready for review",
    );
  });

  it.each(["received", "processing", "needs_info", "failed"] as const)(
    "renders %s without an active AI version as processing state",
    (status) => {
      expect(
        resolveListingViewState({
          snapshotStatus: status,
          hasSnapshot: true,
          hasMappedView: false,
          loadError: null,
          mappingError: null,
        }),
      ).toEqual({ kind: "processing", status });
    },
  );

  it("shows the mapping error instead of an endless loading state", () => {
    expect(
      resolveListingViewState({
        snapshotStatus: "in_review",
        hasSnapshot: true,
        hasMappedView: false,
        loadError: null,
        mappingError: "Listing is not ready for review",
      }),
    ).toEqual({
      kind: "error",
      message: "Listing is not ready for review",
    });
  });
});
