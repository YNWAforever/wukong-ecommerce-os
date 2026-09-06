import { usesProductShotWorkflow as policy } from "@wukong/core";
/** Server-owned eligibility; dispatch readiness must never relax image approval. */
export function usesProductShotWorkflow(input: {
  hasSelection: boolean;
  hasLegacyCutout: boolean;
}): boolean {
  return policy({ ...input, provider: process.env.PRODUCT_SHOT_PROVIDER });
}
