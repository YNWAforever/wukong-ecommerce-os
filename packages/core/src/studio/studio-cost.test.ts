import { describe, expect, it } from "vitest";

import { studioTurnReservation, type StudioAiPolicy } from "./studio-cost.js";
import { STUDIO_PROMPT_VERSIONS } from "./studio-prompt-versions.js";

const base: StudioAiPolicy = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  pricingVersion: "studio-v1",
  runCeilingUsd: "1.000000",
  budgetCapUsd: "5.000000",
  maxInputTokens: 1048576,
  inputUsdPerMillion: 0.3,
  outputUsdPerMillion: 1.2,
  maxOutputTokens: 4096,
};

describe("studioTurnReservation", () => {
  it("reserves a 6dp ceiling for two calls and never exceeds the ceiling", () => {
    const reserved = studioTurnReservation(base);
    expect(reserved).toMatch(/^\d+\.\d{6}$/);
    expect(Number(reserved)).toBeGreaterThan(0);
    expect(Number(reserved)).toBeLessThanOrEqual(Number(base.runCeilingUsd));
  });

  it("is monotonic in the output ceiling", () => {
    const smaller = studioTurnReservation({ ...base, maxOutputTokens: 1024 });
    const larger = studioTurnReservation({ ...base, maxOutputTokens: 8192 });
    expect(Number(smaller)).toBeLessThanOrEqual(Number(larger));
  });

  it("fails closed on an unverified model, underpricing, or a missing pricing version", () => {
    expect(() =>
      studioTurnReservation({ ...base, model: "some-unreviewed-model" }),
    ).toThrow(/unverified_model_budget_bound/);
    expect(() =>
      studioTurnReservation({ ...base, inputUsdPerMillion: 0.0001 }),
    ).toThrow(/unverified_model_budget_bound/);
    expect(() =>
      studioTurnReservation({ ...base, pricingVersion: " " }),
    ).toThrow(/pricingVersion/);
  });

  it("refuses a run ceiling or budget cap below the reviewed hold", () => {
    expect(() =>
      studioTurnReservation({ ...base, runCeilingUsd: "0.000001" }),
    ).toThrow(/run_ceiling_too_small/);
    expect(() =>
      studioTurnReservation({ ...base, budgetCapUsd: "0.000001" }),
    ).toThrow(/budget_cap_too_small/);
  });

  it("pins planner, composer and proposer prompt versions", () => {
    expect(STUDIO_PROMPT_VERSIONS).toEqual({
      planner: "1.0.0",
      composer: "1.0.0",
      proposer: "1.0.0",
    });
  });
});
