import type { ExtractionInput, ExtractionResult, GenerationInput, GenerationResult, AIUsage, ListingAIProvider } from "@wukong/ai";
import type { AuditContext, AuditWriter, CanonicalListing, FieldEvidence, ListingFacts, WorkspaceProfile } from "@wukong/core";
import type { PipelineDependencies, PipelineRepositories } from "./listing-pipeline.js";

export const workspaceId = "ws_opak";
export const draftId = "b9df5d9e-8214-4d76-9a8d-38f802d03d11";
export const usage: AIUsage = { inputTokens: 12, outputTokens: 34, estimatedCostUsd: 0.012345, latencyMs: 321, model: "test-model", promptVersion: "test-v1" };
export const facts: ListingFacts = { sku: "OPAK-001", producer: "Demo Estate", productType: "wine", country: "Germany", region: "Mosel", vintage: 2024, grapeVarieties: ["Riesling"], volumeMl: 750, abvPercent: 12.5, packQuantity: 1, priceHkd: 288, stockQuantity: 4, criticScores: [], awards: [] };
export const evidence: FieldEvidence[] = [{ field: "priceHkd", sourceAssetId: "asset_1", page: null, excerpt: "HK$288", confidence: 1 }];
export const listing: CanonicalListing = { ...facts, sku: facts.sku!, producer: facts.producer!, productType: facts.productType!, country: facts.country!, volumeMl: facts.volumeMl!, abvPercent: facts.abvPercent!, priceHkd: facts.priceHkd!, title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" }, description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" }, seo: { title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" }, description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" } }, tags: ["Riesling"], imageAssetIds: ["asset_1"] };
export const profile: WorkspaceProfile = { name: "Opak Cellar", currency: "HKD", locales: ["en", "zh-Hant"], tone: "clear and restrained", claimPolicy: ["No invented claims"], requiredFields: ["sku", "priceHkd"] };
export type HarnessState = { status: "received" | "processing" | "needs_info" | "in_review" | "failed"; steps: Map<string, { state: "running" | "completed"; output: unknown; leaseToken: string }>; aiRuns: Array<{ task: string; idempotencyKey: string }>; versions: string[]; audits: string[]; failure?: string; completed?: { status: "in_review" | "needs_info"; versionId: string | null } };
export type HarnessOptions = { missingFields?: string[]; extractError?: Error; generateError?: Error; generateProvider?: (input: GenerationInput) => Promise<GenerationResult>; sourceError?: Error; completeError?: Error; completeErrorOnce?: Error; generationUnavailable?: boolean; nullLeaseTokenForCompleted?: boolean };

export function makeProvider(options: HarnessOptions = {}): ListingAIProvider {
  return {
    async extract(_input: ExtractionInput): Promise<ExtractionResult> { if (options.extractError) throw options.extractError; return { facts: options.missingFields?.includes("priceHkd") ? { ...facts, priceHkd: null } : facts, evidence: options.missingFields ? [] : evidence, missingFields: options.missingFields ?? [], usage }; },
    async generate(input: GenerationInput): Promise<GenerationResult> { if (options.generateError) throw options.generateError; return options.generateProvider?.(input) ?? { listing, usage }; },
  };
}

export function makeHarness(options: HarnessOptions = {}): { state: HarnessState; deps: PipelineDependencies & { state: HarnessState } } {
  const state: HarnessState = { status: "received", steps: new Map(), aiRuns: [], versions: [], audits: [] };
  let completeErrorConsumed = false;
  const audit: AuditWriter = { async write(event) { state.audits.push(event.action); } };
  const repos: PipelineRepositories = {
    listings: {
      async requireById() { return { id: draftId, status: state.status, activeVersionSequence: 0, note: "SKU OPAK-001" }; },
      async startProcessing(_id: string, _context: AuditContext, _audit: AuditWriter) { state.status = "processing"; },
      async appendVersion(_id: string, _content: CanonicalListing, _context: AuditContext, _audit: AuditWriter, _key?: string) { const id = state.versions[0] ?? `version_${state.versions.length + 1}`; if (!state.versions.includes(id)) state.versions.push(id); return { id, sequence: 1 }; },
      async replaceEvidence() {},
      async replaceFlags() {},
      async complete(_id: string, result, _context: AuditContext, _audit: AuditWriter) { if (options.completeError || (options.completeErrorOnce && !completeErrorConsumed)) { completeErrorConsumed = true; throw options.completeError ?? options.completeErrorOnce; } state.status = result.status; state.completed = { status: result.status, versionId: result.versionId }; state.audits.push(result.status === "in_review" ? "listing.submitted_for_review" : "listing.info_requested"); },
      async fail(_id: string, code, _context: AuditContext, _audit: AuditWriter) { state.status = "failed"; state.failure = code; state.audits.push("listing.pipeline_failed"); },
    },
    sourceAssets: { async listForListing() { if (options.sourceError) throw options.sourceError; return [{ id: "asset_1", mimeType: "image/png", storageKey: `ws/${workspaceId}/sources/asset_1/label.png` }]; } },
    workspaces: { async requireProfile() { return profile; } },
    pipelineRuns: {
      async getCompleted() { return state.completed ?? null; },
      async claimStep(input) {
        if (input.step === "generated" && options.generationUnavailable) return { claimed: false, completed: false, output: null, leaseToken: null };
        const current = state.steps.get(input.step);
        if (!current) {
          const leaseToken = "lease-" + input.step + "-1";
          state.steps.set(input.step, { state: "running", output: null, leaseToken });
          return { claimed: true, completed: false, output: null, leaseToken };
        }
        if (current.state === "completed") return { claimed: false, completed: true, output: current.output, leaseToken: options.nullLeaseTokenForCompleted ? null : current.leaseToken };
        return { claimed: false, completed: false, output: null, leaseToken: null };
      },
      async recordStep(input) {
        const current = state.steps.get(input.step);
        if (!current || (input.leaseToken ? current.leaseToken !== input.leaseToken : current.state !== "completed")) throw new Error("pipeline step lease lost");
        state.steps.set(input.step, { state: "completed", output: input.output ?? null, leaseToken: current.leaseToken });
      },
      async complete(input) {
        const current = state.steps.get(input.step);
        if (!current || (input.leaseToken ? current.leaseToken !== input.leaseToken : current.state !== "completed")) throw new Error("pipeline step lease lost");
      },
      async fail(input) { state.failure = input.errorCode; return true; },
      async releaseStep(input) {
        const current = state.steps.get(input.step);
        if (current?.state === "running" && current.leaseToken === input.leaseToken) state.steps.delete(input.step);
      },
    },
    aiRuns: { async append(run) { if (!state.aiRuns.some((existing) => existing.task === run.task && existing.idempotencyKey === run.idempotencyKey)) state.aiRuns.push({ task: run.task, idempotencyKey: run.idempotencyKey }); } },
    audit,
  };
  const deps: PipelineDependencies & { state: HarnessState } = { state, async withWorkspace<T>(id: string, work: (repositories: PipelineRepositories) => Promise<T>) { if (id !== workspaceId) throw new Error("wrong workspace"); return work(repos); }, async assetInputs(assets) { return assets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, readUrl: `https://assets.test/${asset.id}` })); }, ai: makeProvider(options) };
  return { state, deps };
}
