import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminTabs } from "./admin-tabs";

describe("AdminTabs", () => {
  it("shows three tabs with Members selected by default", () => {
    const markup = renderToStaticMarkup(<AdminTabs />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("成員");
    expect(markup).toContain("SHOPLINE 連線");
    expect(markup).toContain("設定");

    // Extract every <button ...>...</button> tag and confirm exactly one is
    // selected, and that it's the Members tab.
    const buttonPattern = /<button[^>]*>[^<]*<\/button>/g;
    const buttons = markup.match(buttonPattern) ?? [];
    expect(buttons).toHaveLength(3);

    const selectedButtons = buttons.filter((button) =>
      button.includes('aria-selected="true"'),
    );
    expect(selectedButtons).toHaveLength(1);
    expect(selectedButtons[0]).toContain("成員");
  });
});
