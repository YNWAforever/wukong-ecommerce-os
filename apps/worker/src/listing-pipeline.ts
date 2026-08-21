import type {
  AuditContext,
  AuditWriter,
  CanonicalListing,
  ComplianceFlag,
  FieldEvidence,
  ListingStatus,
  WorkspaceProfile,
} from "@wukong/core";
import { scanCompliance } from "@wukong/core";
import {
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  type AIUsage,
  ExtractionAsset,
  ExtractionResult,
  ListingAIProvider,
  ProductShotProvider,
} from "@wukong/ai";
import type { PipelineStepName } from "@wukong/db";
import type { ListingJob } from "@wukong/jobs";

export type ListingPipelineInput = ListingJob;

function listingPipelineJobId(input: ListingPipelineInput): string {
  return `listing:${input.workspaceId}:${input.draftId}:${input.activeVersionSequence}`;
}
export type PipelineResult = {
  status: "in_review" | "needs_info";
  versionId: string | null;
};
export type PipelineAttemptOptions = {
  attempt?: number;
  maxAttempts?: number;
  isTerminalError?: (error: unknown) => boolean;
};
export type PipelineAsset = {
  id: string;
  mimeType: string;
  storageKey: string;
};
export type PipelineListing = {
  id: string;
  status: ListingStatus;
  activeVersionSequence: number;
  note: string | null;
};
export type PipelineAuditWriter = AuditWriter;

export type PipelineRepositories = {
  listings: {
    requireById(id: string): Promise<PipelineListing>;
    startProcessing(
      id: string,
      context: AuditContext,
      audit: PipelineAuditWriter,
    ): Promise<void>;
    appendVersion(
      id: string,
      content: CanonicalListing,
      context: AuditContext,
      audit: PipelineAuditWriter,
      pipelineIdempotencyKey?: string,
    ): Promise<{ id: string; sequence: number }>;
    replaceEvidence(
      versionId: string,
      evidence: FieldEvidence[],
    ): Promise<void>;
    replaceFlags(versionId: string, flags: ComplianceFlag[]): Promise<void>;
    complete(
      id: string,
      result: PipelineResult & { idempotencyKey: string },
      context: AuditContext,
      audit: PipelineAuditWriter,
    ): Promise<void>;
    fail(
      id: string,
      errorCode: PipelineErrorCode,
      context: AuditContext,
      audit: PipelineAuditWriter,
    ): Promise<void>;
  };
  sourceAssets: {
    listForListing(id: string): Promise<PipelineAsset[]>;
    create?(input: {
      storageKey: string;
      kind: string;
      metadata: Record<string, unknown>;
    }): Promise<{ id: string }>;
    attachToListing?(listingId: string, assetIds: string[]): Promise<void>;
  };
  workspaces: { requireProfile(): Promise<WorkspaceProfile> };
  pipelineRuns: {
    getCompleted(idempotencyKey: string): Promise<PipelineResult | null>;
    claimStep(input: {
      idempotencyKey: string;
      listingId: string;
      activeVersionSequence: number;
      step: PipelineStepName;
    }): Promise<{
      claimed: boolean;
      completed: boolean;
      output: unknown;
      leaseToken: string | null;
      leaseExpiresAt?: Date | null;
    }>;
    recordStep(input: {
      idempotencyKey: string;
      listingId: string;
      activeVersionSequence: number;
      step: PipelineStepName;
      leaseToken: string;
      output?: unknown;
    }): Promise<void>;
    complete(input: {
      idempotencyKey: string;
      listingId: string;
      activeVersionSequence: number;
      step: PipelineStepName;
      leaseToken?: string;
      status: PipelineResult["status"];
      versionId: string | null;
    }): Promise<void>;
    fail(input: {
      idempotencyKey: string;
      listingId: string;
      activeVersionSequence: number;
      step: PipelineStepName;
      errorCode: PipelineErrorCode;
      leaseToken?: string;
    }): Promise<boolean>;
    releaseStep(input: {
      idempotencyKey: string;
      step: PipelineStepName;
      leaseToken: string;
    }): Promise<void>;
  };
  aiRuns: {
    append(run: {
      task: "extract" | "generate" | "product_shot";
      draftId: string;
      idempotencyKey: string;
      outcome: "succeeded";
      inputTokens: number;
      outputTokens: number;
      estimatedCostUsd: number;
      latencyMs: number;
      model: string;
      promptVersion: string;
    }): Promise<void>;
  };
  audit: PipelineAuditWriter;
};

export type PipelineDependencies = {
  withWorkspace<T>(
    workspaceId: string,
    work: (repositories: PipelineRepositories) => Promise<T>,
  ): Promise<T>;
  assetInputs(assets: PipelineAsset[]): Promise<ExtractionAsset[]>;
  ai: ListingAIProvider;
  productShot?: ProductShotProvider;
  assetStore?: {
    writeObject(
      workspaceId: string,
      key: string,
      body: Uint8Array,
      mimeType: string,
    ): Promise<{ size: number; mimeType: string }>;
    createAssetKey(input: {
      workspaceId: string;
      fileName: string;
      mimeType: string;
      size: number;
    }): string;
  };
};
export type PipelineErrorCode =
  "provider_timeout" | "provider_failure" | "pipeline_failure";
export class PipelineTimeoutError extends Error {
  constructor(message = "listing provider timed out") {
    super(message);
    this.name = "PipelineTimeoutError";
  }
}

/**
 * Another delivery still holds this step's lease. Carries when that lease goes
 * stale so the consumer can schedule its retry for after that instant: a
 * redelivery any sooner is guaranteed to fail the same way, and with only a
 * handful of deliveries available it would burn the budget for nothing.
 */
export class PipelineStepBusyError extends Error {
  constructor(
    message: string,
    readonly leaseExpiresAt: Date | null,
  ) {
    super(message);
    this.name = "PipelineStepBusyError";
  }

  retryAfterSeconds(now: number, fallbackSeconds: number): number {
    if (!this.leaseExpiresAt) return fallbackSeconds;
    const remainingMs = this.leaseExpiresAt.getTime() - now;
    if (!Number.isFinite(remainingMs)) return fallbackSeconds;
    return Math.max(1, Math.ceil(remainingMs / 1_000));
  }
}
const WORKER_ACTOR_ID = "worker:listing-pipeline";

function context(input: ListingPipelineInput): AuditContext {
  return {
    workspaceId: input.workspaceId,
    actorId: WORKER_ACTOR_ID,
    entityId: input.draftId,
  };
}
function aiRunFrom(
  task: "extract" | "generate" | "product_shot",
  usage: AIUsage,
  input: ListingPipelineInput,
) {
  return {
    task,
    draftId: input.draftId,
    idempotencyKey: listingPipelineJobId(input),
    outcome: "succeeded" as const,
    ...usage,
  };
}
function flattenLocalizedContent(
  listing: CanonicalListing,
): Record<string, string> {
  return {
    titleEn: listing.title.en,
    titleZhHant: listing.title["zh-Hant"],
    descriptionEn: listing.description.en,
    descriptionZhHant: listing.description["zh-Hant"],
    seoTitleEn: listing.seo.title.en,
    seoTitleZhHant: listing.seo.title["zh-Hant"],
    seoDescriptionEn: listing.seo.description.en,
    seoDescriptionZhHant: listing.seo.description["zh-Hant"],
  };
}
function classifyError(error: unknown): PipelineErrorCode {
  if (error instanceof PipelineTimeoutError) return "provider_timeout";
  const message = error instanceof Error ? error.message : "";
  if (
    error instanceof ProviderApiError &&
    /timeout|timed out|abort|etimedout/i.test(message)
  ) {
    return "provider_timeout";
  }
  if (
    error instanceof ProviderApiError ||
    error instanceof ProviderOutputError ||
    error instanceof ProviderRefusalError
  ) {
    return "provider_failure";
  }
  if (/timeout|timed out|abort|etimedout/i.test(message)) {
    return "provider_timeout";
  }
  if (/provider|openai|model/i.test(message)) return "provider_failure";
  return "pipeline_failure";
}
function asExtraction(value: unknown): ExtractionResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExtractionResult>;
  return candidate.facts &&
    Array.isArray(candidate.evidence) &&
    Array.isArray(candidate.missingFields) &&
    candidate.usage
    ? (candidate as ExtractionResult)
    : null;
}
function asGenerated(value: unknown): { versionId: string } | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { versionId?: unknown }).versionId !== "string"
  )
    return null;
  return value as { versionId: string };
}

export async function runListingPipeline(
  input: ListingPipelineInput,
  deps: PipelineDependencies,
  options: PipelineAttemptOptions = {},
): Promise<PipelineResult> {
  const idempotencyKey = listingPipelineJobId(input);
  const attempt = Math.max(1, options.attempt ?? 1);
  const maxAttempts = Math.max(attempt, options.maxAttempts ?? 3);
  const completed = await deps.withWorkspace(input.workspaceId, (repos) =>
    repos.pipelineRuns.getCompleted(idempotencyKey),
  );
  if (completed) return completed;

  let activeStep: PipelineStepName = "started";
  let claimedStep: PipelineStepName | null = null;
  let claimedLeaseToken: string | null = null;
  let completionStep: PipelineStepName | null = null;
  let completionLeaseToken: string | null = null;
  let stepUnavailable = false;

  try {
    const draft = await deps.withWorkspace(input.workspaceId, async (repos) => {
      const listing = await repos.listings.requireById(input.draftId);
      if (listing.activeVersionSequence !== input.activeVersionSequence)
        throw new Error("listing revision no longer matches queued job");
      if (
        listing.status === "received" ||
        listing.status === "needs_info" ||
        listing.status === "failed"
      )
        await repos.listings.startProcessing(
          input.draftId,
          context(input),
          repos.audit,
        );
      const claim = await repos.pipelineRuns.claimStep({
        idempotencyKey,
        listingId: input.draftId,
        activeVersionSequence: input.activeVersionSequence,
        step: "started",
      });
      if (claim.claimed) {
        if (!claim.leaseToken) throw new Error("started step lease missing");
        claimedStep = "started";
        claimedLeaseToken = claim.leaseToken;
        await repos.pipelineRuns.recordStep({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "started",
          leaseToken: claim.leaseToken,
        });
        claimedStep = null;
        claimedLeaseToken = null;
      }
      return listing;
    });

    const source = await deps.withWorkspace(
      input.workspaceId,
      async (repos) => ({
        assets: await repos.sourceAssets.listForListing(input.draftId),
        profile: await repos.workspaces.requireProfile(),
      }),
    );

    const extractionClaim = await deps.withWorkspace(
      input.workspaceId,
      (repos) =>
        repos.pipelineRuns.claimStep({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "extracted",
        }),
    );
    activeStep = "extracted";
    const extractionLeaseToken = extractionClaim.leaseToken;
    const cachedExtraction = asExtraction(extractionClaim.output);
    if (extractionClaim.claimed) {
      if (!extractionLeaseToken)
        throw new Error("extraction step lease missing");
      claimedStep = "extracted";
      claimedLeaseToken = extractionLeaseToken;
    }
    let extraction: ExtractionResult;
    if (extractionClaim.completed && cachedExtraction) {
      extraction = cachedExtraction;
      completionStep = "extracted";
      completionLeaseToken = extractionLeaseToken;
    } else if (!extractionClaim.claimed) {
      stepUnavailable = true;
      throw new PipelineStepBusyError(
        "extraction step is already running",
        extractionClaim.leaseExpiresAt ?? null,
      );
    } else {
      extraction = await deps.ai.extract({
        assets: await deps.assetInputs(source.assets),
        note: draft.note,
      });
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.aiRuns.append(
          aiRunFrom("extract", extraction.usage, input),
        );
        await repos.pipelineRuns.recordStep({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "extracted",
          leaseToken: extractionLeaseToken!,
          output: extraction,
        });
      });
      // Only hand the lease over to the completion bookkeeping once the
      // transaction has actually committed. Assigning inside the callback would
      // survive a rollback that returned the step row to `running`, and the
      // catch block would then skip releaseStep on a lease we still hold.
      completionStep = "extracted";
      completionLeaseToken = extractionLeaseToken;
      claimedStep = null;
      claimedLeaseToken = null;
    }

    if (extraction.missingFields.length > 0) {
      if (!completionStep) throw new Error("pipeline completion step missing");
      const result: PipelineResult = { status: "needs_info", versionId: null };
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.listings.complete(
          input.draftId,
          { ...result, idempotencyKey },
          context(input),
          repos.audit,
        );
        await repos.pipelineRuns.complete({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: completionStep!,
          leaseToken: completionLeaseToken ?? undefined,
          status: result.status,
          versionId: result.versionId,
        });
      });
      return result;
    }

    const generationClaim = await deps.withWorkspace(
      input.workspaceId,
      (repos) =>
        repos.pipelineRuns.claimStep({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "generated",
        }),
    );
    activeStep = "generated";
    const generationLeaseToken = generationClaim.leaseToken;
    const cachedGenerated = asGenerated(generationClaim.output);
    if (generationClaim.claimed) {
      if (!generationLeaseToken)
        throw new Error("generation step lease missing");
      claimedStep = "generated";
      claimedLeaseToken = generationLeaseToken;
    }
    if (generationClaim.completed && cachedGenerated) {
      completionStep = "generated";
      completionLeaseToken = generationLeaseToken;
      const result: PipelineResult = {
        status: "in_review",
        versionId: cachedGenerated.versionId,
      };
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.listings.complete(
          input.draftId,
          { ...result, idempotencyKey },
          context(input),
          repos.audit,
        );
        await repos.pipelineRuns.complete({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: completionStep!,
          leaseToken: completionLeaseToken ?? undefined,
          status: result.status,
          versionId: result.versionId,
        });
      });
      return result;
    }
    if (!generationClaim.claimed || !generationLeaseToken) {
      stepUnavailable = true;
      throw new PipelineStepBusyError(
        "generation step is already running",
        generationClaim.leaseExpiresAt ?? null,
      );
    }

    const generation = await deps.ai.generate({
      facts: extraction.facts,
      evidence: extraction.evidence,
      profile: source.profile,
      imageAssetIds: source.assets
        .filter((asset) => asset.mimeType.startsWith("image/"))
        .map((asset) => asset.id),
    });
    const flags = scanCompliance(flattenLocalizedContent(generation.listing));
    // A ProductShotProvider/AssetStore pair is optional, and neither is wired in
    // wherever PipelineDependencies is bound to real implementations for
    // production today — this whole feature stays a no-op until a future task
    // deliberately supplies both. When it is, the two external calls (an AI image
    // call and an S3 write) run out here, before deps.withWorkspace, matching how
    // deps.ai.generate above is itself called outside a transaction: the worker's
    // Postgres pool is capped at 5 connections, so a transaction must never sit
    // open across a slow external HTTP round trip.
    let productShotOutcome: { storageKey: string; usage: AIUsage } | null =
      null;
    if (deps.productShot && deps.assetStore) {
      const shot = await deps.productShot.generateProductShot({
        assets: await deps.assetInputs(source.assets),
      });
      const storageKey = deps.assetStore.createAssetKey({
        workspaceId: input.workspaceId,
        fileName: "product-shot-cutout.png",
        mimeType: "image/png",
        size: shot.cutoutPng.byteLength,
      });
      await deps.assetStore.writeObject(
        input.workspaceId,
        storageKey,
        shot.cutoutPng,
        "image/png",
      );
      productShotOutcome = { storageKey, usage: shot.usage };
    }
    const result = await deps.withWorkspace(
      input.workspaceId,
      async (repos) => {
        const version = await repos.listings.appendVersion(
          input.draftId,
          generation.listing,
          context(input),
          repos.audit,
          idempotencyKey,
        );
        await repos.listings.replaceEvidence(version.id, extraction.evidence);
        await repos.listings.replaceFlags(version.id, flags);
        await repos.aiRuns.append(
          aiRunFrom("generate", generation.usage, input),
        );
        if (productShotOutcome && repos.sourceAssets.create) {
          const created = await repos.sourceAssets.create({
            storageKey: productShotOutcome.storageKey,
            kind: "image/png",
            metadata: { role: "product_shot_cutout", listingId: input.draftId },
          });
          await repos.sourceAssets.attachToListing?.(input.draftId, [
            created.id,
          ]);
          await repos.aiRuns.append(
            aiRunFrom("product_shot", productShotOutcome.usage, input),
          );
        }
        await repos.pipelineRuns.recordStep({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "generated",
          leaseToken: generationLeaseToken,
          output: { versionId: version.id },
        });
        const completedResult: PipelineResult = {
          status: "in_review",
          versionId: version.id,
        };
        await repos.listings.complete(
          input.draftId,
          { ...completedResult, idempotencyKey },
          context(input),
          repos.audit,
        );
        await repos.pipelineRuns.complete({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "generated",
          leaseToken: generationLeaseToken,
          status: completedResult.status,
          versionId: completedResult.versionId,
        });
        return completedResult;
      },
    );
    // No lease bookkeeping here on purpose. The transaction above both records
    // and completes the generation step, so on success there is nothing left to
    // release, and on failure the catch block must still see claimedStep ===
    // "generated" so it can release the lease this worker owns.
    return result;
  } catch (error) {
    if (stepUnavailable) throw error;
    await deps.withWorkspace(input.workspaceId, async (repos) => {
      const leaseToken = claimedLeaseToken ?? completionLeaseToken ?? undefined;
      const leaseStep = claimedStep ?? completionStep ?? activeStep;
      if (options.isTerminalError?.(error) === true || attempt >= maxAttempts) {
        const errorCode = classifyError(error);
        const failed = await repos.pipelineRuns.fail({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: leaseStep,
          errorCode,
          leaseToken,
        });
        if (failed)
          await repos.listings.fail(
            input.draftId,
            errorCode,
            context(input),
            repos.audit,
          );
      } else if (claimedStep === activeStep && claimedLeaseToken) {
        await repos.pipelineRuns.releaseStep({
          idempotencyKey,
          step: activeStep,
          leaseToken: claimedLeaseToken,
        });
      }
    });
    throw error;
  }
}
