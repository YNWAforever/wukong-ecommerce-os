import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListingIntakeTabs } from "./listing-intake-tabs";

describe("ListingIntakeTabs", () => {
  it("shows four tabs with Website selected by default", () => {
    const markup = renderToStaticMarkup(<ListingIntakeTabs />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("試算表");
    expect(markup).toContain("補充證據");
    expect(markup).toContain("新商品");

    const buttonPattern = /<button[^>]*role="tab"[^>]*>[^<]*<\/button>/g;
    const buttons = markup.match(buttonPattern) ?? [];
    expect(buttons).toHaveLength(4);

    const selectedButtons = buttons.filter((button) =>
      button.includes('aria-selected="true"'),
    );
    expect(selectedButtons).toHaveLength(1);
    expect(selectedButtons[0]).toContain("網站");
  });
});
