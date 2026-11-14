import { parseCopyProposalPayload } from "./copy-proposal";
import { outputPayloadDigest } from "./output-service";

export function outputDigestMatches(version: {
  payload: Record<string, unknown>;
  contentDigest?: string;
}): boolean {
  return (
    typeof version.contentDigest === "string" &&
    outputPayloadDigest(version.payload) === version.contentDigest
  );
}

export type ProposalFreshness = "current" | "stale" | "unavailable";

/** Snapshot comparison only: an artifact approval never applies listing data. */
export function proposalFreshness(
  payload: unknown,
  current: { versionId: string; sequence: number } | null,
): ProposalFreshness {
  const proposal =
    typeof payload === "object" && payload !== null
      ? parseCopyProposalPayload(payload as Record<string, unknown>)
      : null;
  if (!proposal || !current) return "unavailable";
  return proposal.activeVersionId === current.versionId &&
    proposal.activeVersionSequence === current.sequence
    ? "current"
    : "stale";
}
