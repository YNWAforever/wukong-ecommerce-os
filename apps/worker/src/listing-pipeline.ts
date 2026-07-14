import type { AuditContext, AuditWriter, CanonicalListing, ComplianceFlag, FieldEvidence, ListingStatus, WorkspaceProfile } from "@wukong/core";
import { scanCompliance } from "@wukong/core";
import type { AIUsage, ExtractionAsset, ExtractionResult, ListingAIProvider } from "@wukong/ai";
import type { PipelineStepName } from "@wukong/db";

export type ListingPipelineInput = { workspaceId: string; draftId: string; activeVersionSequence: number };
export type PipelineResult = { status: "in_review" | "needs_info"; versionId: string | null };
export type PipelineAttemptOptions = { attempt?: number; maxAttempts?: number };
export type PipelineAsset = { id: string; mimeType: string; storageKey: string };
export type PipelineListing = { id: string; status: ListingStatus; activeVersionSequence: number; note: string | null };
export type PipelineAuditWriter = AuditWriter;

export type PipelineRepositories = {
  listings: {
    requireById(id: string): Promise<PipelineListing>;
    startProcessing(id: string, context: AuditContext, audit: PipelineAuditWriter): Promise<void>;
    appendVersion(id: string, content: CanonicalListing, context: AuditContext, audit: PipelineAuditWriter, pipelineIdempotencyKey?: string): Promise<{ id: string; sequence: number }>;
    replaceEvidence(versionId: string, evidence: FieldEvidence[]): Promise<void>;
    replaceFlags(versionId: string, flags: ComplianceFlag[]): Promise<void>;
    complete(id: string, result: PipelineResult & { idempotencyKey: string }, context: AuditContext, audit: PipelineAuditWriter): Promise<void>;
    fail(id: string, errorCode: PipelineErrorCode, context: AuditContext, audit: PipelineAuditWriter): Promise<void>;
  };
  sourceAssets: { listForListing(id: string): Promise<PipelineAsset[]> };
  workspaces: { requireProfile(): Promise<WorkspaceProfile> };
  pipelineRuns: {
    getCompleted(idempotencyKey: string): Promise<PipelineResult | null>;
    claimStep(input: { idempotencyKey: string; listingId: string; activeVersionSequence: number; step: PipelineStepName }): Promise<{ claimed: boolean; completed: boolean; output: unknown; leaseToken: string | null }>;
    recordStep(input: { idempotencyKey: string; listingId: string; activeVersionSequence: number; step: PipelineStepName; leaseToken: string; output?: unknown }): Promise<void>;
    complete(input: { idempotencyKey: string; listingId: string; activeVersionSequence: number; step: PipelineStepName; leaseToken?: string; status: PipelineResult["status"]; versionId: string | null }): Promise<void>;
    fail(input: { idempotencyKey: string; listingId: string; activeVersionSequence: number; step: PipelineStepName; errorCode: PipelineErrorCode; leaseToken?: string }): Promise<boolean>;
    releaseStep(input: { idempotencyKey: string; step: PipelineStepName; leaseToken: string }): Promise<void>;
  };
  aiRuns: { append(run: { task: "extract" | "generate"; draftId: string; idempotencyKey: string; outcome: "succeeded"; inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMs: number; model: string; promptVersion: string }): Promise<void> };
  audit: PipelineAuditWriter;
};

export type PipelineDependencies = {
  withWorkspace<T>(workspaceId: string, work: (repositories: PipelineRepositories) => Promise<T>): Promise<T>;
  assetInputs(assets: PipelineAsset[]): Promise<ExtractionAsset[]>;
  ai: ListingAIProvider;
};
export type PipelineErrorCode = "provider_timeout" | "provider_failure" | "pipeline_failure";
export class PipelineTimeoutError extends Error { constructor(message = "listing provider timed out") { super(message); this.name = "PipelineTimeoutError"; } }
const WORKER_ACTOR_ID = "worker:listing-pipeline";

export function listingPipelineJobId(input: ListingPipelineInput): string {
  return "listing:" + input.workspaceId + ":" + input.draftId + ":" + input.activeVersionSequence;
}
function context(input: ListingPipelineInput): AuditContext { return { workspaceId: input.workspaceId, actorId: WORKER_ACTOR_ID, entityId: input.draftId }; }
function aiRunFrom(task: "extract" | "generate", usage: AIUsage, input: ListingPipelineInput) { return { task, draftId: input.draftId, idempotencyKey: listingPipelineJobId(input), outcome: "succeeded" as const, ...usage }; }
function flattenLocalizedContent(listing: CanonicalListing): Record<string, string> { return { titleEn: listing.title.en, titleZhHant: listing.title["zh-Hant"], descriptionEn: listing.description.en, descriptionZhHant: listing.description["zh-Hant"], seoTitleEn: listing.seo.title.en, seoTitleZhHant: listing.seo.title["zh-Hant"], seoDescriptionEn: listing.seo.description.en, seoDescriptionZhHant: listing.seo.description["zh-Hant"] }; }
function classifyError(error: unknown): PipelineErrorCode { if (error instanceof PipelineTimeoutError) return "provider_timeout"; const message = error instanceof Error ? error.message : ""; if (/timeout|timed out|abort|etimedout/i.test(message)) return "provider_timeout"; if (/provider|openai|model/i.test(message)) return "provider_failure"; return "pipeline_failure"; }
function asExtraction(value: unknown): ExtractionResult | null { if (!value || typeof value !== "object") return null; const candidate = value as Partial<ExtractionResult>; return candidate.facts && Array.isArray(candidate.evidence) && Array.isArray(candidate.missingFields) && candidate.usage ? candidate as ExtractionResult : null; }
function asGenerated(value: unknown): { versionId: string } | null { if (!value || typeof value !== "object" || typeof (value as { versionId?: unknown }).versionId !== "string") return null; return value as { versionId: string }; }

export async function runListingPipeline(input: ListingPipelineInput, deps: PipelineDependencies, options: PipelineAttemptOptions = {}): Promise<PipelineResult> {
  const idempotencyKey = listingPipelineJobId(input);
  const attempt = Math.max(1, options.attempt ?? 1);
  const maxAttempts = Math.max(attempt, options.maxAttempts ?? 3);
  const completed = await deps.withWorkspace(input.workspaceId, (repos) => repos.pipelineRuns.getCompleted(idempotencyKey));
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
      if (listing.activeVersionSequence !== input.activeVersionSequence) throw new Error("listing revision no longer matches queued job");
      if (listing.status === "received" || listing.status === "needs_info" || listing.status === "failed") await repos.listings.startProcessing(input.draftId, context(input), repos.audit);
      const claim = await repos.pipelineRuns.claimStep({ idempotencyKey, listingId: input.draftId, activeVersionSequence: input.activeVersionSequence, step: "started" });
      if (claim.claimed) {
        if (!claim.leaseToken) throw new Error("started step lease missing");
        claimedStep = "started";
        claimedLeaseToken = claim.leaseToken;
        await repos.pipelineRuns.recordStep({ idempotencyKey, listingId: input.draftId, activeVersionSequence: input.activeVersionSequence, step: "started", leaseToken: claim.leaseToken });
        claimedStep = null;
        claimedLeaseToken = null;
      }
      return listing;
    });

    const source = await deps.withWorkspace(input.workspaceId, async (repos) => ({
      assets: await repos.sourceAssets.listForListing(input.draftId),
      profile: await repos.workspaces.requireProfile(),
    }));

    const extractionClaim = await deps.withWorkspace(input.workspaceId, (repos) => repos.pipelineRuns.claimStep({
      idempotencyKey,
      listingId: input.draftId,
      activeVersionSequence: input.activeVersionSequence,
      step: "extracted",
    }));
    activeStep = "extracted";
    const extractionLeaseToken = extractionClaim.leaseToken;
    const cachedExtraction = asExtraction(extractionClaim.output);
    if (extractionClaim.claimed) {
      if (!extractionLeaseToken) throw new Error("extraction step lease missing");
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
      throw new Error("extraction step is already running");
    } else {
      extraction = await deps.ai.extract({ assets: await deps.assetInputs(source.assets), note: draft.note });
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.aiRuns.append(aiRunFrom("extract", extraction.usage, input));
        await repos.pipelineRuns.recordStep({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: "extracted",
          leaseToken: extractionLeaseToken!,
          output: extraction,
        });
        completionStep = "extracted";
        completionLeaseToken = extractionLeaseToken;
        claimedStep = null;
        claimedLeaseToken = null;
      });
    }

    if (extraction.missingFields.length > 0) {
      if (!completionStep) throw new Error("pipeline completion step missing");
      const result: PipelineResult = { status: "needs_info", versionId: null };
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.listings.complete(input.draftId, { ...result, idempotencyKey }, context(input), repos.audit);
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

    const generationClaim = await deps.withWorkspace(input.workspaceId, (repos) => repos.pipelineRuns.claimStep({
      idempotencyKey,
      listingId: input.draftId,
      activeVersionSequence: input.activeVersionSequence,
      step: "generated",
    }));
    activeStep = "generated";
    const generationLeaseToken = generationClaim.leaseToken;
    const cachedGenerated = asGenerated(generationClaim.output);
    if (generationClaim.claimed) {
      if (!generationLeaseToken) throw new Error("generation step lease missing");
      claimedStep = "generated";
      claimedLeaseToken = generationLeaseToken;
    }
    if (generationClaim.completed && cachedGenerated) {
      completionStep = "generated";
      completionLeaseToken = generationLeaseToken;
      const result: PipelineResult = { status: "in_review", versionId: cachedGenerated.versionId };
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.listings.complete(input.draftId, { ...result, idempotencyKey }, context(input), repos.audit);
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
      throw new Error("generation step is already running");
    }

    const generation = await deps.ai.generate({
      facts: extraction.facts,
      evidence: extraction.evidence,
      profile: source.profile,
      imageAssetIds: source.assets.filter((asset) => asset.mimeType.startsWith("image/")).map((asset) => asset.id),
    });
    const flags = scanCompliance(flattenLocalizedContent(generation.listing));
    const result = await deps.withWorkspace(input.workspaceId, async (repos) => {
      const version = await repos.listings.appendVersion(input.draftId, generation.listing, context(input), repos.audit, idempotencyKey);
      await repos.listings.replaceEvidence(version.id, extraction.evidence);
      await repos.listings.replaceFlags(version.id, flags);
      await repos.aiRuns.append(aiRunFrom("generate", generation.usage, input));
      await repos.pipelineRuns.recordStep({
        idempotencyKey,
        listingId: input.draftId,
        activeVersionSequence: input.activeVersionSequence,
        step: "generated",
        leaseToken: generationLeaseToken,
        output: { versionId: version.id },
      });
      completionStep = "generated";
      completionLeaseToken = generationLeaseToken;
      claimedStep = null;
      claimedLeaseToken = null;
      const completedResult: PipelineResult = { status: "in_review", versionId: version.id };
      await repos.listings.complete(input.draftId, { ...completedResult, idempotencyKey }, context(input), repos.audit);
      await repos.pipelineRuns.complete({
        idempotencyKey,
        listingId: input.draftId,
        activeVersionSequence: input.activeVersionSequence,
        step: completionStep,
        leaseToken: completionLeaseToken ?? undefined,
        status: completedResult.status,
        versionId: completedResult.versionId,
      });
      return completedResult;
    });
    return result;
  } catch (error) {
    if (stepUnavailable) throw error;
    await deps.withWorkspace(input.workspaceId, async (repos) => {
      const leaseToken = claimedLeaseToken ?? completionLeaseToken ?? undefined;
      const leaseStep = claimedStep ?? completionStep ?? activeStep;
      if (attempt >= maxAttempts) {
        const errorCode = classifyError(error);
        const failed = await repos.pipelineRuns.fail({
          idempotencyKey,
          listingId: input.draftId,
          activeVersionSequence: input.activeVersionSequence,
          step: leaseStep,
          errorCode,
          leaseToken,
        });
        if (failed) await repos.listings.fail(input.draftId, errorCode, context(input), repos.audit);
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
