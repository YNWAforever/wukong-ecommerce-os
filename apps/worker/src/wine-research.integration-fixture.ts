import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect } from "vitest";
import { createDatabase, listingInputDigest } from "@wukong/db";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  wineIdentity,
  webEvidence,
  emptyWorkingListing,
} from "@wukong/core";
import { WINE_EXECUTION_SNAPSHOT } from "@wukong/ai";
import type { WineListingJob } from "@wukong/jobs";
import { createWineStageStore } from "./wine-enrichment-runtime.js";
import { runWineStage } from "./wine-enrichment-pipeline.js";
import { createWineExtractionHandler } from "./wine-extraction-handler.js";
const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw Error("dedicated fixture required");
export const db = createDatabase(url);
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
afterAll(async () => {
  await db.close();
  await admin.end();
});
const bytes = new TextEncoder().encode("public synthetic bottle image");
const digest = createHash("sha256").update(bytes).digest("hex");
const modelId = "00000000-0000-4000-8000-000000000001";
const transcript = "Fixture Estate\nReserve Red\n2020\n750 ml\n1 bottle\n13 %";
function output(assetId: string) {
  const identity = wineIdentity({
    vintage: { state: "known", year: 2020 },
    volumeMl: 750,
    packQuantity: 1,
    abvPercent: 13,
  });
  return {
    schemaVersion: 1,
    identity,
    evidence: [
      webEvidence({
        id: modelId,
        kind: "photo",
        assetId,
        url: null,
        domain: null,
        contentScope: "label",
        excerpt: transcript,
        identity,
        capturedAt: "2001-01-01T00:00:00Z",
        documentDigest: "model-forged-digest",
        location: "model-pixel-pointer",
        trust: "verified_official",
      }),
    ],
  };
}
function response(value: unknown) {
  return Response.json({
    model: "deepseek-v4.1-flash",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(value) },
      },
    ],
  });
}
export async function fixture(
  options: {
    duration?: number;
    note?: string;
    operator?: boolean;
    workspaceId?: string;
    mode?: "full" | "research";
    domains?: string[];
    profile?: { tone: string; claimPolicy: string[] };
    workingContent?: ReturnType<typeof emptyWorkingListing>;
    baseContent?: import("@wukong/core").ReviewableListing;
  } = {},
) {
  const workspaceId =
    options.workspaceId ?? `wine-complete-cache-${randomUUID()}`;
  const result = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    if (options.baseContent) {
      const audit = { workspaceId, actorId: "test", entityId: listing.id };
      await r.listings.startProcessing(listing.id, audit, r.audit);
      const version = await r.listings.appendVersion(
        listing.id,
        options.baseContent,
        audit,
        r.audit,
      );
      await r.listings.complete(
        listing.id,
        {
          status: "in_review",
          versionId: version.id,
          idempotencyKey: randomUUID(),
        },
        audit,
        r.audit,
      );
    }
    const asset = await r.sourceAssets.create({
      storageKey: `workspaces/${workspaceId}/${listing.id}/image.png`,
      kind: "image/png",
      metadata: { sha256: digest, size: bytes.length },
    });
    const reference = await r.sourceAssets.create({
      storageKey: `workspaces/${workspaceId}/${listing.id}/reference.png`,
      kind: "image/png",
      metadata: { sha256: digest, size: bytes.length },
    });
    const input = await r.listingInputs.initialize(
      {
        listingId: listing.id,
        actorId: "test",
        note: options.note ?? "Merchant note retained",
        workingContent:
          options.workingContent ??
          (options.operator
            ? { ...emptyWorkingListing(), producer: "Operator Estate" }
            : undefined),
        sources: [
          {
            assetId: asset.id,
            role: "front_label",
            use: "analyse",
            hero: true,
          },
          {
            assetId: reference.id,
            role: "other_image",
            use: "reference_only",
            hero: false,
          },
        ],
      },
      { workspaceId, actorId: "test", entityId: listing.id },
      r.audit,
    );
    const acceptedAt = await r.pipelineRuns.acceptanceTimestamp();
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: input.revision,
      baseVersionId: (await r.listings.requireById(listing.id)).activeVersionId,
      activeVersionSequence: (await r.listings.requireById(listing.id))
        .activeVersionSequence,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      acceptedAt,
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        input,
        ...(options.profile ? { profile: options.profile } : {}),
        wineInputDigest: input.inputDigest,
        wineSourceDigest: listingInputDigest(input.sources),
        wineMode: options.mode ?? "full",
        wineBudget: createWineBudgetSnapshot(options.mode ?? "full"),
        wineGo: WINE_EXECUTION_SNAPSHOT,
        wineEnrichment: wineEnrichmentPolicySchema.parse({
          enabled: true,
          allowedDomains: options.domains ?? ["wine.test"],
          tavilyCreditCap: 5,
        }),
        wineAcquisition: {
          schemaVersion: 1,
          policyVersion: "wine-enrichment@1",
          rulesVersion: "wine-grounding@1",
          allowedDomains: options.domains ?? ["wine.test"],
          deadlineAt: new Date(
            Date.parse(acceptedAt) + (options.duration ?? 900000),
          ).toISOString(),
        },
      },
    });
    await r.aiBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedUsd: "3.194880",
      workspaceCapUsd: "10",
      pricingVersion: "wine-enrichment@1",
    });
    await r.searchBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedCredits: 5,
      workspaceCapCredits: 100,
      policyVersion: "wine-enrichment@1",
    });
    return { asset, reference, run };
  });
  const job: WineListingJob = {
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    workspaceId,
    draftId: result.run.listingId,
    runId: result.run.id,
    inputRevision: result.run.inputRevision,
    activeVersionSequence: result.run.activeVersionSequence,
    stage: "extraction",
  };
  return { ...result, workspaceId, job, store: createWineStageStore(db) };
}

export async function extracted(
  options: Parameters<typeof fixture>[0] = {},
  transform: (value: ReturnType<typeof output>) => ReturnType<typeof output> = (
    v,
  ) => v,
) {
  const f = await fixture(options);
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => ({
      bytes,
      readUrl: "https://assets.test/image.png",
    }),
    transport: { fetch: async () => response(transform(output(f.asset.id))) },
  });
  expect(await runWineStage(f.job, { store: f.store, execute })).toMatchObject({
    status: "advanced",
  });
  return f;
}
