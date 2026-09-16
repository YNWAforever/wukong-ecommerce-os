import { describe, it, expect } from "vitest";
import { paidListingReservation } from "./paid-listing-policy.js";
const policy = {
  provider: "openai" as const,
  model: "gpt-4o",
  pricingVersion: "2026-09-16",
  maxInputTokens: 128000,
  maxOutputTokens: 4096,
  inputUsdPerMillion: 2.5,
  outputUsdPerMillion: 10,
  runCeilingUsd: "2",
  budgetCapUsd: "20",
};
describe("reviewed paid listing bounds", () => {
  it("reserves every physical call at the entire documented context plus bounded output", () =>
    expect(paidListingReservation(policy)).toBe("1.443840"));
  it("rejects an arbitrary smaller text or image token estimate", () =>
    expect(() =>
      paidListingReservation({ ...policy, maxInputTokens: 1000 }),
    ).toThrow("unverified_model_budget_bound"));
  it("rejects an unreviewed provider or model rather than routing automatically", () => {
    expect(() =>
      paidListingReservation({ ...policy, model: "other" }),
    ).toThrow();
    expect(() =>
      paidListingReservation({
        ...policy,
        provider: "openrouter",
        model: "openai/gpt-4o",
      }),
    ).toThrow();
  });
  it("rejects pricing below the reviewed standard rate", () =>
    expect(() =>
      paidListingReservation({ ...policy, inputUsdPerMillion: 0.1 }),
    ).toThrow());
});
it("reserves Go at full 1M context and peak rates, never at zero subscription cost", () => {
  const go = {
    ...policy,
    provider: "opencode-go" as const,
    model: "deepseek-v4.1-flash",
    maxInputTokens: 1048576,
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 1.2,
  };
  expect(paidListingReservation(go)).toBe("1.277952");
  expect(() =>
    paidListingReservation({ ...go, inputUsdPerMillion: 0.15 }),
  ).toThrow("unverified_model_budget_bound");
});
