export function estimateTypeSafeCost(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): { estimatedCostUsd: number | null; pricingVersion: string | null } {
  if (
    model !== "jev-1.13.0" ||
    inputTokens === null ||
    outputTokens === null ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return { estimatedCostUsd: null, pricingVersion: null };
  }
  return {
    estimatedCostUsd: (inputTokens * 0.042) / 1_000_000,
    pricingVersion: "typesafe-public-2026-09-22-jev-1.13.0",
  };
}
