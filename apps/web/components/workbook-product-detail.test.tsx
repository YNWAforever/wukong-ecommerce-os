// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkbookProductDetail } from "./workbook-product-detail";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("shows immutable stored fields as text without executing HTML or fetching images", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      product: {
        title: { en: "Stored title", "zh-Hant": "原始名稱" },
        productId: "0009007199254740993123",
        sku: "0001",
        priceHkd: 99.5,
        raw: {
          descriptionEn: "<script>bad()</script>",
          imageUrl: "https://external.example/image.jpg",
          variantId: "0002",
        },
      },
      source: {
        filename: "synthetic.xlsx",
        sheetName: "Default",
        inferredExportTime: null,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(WorkbookProductDetail, { id: "saved" })),
    );
    for (const value of [
      "Stored title",
      "原始名稱",
      "0009007199254740993123",
      "0001",
      "99.5",
      "synthetic.xlsx",
      "<script>bad()</script>",
      "https://external.example/image.jpg",
    ])
      expect(container.textContent).toContain(value);
    expect(container.querySelector("script,img,iframe")).toBeNull();
    expect(container.querySelector('a[href^="https:"]')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
