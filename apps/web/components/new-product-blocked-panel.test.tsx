import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NewProductBlockedPanel } from "./new-product-blocked-panel";

describe("NewProductBlockedPanel", () => {
  it("renders a blocked explanation with no interactive form controls", () => {
    const markup = renderToStaticMarkup(<NewProductBlockedPanel />);
    expect(markup).toContain("blocked");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
  });
});
