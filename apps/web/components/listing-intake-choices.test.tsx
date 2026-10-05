// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ListingIntakeChoices } from "./listing-intake-choices";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
vi.mock("./bulk-import-panel", () => ({
  BulkImportPanel: () =>
    createElement("p", null, "Current original SHOPLINE export"),
}));
vi.mock("./listing-intake-tabs", () => ({
  ListingIntakeTabs: () => createElement("p", null, "Read-only sources"),
}));
it("starts with maintenance and exposes reference-only and the actual new-draft route", () => {
  const html = renderToStaticMarkup(
    createElement(ListingIntakeChoices, { canScan: true }),
  );
  expect(html).toContain("Maintain existing SHOPLINE products");
  expect(html).toContain("Reference only");
  expect(html).toContain('href="/listings/new"');
  expect(html).toContain("Current original SHOPLINE export");
});
it("opens an explicitly requested reference-only intake without rendering the maintenance uploader", () => {
  const html = renderToStaticMarkup(
    createElement(ListingIntakeChoices, {
      canScan: true,
      initialIntent: "reference-only",
    }),
  );
  expect(html).toContain("Read-only sources");
  expect(html).not.toContain("Current original SHOPLINE export");
});
