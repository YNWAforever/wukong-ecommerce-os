import { describe, expect, it } from "vitest";
import { webEvidence } from "@wukong/core";
import { validateWineSupportProposal } from "./index.js";
const sourceId = "00000000-0000-4000-8000-000000000001";
function validate(
  field: "volumeMl" | "ageYears" | "abvPercent",
  value: number,
  span: string,
) {
  validateWineSupportProposal({ sourceId, field, value, span }, [
    webEvidence({ id: sourceId, excerpt: span }),
  ]);
}
describe("wine mechanical numeric grounding", () => {
  it.each([
    [750, "75 cl"],
    [750, "0.75 L"],
    [750, "750 ml"],
    [500, "1/2 litre"],
    [750, "¾ L"],
    [5.5, "5.5 years"],
    [5.5, "5,5 years"],
  ] as const)("accepts normalized %s from %s", (value, span) => {
    expect(() =>
      validate(span.includes("years") ? "ageYears" : "volumeMl", value, span),
    ).not.toThrow();
  });
  it.each([
    [75, "75 cl"],
    [1, "1 litre"],
    [750, "750 cl"],
    [5.5, "5x5 years"],
    [5, "5.5 years"],
    [5, "5/2 years"],
    [1, "1/2 litre"],
    [2, "1/2 litre"],
    [750, "750 oz"],
  ] as const)("rejects unsupported %s from %s", (value, span) => {
    expect(() =>
      validate(span.includes("years") ? "ageYears" : "volumeMl", value, span),
    ).toThrow();
  });
});

it.each([
  [5500, "1½ L"],
  [500, "1 1/2 L"],
] as const)(
  "withholds unsupported mixed fraction %s from %s",
  (value, span) => {
    expect(() => validate("volumeMl", value, span)).toThrow();
  },
);
