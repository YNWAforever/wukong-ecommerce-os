import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect, it, vi } from "vitest";
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
import {
  createWineExtractionHandler,
  readWineExtractionContext,
} from "./wine-extraction-handler.js";
const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw Error("dedicated fixture required");
const db = createDatabase(url);
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
async function fixture(
  options: {
    duration?: number;
    note?: string;
    operator?: boolean;
    workspaceId?: string;
    mode?: "full" | "research";
    domains?: string[];
  } = {},
) {
  const workspaceId =
    options.workspaceId ?? `wine-complete-cache-${randomUUID()}`;
  const result = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
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
        workingContent: options.operator
          ? { ...emptyWorkingListing(), producer: "Operator Estate" }
          : undefined,
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
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      acceptedAt,
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        input,
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
    activeVersionSequence: 0,
    stage: "extraction",
  };
  return { ...result, workspaceId, job, store: createWineStageStore(db) };
}

import {
  createWineEvidenceAcquisition,
  wineCompleteEvidenceCacheKey,
} from "./wine-evidence-acquisition.js";
import { createWineCompleteEvidenceCache } from "./wine-complete-evidence-cache.js";
async function extracted(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => ({
      bytes,
      readUrl: "https://assets.test/image.png",
    }),
    transport: { fetch: async () => response(output(f.asset.id)) },
  });
  expect(await runWineStage(f.job, { store: f.store, execute })).toMatchObject({
    status: "advanced",
  });
  return f;
}
async function research(
  f: Awaited<ReturnType<typeof fixture>>,
  deep = false,
  count = 1,
  large = false,
  useExtract = false,
) {
  const acquire = createWineEvidenceAcquisition({
    database: db,
    cacheMode: "complete_pool",
    tavilyApiKey: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    queueSecret: "synthetic",
    fetch: async (url, init) => {
      if (String(url).includes("api.tavily.com")) {
        const body = JSON.parse(String(init!.body));
        if (body.urls) {
          expect(
            await db.forWorkspace(f.workspaceId, (r) =>
              r.wineEnrichment.readSearchCall(f.run.id, "extract_1"),
            ),
          ).toMatchObject({ status: "started" });
          return Response.json({
            request_id: "synthetic-extract",
            usage: { credits: 1 },
            results: body.urls.map((url: string) => ({
              url,
              raw_content: "Producer: Fixture Estate\nABV: 12 %",
            })),
            failed_results: [],
          });
        }
        return Response.json({
          request_id: "synthetic",
          usage: { credits: body.search_depth === "advanced" ? 2 : 1 },
          results: Array.from({ length: count }, (_, index) => ({
            url:
              "https://wine.test/" +
              index +
              (body.search_depth === "advanced"
                ? "deep"
                : body.query.includes("technical")
                  ? "second"
                  : "first"),
            title: "Wine",
            content: large
              ? "a".repeat(15000)
              : "Producer: Fixture Estate\nProduct: Reserve Red\nABV: 14 %",
          })),
        });
      }
      const request = JSON.parse(String(init!.body));
      const rows = await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readEvidence(f.run.id),
      );
      const source = rows.find((s) => s.id === request.sourceId)!;
      return Response.json({
        status: "completed",
        result: {
          ...request,
          schemaVersion: 1,
          state: "ready",
          url: source.url,
          capturedAt: new Date().toISOString(),
          title: "Wine",
          text: large
            ? "b".repeat(15000)
            : "Producer: Fixture Estate\nProduct: Reserve Red\nABV: 13 %",
          documentDigest: "sha256:" + "b".repeat(64),
          truncated: false,
          spans: [{ start: 0, end: 10, location: "body:text" }],
          warnings: [],
          extractEligible: useExtract,
        },
      });
    },
  });
  const stage = deep ? "search_deep" : "search_basic";
  expect(
    await runWineStage(
      { ...f.job, stage },
      {
        store: f.store,
        execute: async (c) => {
          const extraction = await readWineExtractionContext(db, c);
          const p = c.run.execution.wineAcquisition as {
            policyVersion: string;
            rulesVersion: string;
            allowedDomains: string[];
          };
          const acquisitionInput = {
            workspaceId: f.workspaceId,
            runId: f.run.id,
            inputRevision: f.run.inputRevision,
            policyDigest: p.policyVersion,
            rulesVersion: p.rulesVersion,
            allowedDomains: p.allowedDomains,
            identity: extraction.context.identity,
            now: extraction.context.now,
            forceRefresh: true,
          };
          const result = await acquire(
            acquisitionInput,
            deep
              ? { stage: "deep" }
              : { stage: "basic", slots: ["basic_1", "basic_2"] },
          );
          expect(result.warnings).toEqual([]);
          if (useExtract) {
            const rows = await db.forWorkspace(f.workspaceId, (r) =>
              r.wineEnrichment.readEvidence(f.run.id),
            );
            const extra = await acquire(acquisitionInput, {
              stage: "extract",
              sourceIds: rows
                .filter((s) => s.contentScope === "snippet")
                .slice(0, 5)
                .map((s) => s.id),
            });
            expect(extra.warnings).toEqual([]);
          }
          const evidence = await db.forWorkspace(f.workspaceId, (r) =>
            r.wineEnrichment.readEvidence(f.run.id),
          );
          return {
            schemaVersion: 1,
            stage,
            state: "succeeded",
            evidence,
            partial: false,
            issues: [],
          };
        },
      },
    ),
  ).toEqual({
    status: "advanced",
    nextStage: deep ? "verification_deep" : "verification",
  });
}
async function verification(
  f: Awaited<ReturnType<typeof fixture>>,
  required: boolean,
  deep = false,
) {
  return runWineStage(
    { ...f.job, stage: deep ? "verification_deep" : "verification" },
    {
      store: f.store,
      execute: async (c) => ({
        schemaVersion: 1,
        stage: deep ? "verification_deep" : "verification",
        state: "succeeded",
        identity: (await readWineExtractionContext(db, c)).context.identity,
        claims: [],
        needsDeepSearch: required,
        deepSearchReasons: required ? ["core_fact_gap"] : [],
        issues: [],
      }),
    },
  );
}
const cache = createWineCompleteEvidenceCache({ database: db });
it("publishes only verified complete actual acquisition and reuses all contrary sources with original provenance", async () => {
  const origin = await extracted();
  await research(origin);
  expect(
    await cache.publish({
      workspaceId: origin.workspaceId,
      runId: origin.run.id,
    }),
  ).toMatchObject({ status: "skipped", code: "cache_incomplete" });
  await verification(origin, false);
  expect(
    await cache.publish({
      workspaceId: origin.workspaceId,
      runId: origin.run.id,
    }),
  ).toMatchObject({ status: "published" });
  const current = await extracted({ workspaceId: origin.workspaceId });
  const claim = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim missing");
  const hit = await cache.reuse(claim.context);
  expect(hit.status).toBe("hit");
  if (hit.status !== "hit") throw Error("missing hit");
  const originals = await db.forWorkspace(origin.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(origin.run.id),
  );
  expect(hit.sources).toEqual(originals.filter((s) => s.kind === "web"));
  expect(hit.sources).toHaveLength(4);
  expect(hit.cacheOrigin.runId).toBe(origin.run.id);
  const currentRows = await db.forWorkspace(current.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(current.run.id),
  );
  expect(currentRows.filter((s) => s.kind === "web")).toEqual(hit.sources);
  expect(
    await db.forWorkspace(current.workspaceId, (r) =>
      r.wineEnrichment.readSearchCall(current.run.id, "basic_1"),
    ),
  ).toBeNull();
});

it("requires actual persisted deep completion when deterministic verification requests it", async () => {
  const f = await extracted();
  await research(f);
  await verification(f, true);
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toEqual({ status: "skipped", code: "cache_incomplete" });
  await research(f, true);
  await verification(f, false, true);
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toMatchObject({ status: "published" });
});
it("does not reuse for accepted research mode, foreign workspace, or after a current call starts", async () => {
  const origin = await extracted();
  await research(origin);
  await verification(origin, false);
  await cache.publish({
    workspaceId: origin.workspaceId,
    runId: origin.run.id,
  });
  const refresh = await extracted({
    workspaceId: origin.workspaceId,
    mode: "research",
  });
  const claim = await refresh.store.claim({
    ...refresh.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim");
  expect(await cache.reuse(claim.context)).toEqual({ status: "miss" });
  const current = await extracted({ workspaceId: origin.workspaceId });
  const second = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (second.status !== "claimed") throw Error("claim");
  expect(
    await cache.reuse({
      ...second.context,
      job: { ...second.context.job, workspaceId: "foreign-cache-workspace" },
    }),
  ).toEqual({ status: "miss" });
  await db.forWorkspace(current.workspaceId, (r) =>
    r.wineEnrichment.beginSearchCall({
      runId: current.run.id,
      slot: "basic_1",
      maximumCredits: 1,
      requestDigest: "a".repeat(64),
    }),
  );
  expect(await cache.reuse(second.context)).toEqual({ status: "miss" });
  expect(
    await db.forWorkspace(current.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(current.run.id),
    ),
  ).toHaveLength(1);
});
it("rejects incomplete source arrays and unknown optional Extract", async () => {
  const f = await extracted();
  await research(f);
  await verification(f, false);
  await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.beginSearchCall({
      runId: f.run.id,
      slot: "extract_1",
      maximumCredits: 1,
      requestDigest: "a".repeat(64),
    }),
  );
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toEqual({ status: "skipped", code: "cache_incomplete" });
  const h = await extracted();
  await research(h);
  await verification(h, false);
  await db.forWorkspace(h.workspaceId, (r) =>
    r.wineEnrichment.saveEvidence(h.run.id, [
      webEvidence({ id: randomUUID(), capturedAt: new Date().toISOString() }),
    ]),
  );
  expect(
    await cache.publish({ workspaceId: h.workspaceId, runId: h.run.id }),
  ).toEqual({ status: "skipped", code: "cache_incomplete" });
});

it("preserves an oversized full pool and skips caching without dropping contrary evidence", async () => {
  const f = await extracted();
  await research(f, false, 5);
  await verification(f, true);
  await research(f, true, 5);
  await verification(f, false, true);
  const before = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  expect(before.filter((s) => s.kind === "web")).toHaveLength(30);
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toEqual({ status: "skipped", code: "cache_pool_oversized" });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  ).toEqual(before);
});

it("skips the 200KB full pool without modifying text or timestamps", async () => {
  const f = await extracted();
  await research(f, false, 5, true);
  await verification(f, false);
  const before = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  expect(before.filter((s) => s.kind === "web")).toHaveLength(20);
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toEqual({ status: "skipped", code: "cache_pool_oversized" });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  ).toEqual(before);
});
it("does not treat a legacy per-invocation snapshot as proof of complete research", async () => {
  const f = await extracted();
  await research(f);
  await verification(f, false);
  const current = await extracted({ workspaceId: f.workspaceId });
  const claim = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim");
  const extraction = await readWineExtractionContext(db, claim.context);
  const p = current.run.execution.wineAcquisition as {
    policyVersion: string;
    rulesVersion: string;
    allowedDomains: string[];
  };
  const input = {
    workspaceId: f.workspaceId,
    runId: current.run.id,
    inputRevision: current.run.inputRevision,
    identity: extraction.context.identity,
    now: extraction.context.now,
    forceRefresh: false,
    policyDigest: p.policyVersion,
    rulesVersion: p.rulesVersion,
    allowedDomains: p.allowedDomains,
  };
  await db.forWorkspace(f.workspaceId, async (r) => {
    const sources = await r.wineEnrichment.readEvidence(f.run.id);
    await r.wineAcquisition.saveCacheSnapshot({
      snapshotId: randomUUID(),
      runId: f.run.id,
      sourceIds: [sources.find((s) => s.kind === "web")!.id],
      identityKey: createHash("sha256")
        .update(
          wineCompleteEvidenceCacheKey(input) +
            listingInputDigest(current.run.execution.wineEnrichment),
        )
        .digest("hex"),
      policyVersion: p.policyVersion,
      rulesVersion: p.rulesVersion,
    });
  });
  // Even a repository-valid partial snapshot under the requested key lacks the complete pool and origin ID.
  expect(await cache.reuse(claim.context)).toEqual({ status: "miss" });
});

it("same policy version with changed accepted domains cannot reuse the origin", async () => {
  const f = await extracted();
  await research(f);
  await verification(f, false);
  await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id });
  const current = await extracted({
    workspaceId: f.workspaceId,
    domains: ["other.test"],
  });
  const claim = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim");
  expect(await cache.reuse(claim.context)).toEqual({ status: "miss" });
});
it("rechecks cancellation immediately before persisting reused evidence", async () => {
  const f = await extracted();
  await research(f);
  await verification(f, false);
  await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id });
  const current = await extracted({ workspaceId: f.workspaceId });
  const claim = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim");
  let reads = 0;
  const wrapped: Pick<typeof db, "forWorkspace"> = {
    forWorkspace: (workspace, callback) =>
      db.forWorkspace(workspace, async (r) =>
        callback({
          ...r,
          wineAcquisition: {
            ...r.wineAcquisition,
            readCacheSnapshot: async (k) => {
              const value = await r.wineAcquisition.readCacheSnapshot(k);
              if (++reads === 2)
                await r.pipelineRuns.setOperationState(
                  current.run.id,
                  "cancelled",
                  "test_cancel",
                );
              return value;
            },
          },
        }),
      ),
  };
  expect(
    await createWineCompleteEvidenceCache({ database: wrapped }).reuse(
      claim.context,
    ),
  ).toEqual({ status: "miss" });
  expect(
    await db.forWorkspace(current.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(current.run.id),
    ),
  ).toHaveLength(1);
});
it("checks original seven-day age at reuse publication without resetting capture times", async () => {
  const f = await extracted();
  await research(f);
  await verification(f, false);
  await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id });
  const current = await extracted({ workspaceId: f.workspaceId });
  const claim = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim");
  const sources = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  const expiry = new Date(
    Math.min(
      ...sources
        .filter((s) => s.kind === "web")
        .map((s) => Date.parse(s.capturedAt)),
    ) +
      7 * 86400000,
  ).toISOString();
  const wrapped: Pick<typeof db, "forWorkspace"> = {
    forWorkspace: (workspace, callback) =>
      db.forWorkspace(workspace, (r) =>
        callback({
          ...r,
          wineAcquisition: {
            ...r.wineAcquisition,
            authorizeAcquisition: async (input) => {
              const authorized =
                await r.wineAcquisition.authorizeAcquisition(input);
              return authorized && { ...authorized, now: expiry };
            },
          },
        }),
      ),
  };
  expect(
    await createWineCompleteEvidenceCache({ database: wrapped }).reuse(
      claim.context,
    ),
  ).toEqual({ status: "miss" });
});

it("includes successful admitted Extract documents in the complete original pool", async () => {
  const f = await extracted();
  await research(f, false, 1, false, true);
  await verification(f, false);
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readSearchCall(f.run.id, "extract_1"),
    ),
  ).toMatchObject({ status: "succeeded", credits: 1 });
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toMatchObject({ status: "published" });
  const current = await extracted({ workspaceId: f.workspaceId });
  const claim = await current.store.claim({
    ...current.job,
    stage: "search_basic",
  });
  if (claim.status !== "claimed") throw Error("claim");
  const hit = await cache.reuse(claim.context);
  expect(hit.status).toBe("hit");
  if (hit.status !== "hit") throw Error("hit");
  expect(
    hit.sources.filter((s) =>
      s.location.startsWith("tavily:extract_1;source:"),
    ),
  ).toHaveLength(2);
});
