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
    "json_ld",
    "Unverified",
    "2026",
  ])
    expect(html).toContain(value);
  expect(html).not.toMatch(/<input|<button|\/listings\//);
});
