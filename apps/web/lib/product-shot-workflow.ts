/** Server-owned eligibility; dispatch readiness must never relax image approval. */
export function usesProductShotWorkflow(input: {
  hasSelection: boolean;
  hasLegacyCutout: boolean;
}): boolean {
  return (
    input.hasSelection ||
    (!input.hasLegacyCutout &&
      ["fake", "photoroom"].includes(process.env.PRODUCT_SHOT_PROVIDER ?? ""))
  );
}
