import { describe, expect, it } from "vitest";

import {
  evidenceSourceSchema,
  productIdentitySchema,
  supportedClaimSchema,
  wineContentSchema,
} from "./wine-enrichment-contracts.js";
import { webEvidence, wineIdentity } from "./wine-enrichment-fixtures.js";

describe("wine enrichment contracts", () => {
  it("distinguishes unknown from explicit non-vintage", () => {
    expect(productIdentitySchema.parse(wineIdentity()).vintage).toEqual({
      state: "unknown",
      year: null,
    });
    expect(
      productIdentitySchema.safeParse(
        wineIdentity({
          vintage: { state: "not_applicable", year: 2020 } as never,
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts an explicit non-vintage identity", () => {
    expect(
      productIdentitySchema.parse(
        wineIdentity({ vintage: { state: "not_applicable", year: null } }),
      ).vintage,
    ).toEqual({ state: "not_applicable", year: null });
  });

  it("requires evidence-backed observations for known identity fields", () => {
    expect(
      productIdentitySchema.safeParse({
        ...wineIdentity(),
        observations: {},
      }).success,
    ).toBe(false);
  });

  it("requires known identity observations to carry the corresponding value", () => {
    expect(
      productIdentitySchema.safeParse({
        ...wineIdentity(),
        observations: {
          ...wineIdentity().observations,
          producer: {
            value: "Another Estate",
            state: "observed",
            evidenceIds: ["00000000-0000-4000-8000-000000000001"],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects merchant-owned values and unknown keys in category fields", () => {
    expect(
      productIdentitySchema.safeParse(
        wineIdentity({
          category: {
            price: {
              value: 120,
              state: "observed",
              evidenceIds: ["00000000-0000-4000-8000-000000000001"],
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects a web source without an HTTPS URL", () => {
    expect(
      evidenceSourceSchema.safeParse(
        webEvidence({ url: "http://example.test/wine" }),
      ).success,
    ).toBe(false);
  });

  it("enforces disjoint source requirements", () => {
    expect(
      evidenceSourceSchema.safeParse(
        webEvidence({ kind: "photo", assetId: null, url: null }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown claim fields", () => {
    expect(
      supportedClaimSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000002",
        field: "price",
        value: "HKD 120",
        kind: "fact",
        scope: "product",
        evidenceIds: ["00000000-0000-4000-8000-000000000001"],
        premiseClaimIds: [],
        state: "accepted",
        reason: "Fixture",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown section key", () => {
    const content = {
      title: { en: "Reserve Red", "zh-Hant": "珍藏紅酒" },
      sections: [
        {
          key: "price",
          en: "HKD 120",
          "zh-Hant": "港幣 120 元",
          claimIds: [],
          locked: false,
          owner: "automatic",
        },
      ],
      seo: {
        title: { en: "Reserve Red", "zh-Hant": "珍藏紅酒" },
        description: { en: "Synthetic fixture", "zh-Hant": "合成測試資料" },
      },
      tags: [],
    };

    expect(wineContentSchema.safeParse(content).success).toBe(false);
  });

  it("returns independent fixture objects", () => {
    const first = wineIdentity();
    const second = wineIdentity();
    first.aliases.push("mutated");
    first.observations.producer!.evidenceIds.push(
      "00000000-0000-4000-8000-000000000009",
    );

    expect(second.aliases).toEqual([]);
    expect(second.observations.producer!.evidenceIds).toHaveLength(1);
  });
});
