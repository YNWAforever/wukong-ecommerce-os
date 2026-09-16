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
  options: { duration?: number; note?: string; operator?: boolean } = {},
) {
  const workspaceId = `wine-extraction-${randomUUID()}`;
  const result = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const asset = await r.sourceAssets.create({
      storageKey: `workspaces/${workspaceId}/image.png`,
      kind: "image/png",
      metadata: { sha256: digest, size: bytes.length },
    });
    const reference = await r.sourceAssets.create({
      storageKey: `workspaces/${workspaceId}/reference.png`,
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
        wineMode: "full",
        wineBudget: createWineBudgetSnapshot("full"),
        wineGo: WINE_EXECUTION_SNAPSHOT,
        wineEnrichment: wineEnrichmentPolicySchema.parse({
          enabled: true,
          allowedDomains: ["wine.test"],
          tavilyCreditCap: 5,
        }),
        wineAcquisition: {
          schemaVersion: 1,
          policyVersion: "wine-enrichment@1",
          rulesVersion: "wine-grounding@1",
          allowedDomains: ["wine.test"],
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
      workspaceCapCredits: 5,
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
it("extracts only admitted images with committed real Go usage and server-created provenance", async () => {
  const f = await fixture();
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    const rows =
      await admin`select * from ai_runs where pipeline_run_id=${f.run.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("started");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("deepseek-v4.1-flash");
    expect(JSON.stringify(body)).toContain(f.asset.id);
    expect(JSON.stringify(body)).not.toContain(f.reference.id);
    expect(JSON.stringify(body)).toContain("Merchant note retained");
    return response(output(f.asset.id));
  };
  const resolveImage = vi.fn(async () => ({
    bytes,
    readUrl: "https://assets.test/accepted.png",
  }));
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage,
    transport: { fetch: fetcher },
  });
  expect(await runWineStage(f.job, { store: f.store, execute })).toMatchObject({
    status: "advanced",
    nextStage: "search_basic",
  });
  expect(calls).toBe(1);
  expect(resolveImage).toHaveBeenCalledTimes(1);
  const rows = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).not.toBe(modelId);
  expect(rows[0]!.documentDigest).toBe(
    "sha256:" + createHash("sha256").update(transcript).digest("hex"),
  );
  expect(rows[0]!.capturedAt).not.toBe("2001-01-01T00:00:00Z");
  expect(rows[0]!.location).toContain(f.run.id);
  expect(rows[0]!.trust).not.toBe("verified_official");
  const stage = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.run.id, "extraction"),
  );
  expect(stage!.output).toMatchObject({
    result: { identity: { status: "matched" }, evidence: rows, issues: [] },
  });
  expect(await runWineStage(f.job, { store: f.store, execute })).toMatchObject({
    status: "duplicate",
  });
  expect(calls).toBe(1);
});

async function runFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  custom?: {
    fetch?: typeof fetch;
    resolveImage?: Parameters<
      typeof createWineExtractionHandler
    >[0]["resolveImage"];
  },
) {
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage:
      custom?.resolveImage ??
      (async () => ({ bytes, readUrl: "https://assets.test/accepted.png" })),
    transport: {
      fetch: custom?.fetch ?? (async () => response(output(f.asset.id))),
    },
  });
  return {
    execute,
    result: await runWineStage(f.job, { store: f.store, execute }),
  };
}
it("fences changed image bytes before provider admission", async () => {
  const f = await fixture(),
    fetcher = vi.fn(async () => response(output(f.asset.id)));
  const { result } = await runFixture(f, {
    fetch: fetcher,
    resolveImage: async () => ({
      bytes: new Uint8Array([1]),
      readUrl: "https://assets.test/accepted.png",
    }),
  });
  expect(result).toMatchObject({
    status: "blocked",
    code: "extraction_asset_digest_invalid",
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await admin`select * from ai_runs where pipeline_run_id=${f.run.id}`,
  ).toHaveLength(0);
});
it("fences cancellation during image resolution and publishes no evidence", async () => {
  const f = await fixture(),
    fetcher = vi.fn(async () => response(output(f.asset.id)));
  const { result } = await runFixture(f, {
    fetch: fetcher,
    resolveImage: async () => {
      await db.forWorkspace(f.workspaceId, (r) =>
        r.pipelineRuns.setOperationState(f.run.id, "cancelled"),
      );
      return { bytes, readUrl: "https://assets.test/accepted.png" };
    },
  });
  expect(result).toMatchObject({ status: "stopped" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  ).toEqual([]);
});
it("fences cancellation after paid response but keeps measured Go usage", async () => {
  const f = await fixture();
  await runFixture(f, {
    fetch: async () => {
      await db.forWorkspace(f.workspaceId, (r) =>
        r.pipelineRuns.setOperationState(f.run.id, "cancelled"),
      );
      return response(output(f.asset.id));
    },
  });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  ).toEqual([]);
  const calls =
    await admin`select status,estimated_cost_usd from ai_runs where pipeline_run_id=${f.run.id}`;
  expect(calls).toHaveLength(1);
  expect(calls[0].status).toBe("succeeded");
  expect(Number(calls[0].estimated_cost_usd)).toBeGreaterThan(0);
});
it("rejects a forged accepted note and a foreign workspace without resolving images", async () => {
  const f = await fixture(),
    claim = await f.store.claim(f.job);
  if (claim.status !== "claimed") throw Error("fixture");
  const resolveImage = vi.fn(async () => ({
    bytes,
    readUrl: "https://assets.test/accepted.png",
  }));
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage,
    transport: { fetch: async () => response(output(f.asset.id)) },
  });
  const forged = structuredClone(claim.context);
  (forged.run.execution.input as { note: string }).note = "forged";
  expect(await execute(forged)).toMatchObject({
    state: "blocked",
    code: "extraction_context_invalid",
  });
  expect(
    await execute({
      ...claim.context,
      job: { ...f.job, workspaceId: "foreign" },
    }),
  ).toMatchObject({ state: "blocked" });
  expect(resolveImage).not.toHaveBeenCalled();
});
it("sanitizes partial source OCR before immutable insertion and retains contrary observations", async () => {
  const f = await fixture(),
    raw = output(f.asset.id),
    secondId = randomUUID();
  const contrary = wineIdentity({
    vintage: { state: "known", year: 2020 },
    volumeMl: 750,
    packQuantity: 1,
    abvPercent: 14,
    cuvee: "invented",
  });
  for (const obs of Object.values(contrary.observations))
    if (obs) obs.evidenceIds = [secondId];
  raw.evidence.push({
    ...raw.evidence[0]!,
    id: secondId,
    excerpt: transcript.replace("13 %", "14 %"),
    identity: contrary,
  });
  const { result } = await runFixture(f, { fetch: async () => response(raw) });
  expect(result).toMatchObject({ status: "advanced" });
  const sources = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  const source = sources.find((s) => s.identity?.abvPercent === 14)!;
  expect(source.identity?.cuvee).toBeNull();
  expect(source.identity?.observations.abvPercent?.evidenceIds).toEqual([
    source.id,
  ]);
  const stage = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.run.id, "extraction"),
  );
  expect(stage!.output).toMatchObject({
    result: {
      identity: { status: "needs_confirmation" },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "observation_binding_invalid",
          blocking: true,
        }),
      ]),
    },
  });
});
it("reconstructs frozen extraction binding, original clock and repository-backed sources", async () => {
  const f = await fixture();
  await runFixture(f);
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const result = await readWineExtractionContext(db, claim.context);
  const checkpoint = (
    claim.context.dependencies[0]!.output as { result: { observedAt: string } }
  ).result;
  expect(result.context.now).toBe(checkpoint.observedAt);
  expect(result.context.binding).toEqual({
    workspaceId: f.workspaceId,
    operationId: f.run.id,
    inputRevision: f.run.inputRevision,
  });
  expect(result.context.sources).toEqual(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  );
  expect(result.context.trustedObservationSourceIds).toEqual([
    result.context.sources[0]!.id,
  ]);
  expect(Object.isFrozen(result.context.sources[0])).toBe(true);
  const forged = structuredClone(claim.context);
  forged.dependencies[0]!.runId = randomUUID();
  await expect(readWineExtractionContext(db, forged)).rejects.toThrow();
});
it("retains an exact frozen observation clock for empty model evidence", async () => {
  const f = await fixture();
  const { result } = await runFixture(f, {
    fetch: async () =>
      response({
        schemaVersion: 1,
        identity: wineIdentity({ producer: null, productName: null }),
        evidence: [],
      }),
  });
  expect(result).toMatchObject({ status: "advanced" });
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const loaded = await readWineExtractionContext(db, claim.context);
  expect(loaded.context.sources).toEqual([]);
  expect(loaded.context.now).toBe(
    (
      claim.context.dependencies[0]!.output as {
        result: { observedAt: string };
      }
    ).result.observedAt,
  );
});
it("keeps merchant source provenance tied to accepted note and preserves operator ownership", async () => {
  const f = await fixture({ note: transcript, operator: true }),
    raw = output(f.asset.id);
  raw.evidence[0] = {
    ...raw.evidence[0]!,
    kind: "merchant",
    assetId: null,
    contentScope: "note",
    independenceKey: "invented-independent-site",
  };
  await runFixture(f, { fetch: async () => response(raw) });
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const loaded = await readWineExtractionContext(db, claim.context);
  expect(loaded.context.lockedFields).toContain("producer");
  expect(loaded.context.sources[0]).toMatchObject({
    kind: "merchant",
    assetId: null,
    url: null,
    domain: null,
    independenceKey: `merchant:${f.run.id}`,
    excerpt: transcript,
  });
  expect(
    (
      await db.forWorkspace(f.workspaceId, (r) =>
        r.listingInputs.getCurrent(f.run.listingId),
      )
    )?.workingContent.producer,
  ).toBe("Operator Estate");
});
it("starts no Go request after deadline crosses during storage resolution", async () => {
  const f = await fixture({ duration: 500 }),
    fetcher = vi.fn(async () => response(output(f.asset.id)));
  await runFixture(f, {
    fetch: fetcher,
    resolveImage: async () => {
      await new Promise((r) => setTimeout(r, 550));
      return { bytes, readUrl: "https://assets.test/accepted.png" };
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    await admin`select * from ai_runs where pipeline_run_id=${f.run.id}`,
  ).toHaveLength(0);
});
it("publishes no evidence if deadline crosses during the registry read", async () => {
  const f = await fixture({ duration: 700 });
  const delayed = {
    forWorkspace: ((workspaceId: string, callback: any) =>
      db.forWorkspace(workspaceId, (r) =>
        callback({
          ...r,
          wineEnrichment: {
            ...r.wineEnrichment,
            readAuthorities: async () => {
              await new Promise((resolve) => setTimeout(resolve, 750));
              return r.wineEnrichment.readAuthorities();
            },
          },
        }),
      )) as typeof db.forWorkspace,
  };
  const execute = createWineExtractionHandler({
    database: delayed,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => ({
      bytes,
      readUrl: "https://assets.test/accepted.png",
    }),
    transport: { fetch: async () => response(output(f.asset.id)) },
  });
  await runWineStage(f.job, { store: f.store, execute });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  ).toEqual([]);
});
it("reads authenticated workspace registry into the frozen extraction context", async () => {
  const f = await fixture(),
    reviewer = randomUUID();
  await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values(${f.workspaceId},${reviewer},'reviewer')`;
  const designation = {
    schemaVersion: 1 as const,
    domain: "wine.test",
    subject: { kind: "reliable_source" as const, name: "wine.test" },
    proofUrl: "https://wine.test/about",
    proofDigest: "a".repeat(64),
    verifiedAt: new Date(Date.now() - 10000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    revokedAt: null,
    verifierId: reviewer,
  };
  await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.recordReviewedAuthority(reviewer, designation),
  );
  await runFixture(f);
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const loaded = await readWineExtractionContext(db, claim.context);
  expect(loaded.context.authorities).toEqual([designation]);
  expect(loaded.context.reliableSourceIds).toEqual([]);
});
it("reconstructs mixed-validity contrary OCR with the original blocking diagnostics", async () => {
  const f = await fixture(),
    raw = output(f.asset.id),
    secondId = randomUUID();
  const contrary = wineIdentity({
    vintage: { state: "known", year: 2020 },
    volumeMl: 750,
    packQuantity: 1,
    abvPercent: 14,
    cuvee: "invented",
  });
  for (const obs of Object.values(contrary.observations))
    if (obs) obs.evidenceIds = [secondId];
  raw.evidence.push({
    ...raw.evidence[0]!,
    id: secondId,
    excerpt: transcript.replace("13 %", "14 %"),
    identity: contrary,
    independenceKey: "model-independent",
  });
  await runFixture(f, { fetch: async () => response(raw) });
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const loaded = await readWineExtractionContext(db, claim.context);
  expect(loaded.issues).toEqual(
    (claim.context.dependencies[0]!.output as { result: { issues: unknown[] } })
      .result.issues,
  );
  expect(loaded.context.sources.map((s) => s.independenceKey)).toEqual([
    `asset:${digest}`,
    `asset:${digest}`,
  ]);
  expect(loaded.context.supports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: "abvPercent", value: 14 }),
    ]),
  );
});
it("fences input revision changes after the provider response", async () => {
  const f = await fixture();
  await runFixture(f, {
    fetch: async () => {
      await db.forWorkspace(f.workspaceId, (r) =>
        r.listingInputs.save(
          {
            listingId: f.run.listingId,
            actorId: "test",
            expectedInputRevision: f.run.inputRevision,
            baseVersionId: null,
            operationKey: randomUUID(),
            requestDigest: randomUUID(),
            note: "revised",
            changes: [],
          },
          {
            workspaceId: f.workspaceId,
            actorId: "test",
            entityId: f.run.listingId,
          },
          r.audit,
        ),
      );
      return response(output(f.asset.id));
    },
  });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  ).toEqual([]);
  expect(
    (
      await admin`select status from ai_runs where pipeline_run_id=${f.run.id}`
    )[0].status,
  ).toBe("succeeded");
});
it("rejects a forged run input revision before asset resolution", async () => {
  const f = await fixture(),
    claim = await f.store.claim(f.job);
  if (claim.status !== "claimed") throw Error("fixture");
  const resolveImage = vi.fn(async () => ({
    bytes,
    readUrl: "https://assets.test/accepted.png",
  }));
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage,
    transport: { fetch: async () => response(output(f.asset.id)) },
  });
  const forged = structuredClone(claim.context);
  forged.run.inputRevision++;
  expect(await execute(forged)).toMatchObject({
    state: "blocked",
    code: "extraction_context_invalid",
  });
  expect(resolveImage).not.toHaveBeenCalled();
});
it("preserves explicit ambiguity through actual Go, grounding, persistence and reconstruction", async () => {
  const f = await fixture(),
    raw = output(f.asset.id);
  raw.identity.status = "needs_confirmation";
  raw.evidence[0]!.identity!.status = "needs_confirmation";
  await runFixture(f, { fetch: async () => response(raw) });
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const loaded = await readWineExtractionContext(db, claim.context);
  expect(loaded.context.identity.status).toBe("needs_confirmation");
  expect(loaded.context.sources[0]!.identity!.status).toBe(
    "needs_confirmation",
  );
});
it("keeps source-only OCR ambiguity actionable through the stored extraction result", async () => {
  const f = await fixture(),
    raw = output(f.asset.id);
  raw.evidence[0]!.identity = {
    ...raw.evidence[0]!.identity!,
    status: "needs_confirmation",
  };
  await runFixture(f, { fetch: async () => response(raw) });
  const claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("fixture");
  const loaded = await readWineExtractionContext(db, claim.context);
  expect(loaded.context.identity.status).toBe("needs_confirmation");
  expect(loaded.context.sources[0]!.identity!.status).toBe(
    "needs_confirmation",
  );
  expect(loaded.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "observation_identity_ambiguous",
        blocking: true,
      }),
    ]),
  );
});
