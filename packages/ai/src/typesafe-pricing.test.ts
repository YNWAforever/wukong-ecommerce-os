import { describe, expect, it } from "vitest";
import { estimateTypeSafeCost } from "./typesafe-pricing.js";

describe("estimateTypeSafeCost", () => {
  it("uses the pinned Jev public input-token rate", () => {
    expect(estimateTypeSafeCost("jev-1.13.0", 1_000, 20)).toEqual({
      estimatedCostUsd: 0.000042,
      pricingVersion: "typesafe-public-2026-09-22-jev-1.13.0",
    });
  });

  it.each([
    ["jev-latest", 1, 1],
    ["jev-1.13.0", null, 1],
    ["jev-1.13.0", 1, null],
    ["jev-1.13.0", -1, 1],
    ["jev-1.13.0", 1.5, 1],
    ["jev-1.13.0", Number.MAX_SAFE_INTEGER + 1, 1],
  ] as const)(
    "returns unknown pricing for unusable input",
    (model, input, output) => {
      expect(estimateTypeSafeCost(model, input, output)).toEqual({
        estimatedCostUsd: null,
        pricingVersion: null,
      });
    },
  );
});
