// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WebsiteProductObservation } from "./website-product-detail";
it("renders complete read-only evidence as text and validates every external link", () => {
  const html = renderToStaticMarkup(
    createElement(WebsiteProductObservation, {
      observation: {
        key: "https://store.example/p",
        sourceUrl: "https://store.example/p",
        capturedAt: "2026-09-06T00:00:00Z",
        title: "Synthetic",
        description: "<script>bad()</script>",
        price: { amount: "15", currency: "HKD" },
        availability: "unknown",
        imageUrls: ["javascript:alert(1)", "https://store.example/image"],
        attributes: { brand: "Synthetic brand" },
        fieldSources: { title: "json_ld" },
        warnings: ["Unverified"],
      },
    }),
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("javascript:");
  expect(html).toContain('rel="noreferrer noopener"');
  for (const value of [
    "15",
    "HKD",
    "Synthetic brand",
    "JSON-LD",
    "Unverified",
    "2026",
  ])
    expect(html).toContain(value);
  expect(html).not.toMatch(/<input|<button|\/listings\//);
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { WebsiteProductDetail } from "./website-product-detail";
it("recovers from a detail fetch failure using Retry", async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("{}", { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        observation: {
          key: "https://store.example/p",
          sourceUrl: "https://store.example/p",
          title: "Recovered bottle",
          capturedAt: "2026-09-06T00:00:00Z",
          availability: "unknown",
          imageUrls: [],
          attributes: {},
          fieldSources: {},
          warnings: [],
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(WebsiteProductDetail, { id: "one" })),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Recovered bottle");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps evidence in a native disclosure and localizes known provenance and availability", () => {
  const html = renderToStaticMarkup(
    createElement(WebsiteProductObservation, {
      observation: {
        key: "https://store.example/p",
        sourceUrl: "https://store.example/p",
        title: "Synthetic",
        capturedAt: "2026-09-06T00:00:00Z",
        availability: "in_stock",
        description: null,
        price: null,
        imageUrls: [],
        attributes: { brand: "Original brand" },
        fieldSources: { title: "json_ld", imageUrls: "html" },
        warnings: [],
      },
    }),
  );
  expect(html).toContain("<details");
  expect(html).toContain("<summary>來源證據</summary>");
  expect(html).not.toContain("<details open");
  expect(html).toContain("有現貨");
  expect(html).toContain("JSON-LD 結構化資料");
  expect(html).toContain("商品名稱");
  expect(html).not.toContain("in_stock");
  expect(html).not.toContain("注意事項");
});
