import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  type WorkspaceProfile,
  type WineMode,
} from "@wukong/core";
import {
  wineAcquisitionPolicySchema,
  wineListingJobSchema,
  wineStageMessageKey,
} from "@wukong/jobs";
import {
  listingInputDigest,
  type Database,
  type WorkspaceRepositories,
} from "@wukong/db";
import {
  preflightWineCapability,
  requireWineCapabilityReceipt,
  type WineCapabilityReceipt,
} from "./wine-capability-client";
import type {
  AcceptListingOperationInput,
  AcceptedListingOperation,
} from "./listing-operation-service";
import { ApiError } from "./route-support";
export type WineAdmissionContext = {
  wineCapability?: WineCapabilityReceipt;
  winePreflightError?: ApiError;
};
export const wineAdmissionEnabled = () =>
  process.env.WINE_ENRICHMENT_ENABLED === "true";
function capabilityError(error: unknown): ApiError {
  const code =
    error instanceof Error &&
    /^wine_capability_(configuration|unavailable|required|stale)$/.test(
      error.message,
    )
      ? error.message
      : "wine_capability_unavailable";
  return new ApiError(
    503,
    code,
    "Wine processing requires a compatible ready Worker. You can save without AI.",
  );
}
/** The profile transaction completes BEFORE the bounded network preflight. */
export async function prepareWineAdmission(
  database: Pick<Database, "forWorkspace">,
  workspaceId: string,
  mode: WineMode = "full",
  preflight = preflightWineCapability,
): Promise<WineAdmissionContext> {
  if (!wineAdmissionEnabled()) return {};
  const profile = await database.forWorkspace(workspaceId, (r) =>
    r.workspaces.requireProfile(),
  );
  if (!profile.wineEnrichment?.enabled || mode === "copy" || mode === "section")
    return {};
  try {
    return { wineCapability: await preflight() };
  } catch (error) {
    return { winePreflightError: capabilityError(error) };
  }
}
function checked(context: WineAdmissionContext) {
  if (context.winePreflightError) throw context.winePreflightError;
  try {
    return requireWineCapabilityReceipt(context.wineCapability!);
  } catch (error) {
    throw capabilityError(error);
  }
}
/** Caller owns listing then workspace locks and the acceptance savepoint. No network. */
export async function acceptWineOperation(
  repos: WorkspaceRepositories,
  input: AcceptListingOperationInput,
  snapshot: NonNullable<
    Awaited<ReturnType<WorkspaceRepositories["listingInputs"]["getCurrent"]>>
  >,
  profile: WorkspaceProfile,
  requestDigest: string,
  admission: WineAdmissionContext,
): Promise<AcceptedListingOperation> {
  const mode = input.wineMode ?? "full";
  if (mode === "copy" || mode === "section")
    throw new ApiError(
      409,
      "wine_dependencies_required",
      "Copy and section processing require adopted wine evidence support before they can be accepted.",
    );
  const policy = wineEnrichmentPolicySchema.parse(profile.wineEnrichment);
  if (!policy.enabled || !policy.allowedDomains.length)
    throw new ApiError(
      503,
      "wine_policy_required",
      "Wine research requires an approved domain policy.",
    );
  const budget = createWineBudgetSnapshot(mode);
  const assets = await repos.sourceAssets.getByIds(
    snapshot.sources.filter((s) => s.use === "analyse").map((s) => s.assetId),
  );
  if (assets.some((a) => a.kind === "application/pdf"))
    throw new ApiError(
      422,
      "wine_provider_capability",
      "Mark PDFs as reference-only or enter their facts manually.",
    );
  const listing = await repos.listings.requireById(input.listingId);
  const acceptedAt = await repos.pipelineRuns.acceptanceTimestamp();
  const capability = checked(admission);
  const acquisition = wineAcquisitionPolicySchema.parse({
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    rulesVersion: policy.rulesVersion,
    allowedDomains: policy.allowedDomains,
    deadlineAt: new Date(Date.parse(acceptedAt) + 900000).toISOString(),
  });
  let run;
  try {
    run = await repos.pipelineRuns.acceptOperation({
      listingId: input.listingId,
      inputRevision: snapshot.revision,
      baseVersionId: input.baseVersionId,
      activeVersionSequence: listing.activeVersionSequence,
      requestKey: input.operationKey,
      requestDigest,
      retryOfRunId: input.retryOfRunId,
      acceptedAt,
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        input: snapshot,
        profile,
        wineInputDigest: snapshot.inputDigest,
        wineSourceDigest: listingInputDigest(snapshot.sources),
        wineMode: mode,
        wineBudget: budget,
        wineGo: capability.capability.execution,
        wineEnrichment: policy,
        wineAcquisition: acquisition,
        wineCapability: capability,
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
        "Reload the current operation before processing.",
      );
    throw error;
  }
  const go = await repos.aiBudgetReservations.reserve({
    pipelineRunId: run.id,
    reservedUsd: budget.goReservedUsd,
    workspaceCapUsd: policy.budgetCapUsd,
    pricingVersion: policy.policyVersion,
  });
  if (!go.accepted)
    throw new ApiError(
      409,
      "wine_go_budget_blocked",
      "The workspace Go budget is exhausted. You can save without AI.",
    );
  const search = await repos.searchBudgetReservations.reserve({
    pipelineRunId: run.id,
    reservedCredits: budget.tavilyCredits,
    workspaceCapCredits: policy.tavilyCreditCap,
    policyVersion: policy.policyVersion,
  });
  if (!search.accepted)
    throw new ApiError(
      409,
      "wine_search_budget_blocked",
      "The workspace Tavily credit budget is exhausted. You can save without AI.",
    );
  checked(admission);
  const payload = wineListingJobSchema.parse({
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    workspaceId: input.workspaceId,
    draftId: input.listingId,
    runId: run.id,
    inputRevision: run.inputRevision,
    activeVersionSequence: run.activeVersionSequence,
    stage: "extraction",
  });
  const outbox = await repos.dispatchOutbox.record([
    {
      listingId: input.listingId,
      dedupeKey: wineStageMessageKey(run.id, "extraction"),
      payload,
    },
  ]);
  await repos.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    entityId: input.listingId,
    action: "listing.processing_accepted",
    metadata: {
      runId: run.id,
      inputRevision: run.inputRevision,
      flowVersion: "wine-enrichment-v1",
      wineMode: mode,
    },
  });
  return {
    flowVersion: "wine-enrichment-v1",
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
export function recoverableWineAdmission(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    new Set([
      "wine_capability_configuration",
      "wine_capability_unavailable",
      "wine_capability_required",
      "wine_capability_stale",
      "wine_dependencies_required",
      "wine_policy_required",
      "wine_provider_capability",
      "wine_go_budget_blocked",
      "wine_search_budget_blocked",
    ]).has(error.code)
  );
}
