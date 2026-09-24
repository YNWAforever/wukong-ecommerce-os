import {
  wineGenerationRequestSchema,
  validateWineGenerationRequest,
  type SupportedClaim,
  type SectionKey,
} from "@wukong/core";
import type { WineGenerationOwnership } from "./wine-generation-ownership.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
/** Pure request construction shared by live runtime and historical copy authorization. */
export function buildWineGenerationRequest(
  run: ListingOperation,
  own: WineGenerationOwnership,
  claims: SupportedClaim[],
  section: SectionKey | null,
) {
  if (own.status !== "available")
    throw Error("generation_ownership_unavailable");
  const profile = run.execution.profile as
    { tone?: unknown; claimPolicy?: unknown } | undefined;
  if (!profile) throw Error("generation_profile_required");
  const request = wineGenerationRequestSchema.parse({
    schemaVersion: 1,
    binding: {
      workspaceId: own.binding.workspaceId,
      operationId: run.id,
      inputRevision: run.inputRevision,
    },
    claims,
    current: own.prior.current,
    ownership: {
      schemaVersion: 1,
      priorKind: own.prior.kind,
      metadata: own.prior.metadata,
      legacyDescription:
        own.prior.kind === "legacy" ? own.prior.description : null,
      lockedPaths: own.lockedPaths,
      provenanceDigest: own.provenanceDigest,
    },
    lockedPaths: own.lockedPaths,
    tone: profile.tone,
    claimPolicy: profile.claimPolicy,
    section,
  });
  validateWineGenerationRequest(request);
  return request;
}
