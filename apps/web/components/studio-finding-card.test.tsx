// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioFindingCard } from "./studio-finding-card";

/**
 * Read-only category-map finding card (C1): stored suggestions with
 * confidence/evidence, unknown current category, not-applied note and the
 * review link. No apply control and no invented content.
 */

const payload = {
  schemaVersion: "wukong-category-map/v1",
  listingId: "11111111-1111-4111-8111-111111111111",
  listingTitle: "Synthetic wine",
  currentCategory: null,
  suggestions: [
    {
      path: "Beverages > Wine > Red",
      confidence: 0.75,
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

function render(
  locale: "zh-Hant" | "en" = "en",
  value: unknown = payload,
): string {
  return renderToStaticMarkup(
    <StudioFindingCard locale={locale} payload={value} />,
  );
}

describe("StudioFindingCard", () => {
  it("renders suggestions with confidence, evidence refs and rationale", () => {
    const html = render("en");
    expect(html).toContain("Category mapping proposal");
    expect(html).toContain("Synthetic wine");
    expect(html).toContain("Current category");
    expect(html).toContain("Unknown");
    expect(html).toContain("Beverages &gt; Wine &gt; Red");
    expect(html).toContain("75% (0.75)");
    expect(html).toContain("catalog:22222222-2222-4222-8222-222222222222");
    expect(html).toContain("Similar catalog rows are red wines.");
  });

  it("states nothing is applied, requires human review and links to the listing", () => {
    const html = render("en");
    expect(html).toContain(
      "Not applied — a person can only change the category in the existing catalog flow.",
    );
    expect(html).toContain(
      "Requires human review; Studio never writes canonical listing data.",
    );
    expect(html).toContain(
      'href="/listings/11111111-1111-4111-8111-111111111111"',
    );
    // Read-only: no apply/approve/publish control.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Apply");
    expect(html).not.toContain("Approve");
  });

  it("renders the stored limitations through copy keys", () => {
    const html = render("en");
    expect(html).toContain(
      "Category suggestions are for review only; nothing is applied to the listing or catalog automatically.",
    );
    expect(html).toContain("Canonical listing content has no category field");
  });

  it("shows the honest empty-suggestion state", () => {
    const html = render("en", { ...payload, suggestions: [] });
    expect(html).toContain(
      "No suggestions to show; the evidence and limitations are still stored.",
    );
  });

  it("renders an honest unavailable state for an invalid payload", () => {
    for (const invalid of [
      null,
      {},
      { ...payload, listingId: "" },
      { ...payload, schemaVersion: "other" },
      { ...payload, suggestions: [{ path: "x" }] },
    ]) {
      const html = render("en", invalid);
      expect(html).toContain(
        "This finding could not be displayed; nothing is invented.",
      );
      expect(html).not.toContain("<table");
    }
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");
    expect(html).toContain("分類對應建議");
    expect(html).toContain("目前分類");
    expect(html).toContain("尚未套用");
    expect(html).toContain("須人工審核");
  });
});
