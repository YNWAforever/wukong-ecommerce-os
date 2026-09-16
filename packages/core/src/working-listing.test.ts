import { describe, expect, it } from "vitest";
import * as working from "./working-listing.js";

describe("persistent working listing", () => {
  it("supports empty localized copy and unknown commercial facts", () => {
    expect(working.workingListingSchema).toBeDefined();
    const document = working.emptyWorkingListing();
    expect(document.priceHkd).toBeNull();
    expect(document.title.en).toBe("");
    expect(working.workingListingSchema.parse(document)).toEqual(document);
  });
  it("distinguishes explicit zero, clear, manual ownership and non-vintage", () => {
    const result = working.applyWorkingChanges(
      working.emptyWorkingListing(),
      {},
      [
        { field: "priceHkd", value: 0, locked: false },
        {
          field: "vintage",
          value: null,
          state: "not_applicable",
          locked: true,
        },
        { field: "title.en", value: "Merchant title", locked: false },
      ],
    );
    expect(result.content.priceHkd).toBe(0);
    expect(result.fieldStates["title.en"]).toMatchObject({
      owner: "operator",
      state: "manual",
      locked: false,
    });
    expect(result.fieldStates.vintage?.state).toBe("not_applicable");
    expect(() =>
      working.applyWorkingChanges(result.content, result.fieldStates, [
        { field: "priceHkd", value: null, state: "not_applicable" },
      ]),
    ).toThrow();
  });
  it("preserves operator-owned unlocked values during automatic adoption", () => {
    const manual = working.applyWorkingChanges(
      working.emptyWorkingListing(),
      {},
      [{ field: "title.en", value: "Human" }],
    );
    const candidate = {
      ...working.emptyWorkingListing(),
      title: { en: "AI", "zh-Hant": "AI" },
    };
    expect(
      working.mergeWorkingCandidate(
        manual.content,
        manual.fieldStates,
        candidate,
      ).title.en,
    ).toBe("Human");
  });
  it("rejects arbitrary paths, client ownership and mismatched field types", () => {
    for (const value of [
      { field: "__proto__", value: {} },
      { field: "title.en", value: "x", owner: "ai" },
      { field: "priceHkd", value: "100" },
    ]) {
      expect(working.workingChangeSchema.safeParse(value).success).toBe(false);
    }
  });
});

it("never automatically imports merchant commercial fields from an AI candidate", () => {
  const base = working.emptyWorkingListing();
  const candidate = {
    ...base,
    sku: "invented",
    priceHkd: 999,
    stockQuantity: 20,
  };
  expect(working.mergeWorkingCandidate(base, {}, candidate)).toMatchObject({
    sku: null,
    priceHkd: null,
    stockQuantity: null,
  });
});
it("derives populated review fields while retaining operator locks and unknown commerce", () => {
  const original = working.applyWorkingChanges(
    working.emptyWorkingListing(),
    {},
    [{ field: "producer", value: "Operator", locked: true }],
  );
  const active = {
    ...working.emptyWorkingListing(),
    producer: "AI maker",
    title: { en: "Generated title", "zh-Hant": "生成名稱" },
    priceHkd: 99,
  };
  const baseline = working.workingBaselineForReview(
    original.content,
    original.fieldStates,
    active,
  );
  expect(baseline.workingContent.title.en).toBe("Generated title");
  expect(baseline.workingContent.producer).toBe("Operator");
  expect(baseline.workingContent.priceHkd).toBeNull();
  expect(baseline.fieldStates["title.en"]).toMatchObject({
    owner: "ai",
    state: "proposed",
    evidenceRefs: [],
  });
  expect(baseline.fieldStates.producer?.locked).toBe(true);
});
