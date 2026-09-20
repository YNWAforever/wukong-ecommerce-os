// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import {
  readWineSectionDraft,
  writeWineSectionDraft,
  type WineSectionDraft,
} from "./wine-section-draft";
afterEach(() => sessionStorage.clear());
const text = {
  key: "introduction" as const,
  en: "Before",
  "zh-Hant": "原有",
  locked: false,
};
const draft: WineSectionDraft = {
  schemaVersion: 1,
  expectedInputRevision: 2,
  baseVersionId: null,
  baseline: [text],
  sections: [{ ...text, en: "Unsaved" }],
};
it("isolates recovery by authorized listing key and stores no server authority", () => {
  expect(writeWineSectionDraft("listing-a", draft)).toBe(true);
  expect(readWineSectionDraft("listing-b")).toEqual({ state: "empty" });
  expect(readWineSectionDraft("listing-a")).toEqual({
    state: "recovered",
    draft,
  });
  expect(sessionStorage.getItem("listing-a")).not.toMatch(
    /owner|claimIds|proof/,
  );
});
it.each([
  { schemaVersion: 2 },
  { expectedInputRevision: 0 },
  { baseVersionId: "invalid" },
  { owner: "operator" },
  { sections: [{ ...text, claimIds: ["claim"] }] },
  { sections: [text, text] },
  { sections: [{ ...text, en: "x".repeat(20001) }] },
  { sections: [{ ...text, key: "tasting" }] },
])("fails closed on malformed or authority-bearing local draft %j", (extra) => {
  sessionStorage.setItem("listing-a", JSON.stringify({ ...draft, ...extra }));
  expect(readWineSectionDraft("listing-a")).toEqual({ state: "unavailable" });
});
it("fails closed on malformed JSON and overlarge stored payloads", () => {
  for (const raw of ["{", "x".repeat(3_000_001)]) {
    sessionStorage.setItem("listing-a", raw);
    expect(readWineSectionDraft("listing-a")).toEqual({ state: "unavailable" });
  }
});
