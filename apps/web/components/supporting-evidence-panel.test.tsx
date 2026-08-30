import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SupportingEvidencePanel } from "./supporting-evidence-panel";

describe("SupportingEvidencePanel", () => {
  it("renders an explanation with no interactive form controls", () => {
    const markup = renderToStaticMarkup(<SupportingEvidencePanel />);
    expect(markup).toContain("Supporting evidence");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
  });
});
