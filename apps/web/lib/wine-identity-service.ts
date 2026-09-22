import { sameWineValue, type WineIdentityCoordinates } from "@wukong/core";
import type { ListingInputSnapshot } from "@wukong/db";
import {
  readAdoptedWineDependencies,
  parseWineStageResult,
  type ListingOperation,
} from "@wukong/db";
import { wineAdmissionEnabled } from "./wine-enrichment-service";
import {
  listingInputDigest,
  readWineIdentityCandidate,
  wineSelectionContextDigest,
  type WorkspaceRepositories,
  type WineIdentityReference,
} from "@wukong/db";
import { wineIdentitySelectionSchema } from "@wukong/core";
import {
  acceptListingOperation,
  type AcceptedListingOperation,
} from "./listing-operation-service";
import type { WineAdmissionContext } from "./wine-enrichment-service";
import { ApiError } from "./route-support";
export type ConfirmWineIdentityInput = WineIdentityReference & {
  workspaceId: string;
  listingId: string;
  actorId: string;
  expectedInputRevision: number;
  baseVersionId: string | null;
  operationKey: string;
};
function merchantMatches(
  input: ListingInputSnapshot,
  identity: WineIdentityCoordinates,
) {
  return (
    ["producer", "volumeMl", "packQuantity", "vintage", "productType"] as const
  ).every((field) => {
    const state = input.fieldStates[field],
      value = input.workingContent[field];
    if ((!state?.locked && state?.owner !== "operator") || value === null)
      return true;
    const selected =
      field === "vintage"
        ? identity.vintage.year
        : field === "productType"
          ? identity.kind
          : identity[field];
    return sameWineValue(value, selected);
  });
}
async function requireCurrentOrigin(
  r: WorkspaceRepositories,
  workspaceId: string,
  run: ListingOperation,
) {
  const listing = await r.listings.getById(run.listingId);
  const current = await r.pipelineRuns.getCurrentOperation(run.listingId);
  if (
    !listing ||
    current?.id !== run.id ||
    current.executionState !== "succeeded" ||
    listing.inputRevision !== run.inputRevision
  )
    throw new ApiError(
      409,
      "wine_identity_candidate_unavailable",
      "The identity candidate is no longer current.",
    );
  if (listing.activeVersionId !== run.baseVersionId) {
    if (!listing.activeVersionId)
      throw new ApiError(
        409,
        "base_version_conflict",
        "The originating version changed.",
      );
    const adopted = await readAdoptedWineDependencies(r, {
      workspaceId,
      listingId: run.listingId,
      versionId: listing.activeVersionId,
      inputRevision: run.inputRevision,
    });
    if (
      adopted.status !== "available" ||
      adopted.originRunId !== run.id ||
      adopted.refreshRequired
    )
      throw new ApiError(
        409,
        "base_version_conflict",
        "The originating version changed.",
      );
  }
}
/** Availability is a fresh server read. Acceptance repeats every check under the listing lock. */
export async function readConfirmableWineIdentityCandidates(
  r: WorkspaceRepositories,
  workspaceId: string,
  run: ListingOperation,
) {
  try {
    if (
      !wineAdmissionEnabled() ||
      !(await r.workspaces.requireProfile()).wineEnrichment?.enabled
    )
      return [];
    await requireCurrentOrigin(r, workspaceId, run);
    const deep = await r.wineEnrichment.readStage(run.id, "verification_deep");
    const stage =
      deep?.state === "succeeded"
        ? ("verification_deep" as const)
        : ("verification" as const);
    const row =
      stage === "verification_deep"
        ? deep
        : await r.wineEnrichment.readStage(run.id, stage);
    if (!row) return [];
    const result = parseWineStageResult(
      (row.output as { result: unknown }).result,
      stage,
    );
    if (
      result.state !== "succeeded" ||
      (result.stage !== "verification" &&
        result.stage !== "verification_deep") ||
      !result.frozenVerification
    )
      return [];
    const now = await r.pipelineRuns.acceptanceTimestamp();
    const eligible = [];
    for (const source of result.frozenVerification.sources) {
      if (source.kind !== "web" || !source.identity) continue;
      try {
        const candidate = await readWineIdentityCandidate(
          r,
          {
            workspaceId,
            listingId: run.listingId,
            sourceRunId: run.id,
            sourceStage: stage,
            sourceId: source.id,
          },
          now,
        );
        if (!merchantMatches(candidate.input, candidate.identity)) continue;
        eligible.push({
          id: source.id,
          runId: run.id,
          stage,
          identity: candidate.source.identity!,
          confirmationAvailable: true as const,
        });
      } catch {
        /* Unavailable candidates stay display-only. */
      }
    }
    return eligible;
  } catch {
    return [];
  }
}
export async function confirmWineIdentity(
  r: WorkspaceRepositories,
  input: ConfirmWineIdentityInput,
  admission: WineAdmissionContext,
): Promise<AcceptedListingOperation> {
  await r.listings.lockReviewState(input.listingId);
  const listing = await r.listings.getById(input.listingId);
  if (!listing)
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  const reference = {
    sourceRunId: input.sourceRunId,
    sourceStage: input.sourceStage,
    sourceId: input.sourceId,
  };
  const requestDigest = listingInputDigest({
    action: "wine-identity-selection@1",
    ...reference,
    expectedInputRevision: input.expectedInputRevision,
    baseVersionId: input.baseVersionId,
  });
  const replay = await r.listingInputs.getByOperationKey(
    input.listingId,
    input.operationKey,
  );
  const accept = (revision: number) =>
    acceptListingOperation(
      r,
      {
        ...input,
        expectedInputRevision: revision,
        observedInputRevision: input.expectedInputRevision,
        wineMode: "research",
        wineOnly: true,
        wineIdentityReference: reference,
      },
      admission,
    );
  if (replay) {
    if (
      replay.requestDigest !== requestDigest ||
      !replay.workingContent.wineIdentitySelection
    )
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This selection key has different inputs.",
      );
    return accept(replay.revision);
  }
  const current = await r.listingInputs.getCurrent(input.listingId);
  if (!current || current.revision !== input.expectedInputRevision)
    throw new ApiError(
      409,
      "input_revision_conflict",
      "Reload current inputs before selecting an identity.",
    );
  if (listing.activeVersionId !== input.baseVersionId)
    throw new ApiError(
      409,
      "base_version_conflict",
      "Reload the current version before selecting an identity.",
    );
  const operation = await r.pipelineRuns.getCurrentOperation(input.listingId);
  if (
    operation?.id !== input.sourceRunId ||
    operation.executionState !== "succeeded" ||
    operation.inputRevision !== current.revision
  )
    throw new ApiError(
      409,
      "wine_identity_candidate_unavailable",
      "The identity candidate is no longer current.",
    );
  await requireCurrentOrigin(r, input.workspaceId, operation);
  return r.pipelineRuns.withAcceptanceSavepoint(async () => {
    const now = await r.pipelineRuns.acceptanceTimestamp();
    let candidate;
    try {
      candidate = await readWineIdentityCandidate(
        r,
        {
          ...reference,
          workspaceId: input.workspaceId,
          listingId: input.listingId,
        },
        now,
      );
    } catch {
      throw new ApiError(
        409,
        "wine_identity_candidate_unavailable",
        "Refresh evidence before selecting this identity.",
      );
    }
    if (!merchantMatches(current, candidate.identity))
      throw new ApiError(
        409,
        "wine_identity_selection_conflict",
        "Resolve the conflicting merchant identity field before selecting this candidate.",
      );
    const selection = wineIdentitySelectionSchema.parse({
      schemaVersion: 1,
      ...reference,
      workspaceId: input.workspaceId,
      listingId: input.listingId,
      sourceInputRevision: candidate.run.inputRevision,
      sourceInputDigest: candidate.input.inputDigest,
      sourceBaseVersionId: candidate.run.baseVersionId,
      sourceStageDigest: listingInputDigest(candidate.stage),
      identityDigest: listingInputDigest(candidate.source.identity),
      selectedIdentity: candidate.identity,
      selectedBy: input.actorId,
      selectedAt: now,
      selectedInputRevision: current.revision + 1,
      contextDigest: wineSelectionContextDigest({
        ...current,
        baseVersionId: input.baseVersionId,
      }),
    });
    const context = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
    };
    const saved = await r.listingInputs.saveIdentitySelection(
      { ...input, changes: [], requestDigest },
      selection,
      context,
      r.audit,
    );
    await r.audit.write({
      ...context,
      action: "listing.wine_identity_selected",
      metadata: {
        ...reference,
        inputRevision: saved.revision,
        identityDigest: selection.identityDigest,
      },
    });
    return accept(saved.revision);
  });
}
