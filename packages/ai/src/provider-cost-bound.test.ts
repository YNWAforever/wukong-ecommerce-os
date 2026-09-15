import { expect, it } from "vitest";
import { calculateConservativeRunCeiling } from "./provider-cost-bound.js";

it("bounds every physical call using pinned input and output maxima", () => {
  expect(
    calculateConservativeRunCeiling({
      maxInputTokens: 20000,
      maxOutputTokens: 4096,
      maxPhysicalCalls: 4,
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
    }),
  ).toBe("0.445760");
});

it("refuses an unbounded or unsafe paid run", () => {
  expect(() =>
    calculateConservativeRunCeiling({
      maxInputTokens: 0,
      maxOutputTokens: 4096,
      maxPhysicalCalls: 4,
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
    }),
  ).toThrow(/positive/);
});

it("rounds a fractional microdollar ceiling upward", () => {
  expect(
    calculateConservativeRunCeiling({
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxPhysicalCalls: 1,
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.1,
    }),
  ).toBe("0.000001");
});
