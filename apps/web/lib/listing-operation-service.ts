import {
  acceptWineOperation,
  wineAdmissionEnabled,
  type WineAdmissionContext,
} from "./wine-enrichment-service";
import type { WineMode } from "@wukong/core";
import { paidListingReservation, LISTING_PROMPT_VERSIONS } from "@wukong/core";
import { createHash } from "node:crypto";
import type { WorkspaceRepositories } from "@wukong/db";
import { ApiError } from "./route-support";

export type AcceptListingOperationInput = {
  workspaceId: string;
  listingId: string;
  expectedInputRevision: number;
  baseVersionId: string | null;
  operationKey: string;
  actorId: string;
  retryOfRunId?: string;
  observedInputRevision?: number;
  wineMode?: WineMode;
};
export type AcceptedListingOperation = {
  flowVersion?: "wine-enrichment-v1";
  processing: {
    runId: string;
    jobId: string;
    state: string;
    pollAfterMs: number;
  };
  outbox: {
    id: string;
    listingId: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    attempts: number;
  }[];
  run: {
    id: string;
    idempotencyKey: string;
    inputRevision: number;
    baseVersionId: string | null;
    runAttempt: number;
    executionState: string;
    activeVersionSequence: number;
  };
};
export async function acceptListingOperation(
  repos: WorkspaceRepositories,
  input: AcceptListingOperationInput,
  admission: WineAdmissionContext = {},
): Promise<AcceptedListingOperation> {
  await repos.listings.lockReviewState(input.listingId);
  const listing = await repos.listings.getById(input.listingId);
  if (!listing)
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify({
        revision: input.observedInputRevision ?? input.expectedInputRevision,
        baseVersionId: input.baseVersionId,
        retryOfRunId: input.retryOfRunId ?? null,
        ...(input.wineMode ? { wineMode: input.wineMode } : {}),
      }),
    )
    .digest("hex");
  const replay = await repos.pipelineRuns.findOperationRequest?.(
    input.listingId,
    input.operationKey,
  );
  if (replay) {
    if (replay.requestDigest !== requestDigest)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "This operation key has different inputs.",
      );
    return {
      processing: {
        runId: replay.id,
        jobId: replay.idempotencyKey,
        state: replay.executionState,
        pollAfterMs: 3000,
      },
      outbox: [],
      run: replay,
    };
  }
  const snapshot = await repos.listingInputs.getCurrent(input.listingId);
  if (!snapshot || snapshot.revision !== input.expectedInputRevision)
    throw new ApiError(
      409,
      "input_revision_conflict",
      "Reload the saved inputs before processing.",
    );
  if (listing.activeVersionId !== input.baseVersionId)
    throw new ApiError(
      409,
      "base_version_conflict",
      "The saved version changed. Reload before processing.",
    );
  if (listing.status === "publishing")
    throw new ApiError(
      409,
      "listing_not_retryable",
      "Publishing is in progress.",
    );
  if (wineAdmissionEnabled()) await repos.pipelineRuns.lockAdmissionBudget();
  const provider = process.env.AI_PROVIDER ?? "openai";
  const profile = await repos.workspaces?.requireProfile?.();
  if (wineAdmissionEnabled() && profile?.wineEnrichment?.enabled) {
    return repos.pipelineRuns.withAcceptanceSavepoint(() =>
      acceptWineOperation(
        repos,
        input,
        snapshot,
        profile,
        requestDigest,
        admission,
      ),
    );
  }
  const policy = provider === "fake" ? null : profile?.listingAi;
  if (
    provider !== "fake" &&
    (process.env.LISTING_PAID_OPERATIONS_ENABLED !== "true" ||
      !policy ||
      policy.provider !== provider ||
      Number(policy.runCeilingUsd) <= 0 ||
      Number(policy.budgetCapUsd) <= 0)
  )
    throw new ApiError(
      503,
      "ai_configuration_required",
      "AI needs an approved model and budget configuration. You can save without AI.",
    );
  if (provider === "openrouter" || provider === "opencode-go") {
    const assets = await repos.sourceAssets.getByIds(
      snapshot.sources
        .filter((source) => source.use === "analyse")
        .map((source) => source.assetId),
    );
    if (assets.some((asset) => asset.kind === "application/pdf"))
      throw new ApiError(
        422,
        "provider_capability",
        "This provider cannot analyse PDFs. Mark the PDF as reference-only or enter its facts manually.",
      );
  }
  let ceiling: string | null = null;
  if (policy) {
    try {
      ceiling = paidListingReservation(policy);
    } catch {
      throw new ApiError(
        503,
        "ai_configuration_required",
        "The selected model needs reviewed context and pricing bounds. You can save without AI.",
      );
    }
  }
  if (policy && Number(policy.runCeilingUsd) < Number(ceiling))
    throw new ApiError(
      503,
      "ai_configuration_required",
      "The approved run ceiling does not cover the configured model limits.",
    );
  const revision = await repos.listings.requireById(input.listingId);
  let run;
  try {
    run = await repos.pipelineRuns.acceptOperation({
      listingId: input.listingId,
      inputRevision: snapshot.revision,
      baseVersionId: input.baseVersionId,
      activeVersionSequence: revision.activeVersionSequence,
      requestKey: input.operationKey,
      requestDigest,
      retryOfRunId: input.retryOfRunId,
      execution: {
        input: snapshot,
        aiPolicy: policy,
        provider,
        profile,
        promptVersions: LISTING_PROMPT_VERSIONS,
      },
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code &&
      [
        "idempotency_conflict",
        "processing_already_active",
        "invalid_retry_lineage",
      ].includes(code)
    )
      throw new ApiError(
        409,
        code,
        "Processing could not be accepted. Reload the current operation.",
      );
    throw error;
  }
  if (policy) {
    const reservation = await repos.aiBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedUsd: ceiling!,
      workspaceCapUsd: policy.budgetCapUsd,
      pricingVersion: policy.pricingVersion,
    });
    if (!reservation.accepted) {
      await repos.pipelineRuns.setOperationState(
        run.id,
        "failed",
        "budget_blocked",
      );
      throw new ApiError(
        409,
        "budget_blocked",
        "The workspace AI budget is exhausted. You can save without AI.",
      );
    }
  }
  const payload = {
    schemaVersion: 2 as const,
    workspaceId: input.workspaceId,
    draftId: input.listingId,
    runId: run.id,
    inputRevision: run.inputRevision,
    activeVersionSequence: run.activeVersionSequence,
  };
  const outbox = await repos.dispatchOutbox.record([
    { listingId: input.listingId, dedupeKey: run.idempotencyKey, payload },
  ]);
  await repos.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
    action: "listing.processing_accepted",
    metadata: { runId: run.id, inputRevision: run.inputRevision },
  });
  return {
    processing: {
      runId: run.id,
      jobId: run.idempotencyKey,
      state: run.executionState,
      pollAfterMs: 3000,
    },
    outbox,
    run,
  };
}
