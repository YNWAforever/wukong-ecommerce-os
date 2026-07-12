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
import type { AIUsage, ExtractionAsset, ListingAIProvider } from "@wukong/ai";

export type ListingPipelineInput = {
  workspaceId: string;
  draftId: string;
  activeVersionSequence: number;
};

export type PipelineResult = {
  status: "in_review" | "needs_info";
  versionId: string;
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
    ): Promise<{ id: string; sequence: number }>;
    replaceEvidence(versionId: string, evidence: FieldEvidence[]): Promise<void>;
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
  sourceAssets: { listForListing(id: string): Promise<PipelineAsset[]> };
  workspaces: { requireProfile(): Promise<WorkspaceProfile> };
  pipelineRuns: {
    getCompleted(idempotencyKey: string): Promise<PipelineResult | null>;
    recordStep(input: { idempotencyKey: string; step: "started" | "extracted" | "generated" }): Promise<void>;
  };
  aiRuns: {
    append(run: {
      task: "extract" | "generate";
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
};

export type PipelineErrorCode = "provider_timeout" | "provider_failure" | "pipeline_failure";

export class PipelineTimeoutError extends Error {
  constructor(message = "listing provider timed out") {
    super(message);
    this.name = "PipelineTimeoutError";
  }
}

const WORKER_ACTOR_ID = "worker:listing-pipeline";

export function listingPipelineJobId(input: ListingPipelineInput): string {
  return `listing:${input.workspaceId}:${input.draftId}:${input.activeVersionSequence}`;
}

function auditContext(input: ListingPipelineInput): AuditContext {
  return {
    workspaceId: input.workspaceId,
    actorId: WORKER_ACTOR_ID,
    entityId: input.draftId,
  };
}

function aiRunFrom(
  task: "extract" | "generate",
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

function flattenLocalizedContent(listing: CanonicalListing): Record<string, string> {
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
  return error instanceof Error && /timeout/i.test(error.message)
    ? "provider_timeout"
    : error instanceof Error && /provider|openai|model/i.test(error.message)
      ? "provider_failure"
      : "pipeline_failure";
}

async function failPipeline(
  input: ListingPipelineInput,
  deps: PipelineDependencies,
  error: unknown,
): Promise<void> {
  const errorCode = classifyError(error);
  await deps.withWorkspace(input.workspaceId, async (repos) => {
    await repos.listings.fail(input.draftId, errorCode, auditContext(input), repos.audit);
  });
}

export async function runListingPipeline(
  input: ListingPipelineInput,
  deps: PipelineDependencies,
): Promise<PipelineResult> {
  const idempotencyKey = listingPipelineJobId(input);
  const complete = await deps.withWorkspace(input.workspaceId, (repos) =>
    repos.pipelineRuns.getCompleted(idempotencyKey),
  );
  if (complete) return complete;

  let draft: PipelineListing;
  try {
    draft = await deps.withWorkspace(input.workspaceId, async (repos) => {
      const listing = await repos.listings.requireById(input.draftId);
      if (listing.activeVersionSequence !== input.activeVersionSequence) {
        throw new Error("listing revision no longer matches queued job");
      }
      if (listing.status === "received" || listing.status === "needs_info" || listing.status === "failed") {
        await repos.listings.startProcessing(input.draftId, auditContext(input), repos.audit);
      }
      await repos.pipelineRuns.recordStep({ idempotencyKey, step: "started" });
      return listing;
    });

    const source = await deps.withWorkspace(input.workspaceId, async (repos) => ({
      assets: await repos.sourceAssets.listForListing(input.draftId),
      profile: await repos.workspaces.requireProfile(),
    }));
    const extractionAssets = await deps.assetInputs(source.assets);
    const extraction = await deps.ai.extract({ assets: extractionAssets, note: draft.note });

    await deps.withWorkspace(input.workspaceId, async (repos) => {
      await repos.aiRuns.append(aiRunFrom("extract", extraction.usage, input));
      await repos.pipelineRuns.recordStep({ idempotencyKey, step: "extracted" });
    });

    if (extraction.missingFields.length > 0) {
      const result: PipelineResult = { status: "needs_info", versionId: "" };
      await deps.withWorkspace(input.workspaceId, async (repos) => {
        await repos.listings.complete(
          input.draftId,
          { ...result, idempotencyKey },
          auditContext(input),
          repos.audit,
        );
      });
      return result;
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

    return deps.withWorkspace(input.workspaceId, async (repos) => {
      const version = await repos.listings.appendVersion(
        input.draftId,
        generation.listing,
        auditContext(input),
        repos.audit,
      );
      await repos.listings.replaceEvidence(version.id, extraction.evidence);
      await repos.listings.replaceFlags(version.id, flags);
      await repos.aiRuns.append(aiRunFrom("generate", generation.usage, input));
      await repos.pipelineRuns.recordStep({ idempotencyKey, step: "generated" });
      const result: PipelineResult = { status: "in_review", versionId: version.id };
      await repos.listings.complete(
        input.draftId,
        { ...result, idempotencyKey },
        auditContext(input),
        repos.audit,
      );
      return result;
    });
  } catch (error) {
    await failPipeline(input, deps, error);
    throw error;
  }
}
