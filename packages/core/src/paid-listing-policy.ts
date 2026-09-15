import { calculateConservativeRunCeiling } from "./provider-cost-bound.js";
import type { WorkspaceProfile } from "./listing-schema.js";

/** Deliberately small, reviewed registry. Unknown models are never silently routed. */
const contextCeilings: Record<
  string,
  { tokens: number; input: number; output: number }
> = {
  "openai:gpt-4o": { tokens: 128000, input: 2.5, output: 10 },
  "openai:gpt-4o-2024-08-06": { tokens: 128000, input: 2.5, output: 10 },
  "openai:gpt-4.1": { tokens: 1047576, input: 2, output: 8 },
  "openai:gpt-4.1-2025-04-14": { tokens: 1047576, input: 2, output: 8 },
};

/**
 * Reserve the full documented model context, including media, for every call.
 * This avoids claiming an unenforced small per-image/token estimate as a cap.
 * Pricing changes and external provider billing still require reconciliation.
 * Sources and review date are in docs/implementation/astra6-paid-admission.md.
 */
export function paidListingReservation(
  policy: NonNullable<WorkspaceProfile["listingAi"]>,
): string {
  const model = contextCeilings[`${policy.provider}:${policy.model}`];
  if (
    !model ||
    policy.maxInputTokens < model.tokens ||
    policy.inputUsdPerMillion < model.input ||
    policy.outputUsdPerMillion < model.output
  )
    throw new Error("unverified_model_budget_bound");
  const ceiling = calculateConservativeRunCeiling({
    ...policy,
    maxPhysicalCalls: 4,
  });
  if (Number(policy.runCeilingUsd) < Number(ceiling))
    throw new Error("run_ceiling_too_small");
  return ceiling;
}
