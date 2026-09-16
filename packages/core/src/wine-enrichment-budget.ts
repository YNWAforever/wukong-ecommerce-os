import { z } from "zod";
import { getReviewedModelCostBound } from "./paid-listing-policy.js";
import { calculateConservativeRunCeiling } from "./provider-cost-bound.js";
import { sourcePreferencesSchema } from "./workspace-policy.js";
import type { WineMode } from "./wine-enrichment-contracts.js";

const provider = "opencode-go";
const model = "deepseek-v4.1-flash";
const reviewed = getReviewedModelCostBound(provider, model);
const maxOutputTokens = 4096;

/** Server configuration only. Parsing is not paid-provider activation or admission. */
export const wineEnrichmentPolicySchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    enabled: z.boolean().default(false),
    provider: z.literal(provider).default(provider),
    model: z.literal(model).default(model),
    policyVersion: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .default("wine-enrichment@1"),
    rulesVersion: z.literal("wine-grounding@1").default("wine-grounding@1"),
    maxInputTokens: z.literal(reviewed.tokens).default(reviewed.tokens),
    inputUsdPerMillion: z.literal(reviewed.input).default(reviewed.input),
    outputUsdPerMillion: z.literal(reviewed.output).default(reviewed.output),
    maxOutputTokens: z.literal(maxOutputTokens).default(maxOutputTokens),
    // The existing cumulative Go ledger and its unknown holds remain authoritative.
    budgetCapUsd: z.literal("10").default("10"),
    tavilyCreditCap: z.number().int().nonnegative().max(2147483647).default(0),
    allowedDomains: sourcePreferencesSchema.shape.allowedDomains
      .default([])
      .readonly(),
  })
  .strict()
  .readonly();
export type WineEnrichmentPolicy = z.infer<typeof wineEnrichmentPolicySchema>;

export type WineOperationBudget = Readonly<{
  goPhysicalCalls: 4 | 10;
  goReservedUsd: "1.277952" | "3.194880";
  tavilyCredits: 0 | 5;
}>;

/** No caller-supplied token, rate or call estimate can reduce this reservation. */
export function wineOperationBudget(mode: WineMode): WineOperationBudget {
  if (!["full", "research", "copy", "section"].includes(mode))
    throw new Error("unsupported_wine_mode");
  const searches = mode === "full" || mode === "research";
  const goPhysicalCalls = searches ? 10 : 4;
  const goReservedUsd = searches ? "3.194880" : "1.277952";
  const calculated = calculateConservativeRunCeiling({
    maxInputTokens: reviewed.tokens,
    inputUsdPerMillion: reviewed.input,
    outputUsdPerMillion: reviewed.output,
    maxOutputTokens,
    maxPhysicalCalls: goPhysicalCalls,
  });
  if (calculated !== goReservedUsd)
    throw new Error("wine_budget_requires_pricing_review");
  return Object.freeze({
    goPhysicalCalls,
    goReservedUsd,
    tavilyCredits: searches ? 5 : 0,
  });
}

/** Persist at execution.wineBudget; execution.wineMode must match mode at admission/runtime. */
export const wineBudgetSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["full", "research", "copy", "section"]),
    goPhysicalCalls: z.union([z.literal(4), z.literal(10)]),
    goReservedUsd: z.enum(["1.277952", "3.194880"]),
    tavilyCredits: z.union([z.literal(0), z.literal(5)]),
  })
  .strict()
  .refine((snapshot) => {
    const budget = wineOperationBudget(snapshot.mode);
    return (
      snapshot.goPhysicalCalls === budget.goPhysicalCalls &&
      snapshot.goReservedUsd === budget.goReservedUsd &&
      snapshot.tavilyCredits === budget.tavilyCredits
    );
  }, "Wine budget must equal the reviewed mode limits")
  .readonly();
export type WineBudgetSnapshot = z.infer<typeof wineBudgetSnapshotSchema>;

export function createWineBudgetSnapshot(mode: WineMode): WineBudgetSnapshot {
  return wineBudgetSnapshotSchema.parse({
    schemaVersion: 1,
    mode,
    ...wineOperationBudget(mode),
  });
}
