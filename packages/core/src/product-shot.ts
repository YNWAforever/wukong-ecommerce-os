export type ProductShotState =
  | "queued"
  | "processing"
  | "cutout_ready"
  | "candidate_ready"
  | "approved"
  | "failed"
  | "outcome_unknown";

export type ShotIdentity = {
  workspaceId: string;
  listingId: string;
  sourceAssetId: string;
  sourceDigest: string;
  providerVersion: string;
  renderVersion: string;
};
export type ShotObservation = {
  attemptId: string;
  expectedVersionId: string;
  candidateDigest: string;
};
export type ShotCandidate = {
  assetId: string;
  digest: string;
  width: number;
  height: number;
  size: number;
  lowResolution: boolean;
};

export const PRODUCT_SHOT_LIMITS = {
  inputBytes: 10 * 1024 * 1024,
  inputPixels: 40_000_000,
  outputBytes: 2 * 1024 * 1024,
  canvas: 1600,
  inset: 0.8,
} as const;

export function nextShotAction(input: {
  state: ProductShotState;
  hasCutout: boolean;
  explicitFreshAttempt: boolean;
}): "reuse" | "prepare" | "dispatch" | "confirm_charge" {
  if (input.state === "approved" || input.state === "candidate_ready")
    return "reuse";
  if (input.hasCutout) return "prepare";
  if (input.state === "outcome_unknown" && !input.explicitFreshAttempt)
    return "confirm_charge";
  return "dispatch";
}

/** Shared pure server/worker workflow decision. Provider readiness never relaxes acceptance. */
export function usesProductShotWorkflow(input: {
  hasSelection: boolean;
  hasLegacyCutout: boolean;
  provider?: string;
}): boolean {
  return (
    input.hasSelection ||
    (!input.hasLegacyCutout &&
      ["fake", "photoroom"].includes(input.provider ?? ""))
  );
}
