import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StudioShell } from "./studio-shell";

function render(locale: "zh-Hant" | "en") {
  return renderToStaticMarkup(
    <StudioShell locale={locale} workspaceName="Opak Cellar">
      <p>page content</p>
    </StudioShell>,
  );
}

describe("StudioShell", () => {
  it("renders the workspace name, rail destinations and the page slot", () => {
    const html = render("en");

    expect(html).toContain("Opak Cellar");
    expect(html).toContain("page content");
    for (const href of [
      "/studio",
      "/studio/threads",
      "/studio/outputs",
      "/studio/connections",
      "/studio/settings",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    for (const label of [
      "New conversation",
      "Overview",
      "Conversations",
      "Outputs",
      "Tools",
      "Settings",
      "Recent conversations",
      "No conversations yet.",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("renders the zh-Hant rail labels when the locale is zh-Hant", () => {
    const html = render("zh-Hant");

    for (const label of [
      "新對話",
      "總覽",
      "對話",
      "輸出",
      "工具",
      "設定",
      "最近的對話",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("keeps every P1-only action visibly unavailable", () => {
    const html = render("en");

    // New conversation would create a thread; threads do not exist in P1.
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>New conversation<\/button>/,
    );
    expect(html).toContain(
      "This build only provides the overview page; the other destinations are not implemented yet.",
    );
    expect(html).toContain("Creating conversations is not available yet.");
  });

  it("does not invent a recent conversation", () => {
    const html = render("en");

    // The recent section's only content is the empty state: no dates, no
    // thread links (/studio/t/...), no fabricated titles.
    expect(html).toContain("No conversations yet.");
    expect(html).not.toMatch(/\/studio\/t\//);
  });
});
