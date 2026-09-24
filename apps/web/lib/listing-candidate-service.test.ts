import { describe, it, expect } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { candidateDifferences } from "./listing-candidate-service";
const snapshot = {
  revision: 1,
  baseVersionId: null,
  note: null,
  sources: [],
  workingContent: emptyWorkingListing(),
  fieldStates: {},
};
function run() {
  return {
    id: "run",
    inputRevision: 1,
    baseVersionId: null,
    execution: {
      input: snapshot,
      candidate: {
        ...emptyWorkingListing(),
        title: { en: "Candidate", "zh-Hant": "" },
      },
    },
  } as any;
}
describe("candidate compatibility", () => {
  it("offers a stored candidate field after unrelated manual edits", () => {
    const current = {
      ...snapshot,
      revision: 2,
      workingContent: {
        ...snapshot.workingContent,
        title: { en: "Human", "zh-Hant": "" },
      },
    };
    const result = candidateDifferences(run(), current as any);
    expect(result?.fields.find((f) => f.field === "title.en")).toMatchObject({
      value: "Candidate",
      currentValue: "Human",
      eligible: true,
    });
  });
  it("rejects changed sources, identity and locked fields", () => {
    const current = {
      ...snapshot,
      fieldStates: {
        "title.en": {
          owner: "operator",
          state: "manual",
          locked: true,
          evidenceRefs: [],
        },
      },
    };
    expect(
      candidateDifferences(run(), current as any)?.fields.find(
        (f) => f.field === "title.en",
      )?.reason,
    ).toBe("field_locked");
    expect(
      candidateDifferences(run(), {
        ...snapshot,
        note: "new source fact",
      } as any)?.fields.every((f) => !f.eligible),
    ).toBe(true);
  });
  it("never offers merchant commercial facts from an AI candidate", () => {
    const value = run();
    value.execution.candidate.priceHkd = 100;
    expect(
      candidateDifferences(value, snapshot as any)?.fields.find(
        (f) => f.field === "priceHkd",
      )?.eligible,
    ).toBe(false);
  });
});
it("offers only populated extraction facts and preserves human copy", () => {
  const value = run();
  value.execution.candidate = {
    stage: "extract",
    content: { ...emptyWorkingListing(), producer: "Extracted maker" },
    evidence: [],
  };
  const current = {
    ...snapshot,
    workingContent: {
      ...emptyWorkingListing(),
      title: { en: "Human title", "zh-Hant": "" },
      region: "Human region",
    },
  };
  value.execution.input = current;
  const diff = candidateDifferences(value, current as any);
  expect(diff?.fields.map((f) => f.field)).toEqual(["producer"]);
  expect(diff?.fields[0]).toMatchObject({
    value: "Extracted maker",
    eligible: true,
  });
});
