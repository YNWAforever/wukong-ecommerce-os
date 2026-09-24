import { describe, expect, it } from "vitest";

import { PRODUCT_SHOT_LIMITS, nextShotAction } from "./product-shot.js";

describe("product-shot domain", () => {
  it("publishes the approved image safety limits", () => {
    expect(PRODUCT_SHOT_LIMITS).toEqual({
      inputBytes: 10 * 1024 * 1024,
      inputPixels: 40_000_000,
      outputBytes: 2 * 1024 * 1024,
      canvas: 1600,
      inset: 0.8,
    });
  });

  it.each([
    [
      { state: "approved", hasCutout: false, explicitFreshAttempt: false },
      "reuse",
    ],
    [
      {
        state: "candidate_ready",
        hasCutout: false,
        explicitFreshAttempt: false,
      },
      "reuse",
    ],
    [
      { state: "failed", hasCutout: true, explicitFreshAttempt: false },
      "prepare",
    ],
    [
      {
        state: "outcome_unknown",
        hasCutout: false,
        explicitFreshAttempt: false,
      },
      "confirm_charge",
    ],
    [
      {
        state: "outcome_unknown",
        hasCutout: false,
        explicitFreshAttempt: true,
      },
      "dispatch",
    ],
    [
      { state: "queued", hasCutout: false, explicitFreshAttempt: false },
      "dispatch",
    ],
  ] as const)("selects the next action for %#", (input, expected) => {
    expect(nextShotAction(input)).toBe(expected);
  });
});
