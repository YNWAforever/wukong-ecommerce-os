import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/locale-context.js";
import type { Locale } from "../lib/locale.js";
import { SupportingEvidencePanel } from "./supporting-evidence-panel";

// LocaleProvider calls useRouter to refresh after a locale change. Nothing
// here changes the locale -- each render picks one -- but the hook still runs.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const render = (locale: Locale) =>
  renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
      children: createElement(SupportingEvidencePanel),
    }),
  );

describe("SupportingEvidencePanel", () => {
  it("renders an explanation with no interactive form controls", () => {
    const markup = render("en");
    expect(markup).toContain("Supporting evidence");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
  });

  it("says the same thing in the reader's language, not both at once", () => {
    // The panel used to stack Chinese and English in one paragraph, so
    // neither reader was given a page in the language they chose.
    const en = render("en");
    const zh = render("zh-Hant");

    expect(en).toContain("Supporting evidence");
    expect(en).not.toMatch(/[一-鿿]/);
    expect(zh).toContain("補充證據");
    expect(zh).not.toContain("Supporting evidence");
  });
});
