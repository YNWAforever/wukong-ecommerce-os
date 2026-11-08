import { calculateConservativeRunCeiling } from "../provider-cost-bound.js";
import { getReviewedModelCostBound } from "../paid-listing-policy.js";

/**
 * Reviewed per-turn budget admission for the Studio model (plan Task 8).
 *
 * A turn has at most two physical model calls (planner + composer). The hold
 * uses the same conservative round-up-to-6dp rule as the listing pipeline and
 * fails closed on any model/pricing pair that is not in the reviewed registry.
 */
export type StudioAiPolicy = Readonly<{
  provider: "openrouter" | "opencode-go";
  model: string;
  pricingVersion: string;
  runCeilingUsd: string;
  budgetCapUsd: string;
  maxInputTokens: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxOutputTokens: number;
}>;

const DECIMAL = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;

export function studioTurnReservation(policy: StudioAiPolicy): string {
  const bound = getReviewedModelCostBound(policy.provider, policy.model);
  if (
    policy.maxInputTokens < bound.tokens ||
    policy.inputUsdPerMillion < bound.input ||
    policy.outputUsdPerMillion < bound.output
  )
    throw new Error("unverified_model_budget_bound");
  if (!policy.pricingVersion.trim())
    throw new Error("pricingVersion is required");
  if (!DECIMAL.test(policy.runCeilingUsd) || !DECIMAL.test(policy.budgetCapUsd))
    throw new Error("studio budget values must be decimal strings");
  const ceiling = calculateConservativeRunCeiling({
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
    maxPhysicalCalls: 2,
    inputUsdPerMillion: policy.inputUsdPerMillion,
    outputUsdPerMillion: policy.outputUsdPerMillion,
  });
  if (Number(policy.runCeilingUsd) < Number(ceiling))
    throw new Error("run_ceiling_too_small");
  if (Number(policy.budgetCapUsd) < Number(ceiling))
    throw new Error("budget_cap_too_small");
  return ceiling;
}
