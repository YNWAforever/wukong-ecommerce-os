import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { STUDIO_COPY } from "../lib/studio-copy";
import { STUDIO_TEMPLATES, StudioHome } from "./studio-home";

function render(locale: "zh-Hant" | "en") {
  return renderToStaticMarkup(<StudioHome locale={locale} />);
}

describe("StudioHome static shell", () => {
  it("renders the greeting, composer and the permanent disclaimer", () => {
    const html = render("en");

    expect(html).toContain("Welcome back");
    expect(html).toContain("Ask about listings, quality or jobs…");
    expect(html).toContain("AI may be wrong; verify important numbers.");
    expect(html).toContain("This page is not connected to a backend");
  });

  it("disables every composer action and says sending is unavailable", () => {
    const html = render("en");

    expect(html).toContain("Sending is not available yet.");
    // Exactly two buttons on the page (send + attach), both disabled. No
    // template card is interactive in P1.
    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect((html.match(/<button[^>]*disabled/g) ?? []).length).toBe(2);
  });

  it("renders the records-only overview rule without inventing numbers", () => {
    const html = render("en");

    expect(html).toContain("From workspace records; no AI call.");
    // Six tiles, each explicitly "Not yet available" instead of a count.
    expect((html.match(/>Not yet available</g) ?? []).length).toBe(6);
    expect(html).toContain("this card shows no estimated or invented numbers.");
  });

  it("renders every template card with an honest availability label", () => {
    const html = render("en");

    expect((html.match(/<h3/g) ?? []).length).toBe(STUDIO_TEMPLATES.length);
    expect((html.match(/>Pilot</g) ?? []).length).toBe(2);
    expect((html.match(/>Planned</g) ?? []).length).toBe(6);
    expect((html.match(/>Unavailable</g) ?? []).length).toBe(2);
  });

  it("marks only the two v1 read skills as pilot, and none as ready", () => {
    expect(
      STUDIO_TEMPLATES.filter(
        (template) => template.availability === "pilot",
      ).map((template) => template.id),
    ).toEqual(["catalog.find", "catalog.gap_review"]);
    expect(
      STUDIO_TEMPLATES.some((template) => template.availability === "ready"),
    ).toBe(false);
    expect(new Set(STUDIO_TEMPLATES.map((template) => template.id)).size).toBe(
      STUDIO_TEMPLATES.length,
    );
  });

  it("uses only copy keys that exist for every template", () => {
    for (const template of STUDIO_TEMPLATES) {
      for (const key of [
        template.titleKey,
        template.outcomeKey,
        template.limitationKey,
      ]) {
        expect(STUDIO_COPY[key]).toBeDefined();
      }
    }
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");

    expect(html).toContain("歡迎回來");
    expect(html).toContain("來自工作區記錄；不會呼叫 AI。");
    expect(html).toContain("AI 可能會出錯；重要數字請先核對。");
    expect(html).toContain("規劃中");
    expect(html).toContain("未能提供");
  });
});
