import { emptyWorkingListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { computeCurrentContentGaps } from "./current-content-gaps";

describe("current editable content gap assessment", () => {
  it("uses the saved Chinese copy even when the historical source lacked it", () => {
    const content = emptyWorkingListing();
    content.title = { en: "Synthetic Estate 2024", "zh-Hant": "合成酒莊 2024" };
    const result = computeCurrentContentGaps({
      content,
      assessmentState: "assessed",
    });
    expect(result.assessmentState).toBe("assessed");
    expect(result.gaps?.untranslatedName).toBe(false);
  });

  it("treats blank working copy as missing fields rather than clean content", () => {
    const result = computeCurrentContentGaps({
      content: emptyWorkingListing(),
      assessmentState: "assessed",
    });
    expect(result.gaps).toMatchObject({
      untranslatedName: true,
      untranslatedSeoTitle: true,
      summaryMissing: true,
    });
  });

  it.each(["missing", "invalid"] as const)(
    "keeps %s assessment distinct from zero gaps",
    (assessmentState) => {
      expect(
        computeCurrentContentGaps({ content: null, assessmentState }),
      ).toEqual({ gaps: null, assessmentState });
    },
  );

  it("cannot claim assessed when current content is absent", () => {
    expect(
      computeCurrentContentGaps({ content: null, assessmentState: "assessed" }),
    ).toEqual({ gaps: null, assessmentState: "missing" });
  });

  it("preserves proper-name equality as an advisory check signal", () => {
    const content = emptyWorkingListing();
    content.title = { en: "Château Synthetic", "zh-Hant": "Château Synthetic" };
    expect(
      computeCurrentContentGaps({ content, assessmentState: "assessed" }).gaps
        ?.untranslatedName,
    ).toBe(true);
  });
});
