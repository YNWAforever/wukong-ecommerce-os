import { describe, expect, it } from "vitest";
import { studioCopy } from "../studio-copy";
import { guidedCopy } from "./guided-copy";
import {
  STUDIO_TERMS,
  studioSkillTerm,
  studioTerm,
  studioTermMessage,
} from "./terms";

/**
 * One vocabulary contract: the rail, the batch page, the guided journey and
 * saved work all read the same canonical terms, so "Merchant audit" or
 * "Selected-listing gaps" cannot creep back in as a second name for the same
 * concept (see docs/superpowers/specs/2026-11-16-studio-usability-audit.md).
 */
describe("Studio vocabulary", () => {
  it("pins the canonical terms", () => {
    expect(STUDIO_TERMS.workspaceAudit).toEqual([
      "工作區稽核",
      "Workspace audit",
    ]);
    expect(STUDIO_TERMS.gapReview).toEqual(["缺口檢視", "Gap review"]);
    expect(STUDIO_TERMS.copyProposal).toEqual(["文案建議", "Copy proposal"]);
    expect(STUDIO_TERMS.batchReview).toEqual(["批次審查", "Batch review"]);
    expect(STUDIO_TERMS.savedWork).toEqual(["已儲存成果", "Saved work"]);
    expect(studioTerm("en", "conversation")).toBe("Conversation");
    expect(studioTerm("zh-Hant", "conversation")).toBe("對話");
    expect(studioTermMessage("reviewSignOff")).toEqual({
      en: "Review sign-off",
      "zh-Hant": "覆核",
    });
  });

  it("reads the same term in every surface", () => {
    for (const locale of ["en", "zh-Hant"] as const) {
      expect(studioCopy(locale, "studio.rail.reviews")).toBe(
        studioTerm(locale, "batchReview"),
      );
      expect(studioCopy(locale, "studio.reviews.title")).toBe(
        studioTerm(locale, "batchReview"),
      );
      expect(studioCopy(locale, "studio.rail.outputs")).toBe(
        studioTerm(locale, "savedWork"),
      );
      expect(studioCopy(locale, "studio.outputs.title")).toBe(
        studioTerm(locale, "savedWork"),
      );
      expect(guidedCopy(locale, "audit")).toBe(
        studioTerm(locale, "workspaceAudit"),
      );
      expect(guidedCopy(locale, "gap_review")).toBe(
        studioTerm(locale, "gapReview"),
      );
      expect(guidedCopy(locale, "copy_proposal")).toBe(
        studioTerm(locale, "copyProposal"),
      );
    }
  });

  it("never shows a raw skill key, and falls back to a human term", () => {
    expect(studioSkillTerm("en", "merchant.audit")).toBe("Workspace audit");
    expect(studioSkillTerm("zh-Hant", "catalog.gap_review")).toBe("缺口檢視");
    expect(studioSkillTerm("en", "some.unknown_skill")).toBe("Guided review");
    expect(studioSkillTerm("en", null)).toBeNull();
  });
});
