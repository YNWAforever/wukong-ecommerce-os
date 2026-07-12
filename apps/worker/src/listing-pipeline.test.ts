// @ts-nocheck
import { describe, expect, it } from "vitest";
import type { CanonicalListing, FieldEvidence, ListingFacts, WorkspaceProfile } from "@wukong/core";
import type { AIUsage } from "@wukong/ai";
import { PipelineTimeoutError, runListingPipeline, type PipelineDependencies } from "./listing-pipeline.js";

const workspaceId = "ws_opak";
const draftId = "draft_1";
const usage: AIUsage = { inputTokens: 12, outputTokens: 34, estimatedCostUsd: 0.012345, latencyMs: 321, model: "test-model", promptVersion: "test-v1" };
const facts: ListingFacts = { sku: "OPAK-001", producer: "Demo Estate", productType: "wine", country: "Germany", region: "Mosel", vintage: 2024, grapeVarieties: ["Riesling"], volumeMl: 750, abvPercent: 12.5, packQuantity: 1, priceHkd: 288, stockQuantity: 4, criticScores: [], awards: [] };
const evidence: FieldEvidence[] = [{ field: "priceHkd", sourceAssetId: "asset_1", page: null, excerpt: "HK$288", confidence: 1 }];
const listing: CanonicalListing = { ...facts, sku: "OPAK-001", producer: "Demo Estate", productType: "wine", country: "Germany", volumeMl: 750, abvPercent: 12.5, priceHkd: 288, title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" }, description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" }, seo: { title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" }, description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" } }, tags: ["Riesling"], imageAssetIds: ["asset_1"] };
type Event = { action: string; metadata: Record<string, unknown> };
const profile = (): WorkspaceProfile => ({ name: "Opak Cellar", currency: "HKD", locales: ["en", "zh-Hant"], tone: "clear and restrained", claimPolicy: ["No invented claims"], requiredFields: ["sku", "priceHkd"] });

function createDependencies(options: { missingFields?: string[]; extractionError?: Error } = {}): PipelineDependencies & { events: Event[]; aiRuns: Array<Record<string, unknown>>; versions: Array<Record<string, unknown>>; assetIds: string[] } {
  const events: Event[] = []; const aiRuns: Array<Record<string, unknown>> = []; const versions: Array<Record<string, unknown>> = []; const assetIds = ["asset_1"]; let status = "received" as const; const completed = new Map<string, { status: "in_review" | "needs_info"; versionId: string }>();
  return {
    events, aiRuns, versions, assetIds,
    async withWorkspace(id, work) { expect(id).toBe(workspaceId); return work({
      listings: {
        async requireById(id) { expect(id).toBe(draftId); return { id, status, activeVersionSequence: 0, note: "SKU OPAK-001" }; },
        async startProcessing(id, context, audit) { expect(id).toBe(draftId); expect(context.actorId).toBe("worker:listing-pipeline"); await audit.write({ ...context, action: "listing.transition", metadata: { toStatus: "processing" } }); status = "processing"; },
        async appendVersion(id, content, context, audit) { expect(id).toBe(draftId); const version = { id: `version_${versions.length + 1}`, sequence: versions.length + 1, content }; versions.push(version); await audit.write({ ...context, action: "listing.version_appended", metadata: { versionId: version.id } }); return version; },
        async replaceEvidence() {}, async replaceFlags() {},
        async complete(id, result, context, audit) { expect(id).toBe(draftId); status = result.status; completed.set(result.idempotencyKey, { status: result.status, versionId: result.versionId }); await audit.write({ ...context, action: result.status === "in_review" ? "listing.submitted_for_review" : "listing.info_requested", metadata: { versionId: result.versionId } }); },
        async fail(id, errorCode, context, audit) { expect(id).toBe(draftId); status = "failed"; await audit.write({ ...context, action: "listing.pipeline_failed", metadata: { errorCode } }); },
      },
      sourceAssets: { async listForListing(id) { expect(id).toBe(draftId); return assetIds.map((id) => ({ id, mimeType: "image/png", storageKey: `ws/${workspaceId}/sources/${id}/label.png` })); } },
      workspaces: { async requireProfile() { return profile(); } },
      pipelineRuns: { async getCompleted(key) { return completed.get(key) ?? null; }, async recordStep() {} },
      aiRuns: { async append(run) { aiRuns.push(run); } },
      audit: { async write(event) { events.push({ action: event.action, metadata: event.metadata }); } },
    }); },
    assetInputs: async (assets) => assets.map((asset) => ({ id: asset.id, mimeType: asset.mimeType, readUrl: `memory://${asset.id}` })),
    ai: { async extract() { if (options.extractionError) throw options.extractionError; return { facts, evidence, missingFields: options.missingFields ?? [], usage }; }, async generate() { return { listing, usage }; } },
  } as unknown as PipelineDependencies & { events: Event[]; aiRuns: Array<Record<string, unknown>>; versions: Array<Record<string, unknown>>; assetIds: string[] };
}

describe("runListingPipeline", () => {
  it("moves an evidence-backed draft into review and logs AI usage", async () => { const deps = createDependencies(); const result = await runListingPipeline({ workspaceId, draftId, activeVersionSequence: 0 }, deps); expect(result.status).toBe("in_review"); expect(deps.events).toContainEqual(expect.objectContaining({ action: "listing.submitted_for_review" })); expect(deps.aiRuns).toHaveLength(2); expect(deps.aiRuns).toEqual(expect.arrayContaining([expect.objectContaining({ task: "extract", ...usage }), expect.objectContaining({ task: "generate", ...usage })])); expect(deps.versions).toHaveLength(1); });
  it("moves a draft with missing protected fields to needs_info before invalid listing generation", async () => { const deps = createDependencies({ missingFields: ["priceHkd"] }); const result = await runListingPipeline({ workspaceId, draftId, activeVersionSequence: 0 }, deps); expect(result.status).toBe("needs_info"); expect(deps.events).toContainEqual(expect.objectContaining({ action: "listing.info_requested" })); expect(deps.aiRuns).toHaveLength(1); expect(deps.versions).toHaveLength(0); });
  it("records a sanitized timeout failure without losing assets", async () => { const deps = createDependencies({ extractionError: new PipelineTimeoutError("provider timed out") }); await expect(runListingPipeline({ workspaceId, draftId, activeVersionSequence: 0 }, deps)).rejects.toThrow(PipelineTimeoutError); expect(deps.assetIds).toEqual(["asset_1"]); expect(deps.events).toContainEqual({ action: "listing.pipeline_failed", metadata: { errorCode: "provider_timeout" } }); expect(deps.versions).toHaveLength(0); });
  it("returns an already completed revision without duplicating AI runs, versions, or audit events", async () => { const deps = createDependencies(); const input = { workspaceId, draftId, activeVersionSequence: 0 }; const first = await runListingPipeline(input, deps); const snapshot = { aiRuns: deps.aiRuns.length, versions: deps.versions.length, events: deps.events.length }; const second = await runListingPipeline(input, deps); expect(second).toEqual(first); expect({ aiRuns: deps.aiRuns.length, versions: deps.versions.length, events: deps.events.length }).toEqual(snapshot); });
});
