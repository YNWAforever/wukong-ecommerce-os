import { describe, expect, it } from "vitest";

import fixture from "../fixtures/shopline-create-product.json" with { type: "json" };

import { SHOPLINE_CSV_SPEC_VERSION, createShoplineCsv, projectToShopline } from "./index.js";

describe("SHOPLINE CSV fallback", () => {
  it("emits the versioned golden CSV with stable columns and CRLF", () => {
    const csv = createShoplineCsv([fixture.expectedPayload]);

    expect(SHOPLINE_CSV_SPEC_VERSION).toBe("opak-2026-07");
    expect(csv).toBe(fixture.expectedCsv);
    expect(csv).toContain("SKU,English Title,Traditional Chinese Title,Price");
    expect(csv).toContain("OPAK-DEMO-001,Demo Estate Riesling 2024,Demo Estate 雷司令 2024,288");
    expect(csv).toMatch(/\r\n/);
    expect(csv).not.toMatch(/(?<!\r)\n/);
  });

  it("escapes commas, quotes, embedded CRLF, and Traditional Chinese deterministically", () => {
    const payload = projectToShopline(
      {
        ...fixture.canonicalListing,
        title: { en: 'Demo, "Reserve"', "zh-Hant": "限量，\"珍藏\"" },
        description: { en: "Line one\r\nLine two", "zh-Hant": "第一行\r\n第二行" },
      },
      ["https://cdn.example.test/a.jpg"],
    );
    const csv = createShoplineCsv([payload]);

    expect(csv).toContain('OPAK-DEMO-001,"Demo, ""Reserve""","限量，""珍藏""",288');
    expect(csv).toContain('"Line one\r\nLine two"');
    expect(csv).toContain("限量");
  });

  it("rejects invalid products before creating a CSV", () => {
    expect(() => createShoplineCsv([{ ...fixture.expectedPayload, product: { ...fixture.expectedPayload.product, status: true } } as never])).toThrow();
  });
});
