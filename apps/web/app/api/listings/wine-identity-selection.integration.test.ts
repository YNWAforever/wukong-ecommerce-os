import { createWineVerificationHandler } from "../../../../worker/src/wine-verification-handler";
import { authorizeWineVerifiedEvidence } from "@wukong/db";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { db } from "../../../../worker/src/wine-candidate-projection.fixture";
it("rejects client selection metadata at initial immutable input boundary", async () => {
  const workspaceId = `selection-${randomUUID()}`;
  await expect(
    db.forWorkspace(workspaceId, async (r) => {
      const listing = await r.listings.create({ target: "shopline" });
      return r.listingInputs.initialize(
        {
          listingId: listing.id,
          actorId: "operator",
          workingContent: {
            ...emptyWorkingListing(),
            wineIdentitySelection: { selectedBy: "forged" },
          } as never,
        },
        { workspaceId, actorId: "operator", entityId: listing.id },
        r.audit,
      );
    }),
  ).rejects.toThrow("wine_selection_server_only");
});

import {
  ready,
  admin,
} from "../../../../worker/src/wine-candidate-projection.fixture";
import { confirmWineIdentity } from "../../../lib/wine-identity-service";
import { prepareWineAdmission } from "../../../lib/wine-enrichment-service";
import { preflightWineCapability } from "../../../lib/wine-capability-client";
import { wineEnrichmentPolicySchema } from "@wukong/core";
import { vi, afterEach } from "vitest";
afterEach(() => vi.unstubAllEnvs());
async function selectionAdmission(f: Awaited<ReturnType<typeof ready>>) {
  return prepareWineAdmission(db, f.job.workspaceId, "research", (options) =>
    preflightWineCapability({
      ...options,
      fetch: async () =>
        Response.json({
          authenticated: true,
          fullResearchConfigured: true,
          wine: {
            schemaVersion: 1,
            execution: f.run.execution.wineGo,
            databaseSchemaVersion: "wine-enrichment-0042-v1",
            buildSha: "abcdef0",
            consumerSupported: true,
            goConfigured: true,
            tavilyConfigured: true,
            queueReady: true,
            databaseReady: true,
          },
        }),
    }),
  );
}
async function selectionFixture(
  working?: import("@wukong/core").WorkingListing,
) {
  const f = await ready(working, (r) => r, undefined, 1);
  await f.store.commitCandidate(f.context);
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
  vi.stubEnv("QUEUE_INGRESS_URL", "https://worker.test");
  vi.stubEnv("QUEUE_INGRESS_SECRET", "synthetic");
  await db.forWorkspace(f.job.workspaceId, (r) =>
    r.workspaces.updateProfile({
      name: "Synthetic",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      tone: "Clear",
      claimPolicy: [],
      requiredFields: [],
      brandBackgroundColor: null,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        allowedDomains: ["wine.test"],
        tavilyCreditCap: 50,
      }),
    }),
  );
  const admission = await selectionAdmission(f);
  const listing = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.listings.requireById(f.run.listingId),
  );
  const request = {
    workspaceId: f.job.workspaceId,
    listingId: f.run.listingId,
    actorId: "operator",
    expectedInputRevision: 1,
    baseVersionId: listing.activeVersionId,
    operationKey: randomUUID(),
    sourceRunId: f.run.id,
    sourceStage: "verification" as const,
    sourceId: f.source.id,
  };
  return { f, request, admission };
}
it("persists authoritative selection and new operation once, replaying after revision advances", async () => {
  const { f, request, admission } = await selectionFixture();
  const first = await db.forWorkspace(request.workspaceId, (r) =>
    confirmWineIdentity(r, request, admission),
  );
  const next = await db.forWorkspace(request.workspaceId, (r) =>
    r.listingInputs.getCurrent(request.listingId),
  );
  expect(next!.revision).toBe(2);
  expect(next!.workingContent.wineIdentitySelection).toMatchObject({
    selectedBy: "operator",
    sourceRunId: f.run.id,
    sourceId: f.source.id,
  });
  expect(next!.note).toBe((f.run.execution.input as any).note);
  expect(next!.sources).toEqual((f.run.execution.input as any).sources);
  const beforeReplay = await counts(request.workspaceId);
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "false");
  const replay = await db.forWorkspace(request.workspaceId, (r) =>
    confirmWineIdentity(r, request, {}),
  );
  expect(replay.processing.runId).toBe(first.processing.runId);
  expect(await counts(request.workspaceId)).toEqual(beforeReplay);
  expect(
    (await db.forWorkspace(request.workspaceId, (r) =>
      r.listingInputs.getCurrent(request.listingId),
    ))!.revision,
  ).toBe(2);
});

import { createWineExtractionHandler } from "../../../../worker/src/wine-extraction-handler";
import { createWineStageStore } from "../../../../worker/src/wine-enrichment-runtime";
import { runWineStage } from "../../../../worker/src/wine-enrichment-pipeline";
import { wineIdentity, webEvidence } from "@wukong/core";
import { readWineOriginalExtraction } from "@wukong/db";
async function executeSelectedRun(
  registryChanged = false,
  seed?: Awaited<ReturnType<typeof selectionFixture>>,
) {
  const { f, request, admission } = seed ?? (await selectionFixture());
  const accepted = await db.forWorkspace(request.workspaceId, (r) =>
    confirmWineIdentity(r, request, admission),
  );
  const run = await db.forWorkspace(request.workspaceId, (r) =>
    r.pipelineRuns.getOperation(accepted.processing.runId),
  );
  if (registryChanged) {
    await db.forWorkspace(request.workspaceId, async (r) => {
      for (const authority of await r.wineEnrichment.readAuthorities())
        await r.wineEnrichment.recordReviewedAuthority(authority.verifierId, {
          ...authority,
          revokedAt: new Date().toISOString(),
        });
    });
    await expect(
      db.forWorkspace(request.workspaceId, async (r) => {
        const origin = await r.wineEnrichment.readStage(
          f.run.id,
          "verification",
        );
        const frozen = (origin!.output as any).result.frozenVerification;
        await authorizeWineVerifiedEvidence(r, {
          workspaceId: request.workspaceId,
          run: f.run,
          input: f.run.execution.input as any,
          frozen,
          claims: [f.claim],
          now: await r.pipelineRuns.acceptanceTimestamp(),
        });
      }),
    ).rejects.toThrow("adopted_authority_changed");
  }
  const note = (run!.execution.input as any).note;
  const identity = wineIdentity({
    volumeMl: 750,
    packQuantity: 1,
    status: "needs_confirmation",
  });
  const evidence = webEvidence({
    kind: "merchant",
    assetId: null,
    url: null,
    domain: null,
    contentScope: "note",
    excerpt: note,
    identity,
  });
  const job = {
    ...f.job,
    runId: run!.id,
    inputRevision: run!.inputRevision,
    activeVersionSequence: run!.activeVersionSequence,
    stage: "extraction" as const,
  };
  const execute = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => {
      throw Error("no images");
    },
    transport: {
      fetch: async () =>
        Response.json({
          model: "deepseek-v4.1-flash",
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  schemaVersion: 1,
                  identity,
                  evidence: [evidence],
                }),
              },
            },
          ],
        }),
    },
  });
  const extracted = await runWineStage(job, {
    store: createWineStageStore(db),
    execute,
  });
  expect(extracted, JSON.stringify(extracted)).toMatchObject({
    status: "advanced",
  });
  const stage = await db.forWorkspace(request.workspaceId, (r) =>
    r.wineEnrichment.readStage(run!.id, "extraction"),
  );
  const result = (stage!.output as any).result;
  expect(result.identity.status).toBe("matched");
  expect(result.originalIdentity.status).toBe("needs_confirmation");
  expect(result.evidence).toHaveLength(2);
  const rebuilt = await db.forWorkspace(request.workspaceId, (r) =>
    readWineOriginalExtraction(r, request.workspaceId, run!, stage!, result),
  );
  expect(rebuilt.context.identity).toEqual(result.identity);
  expect(
    rebuilt.context.supports.every((s) => s.sourceId !== result.evidence[1].id),
  ).toBe(true);
  const store = createWineStageStore(db);
  const researchSource = { ...f.source, id: randomUUID() };
  await db.forWorkspace(request.workspaceId, (r) =>
    r.wineEnrichment.saveEvidence(run!.id, [researchSource]),
  );
  const researchEvidence = [...result.evidence, researchSource];
  expect(
    await runWineStage(
      { ...job, stage: "search_basic" },
      {
        store,
        execute: async () => ({
          schemaVersion: 1,
          stage: "search_basic",
          state: "succeeded",
          evidence: researchEvidence,
          partial: false,
          issues: [],
        }),
      },
    ),
  ).toMatchObject({ status: "advanced" });
  const verify = createWineVerificationHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    transport: {
      fetch: async () =>
        Response.json({
          model: "deepseek-v4.1-flash",
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  schemaVersion: 1,
                  candidates: [],
                  claims: [],
                  supportProposals: [],
                  needsDeepSearch: false,
                  issues: [],
                }),
              },
            },
          ],
        }),
    },
  });
  const verified = await runWineStage(
    { ...job, stage: "verification" },
    { store, execute: verify },
  );
  expect(verified, JSON.stringify(verified)).toMatchObject({
    status: "advanced",
  });
  await db.forWorkspace(request.workspaceId, async (r) => {
    const stage = await r.wineEnrichment.readStage(run!.id, "verification");
    const v = (stage!.output as any).result;
    expect(v.identity.status).toBe("matched");
    if (registryChanged) {
      await expect(
        authorizeWineVerifiedEvidence(r, {
          workspaceId: request.workspaceId,
          run: run!,
          input: run!.execution.input as any,
          frozen: v.frozenVerification,
          claims: [{ ...f.claim, evidenceIds: [researchSource.id] }],
          now: await r.pipelineRuns.acceptanceTimestamp(),
        }),
      ).rejects.toThrow("adopted_claim_invalid");
    }

    expect(
      v.issues.some((i: any) => i.code === "verification_identity_unresolved"),
    ).toBe(registryChanged);
    await authorizeWineVerifiedEvidence(r, {
      workspaceId: request.workspaceId,
      run: run!,
      input: run!.execution.input as any,
      frozen: v.frozenVerification,
      claims: v.claims.filter((c: any) => c.state === "accepted"),
      now: await r.pipelineRuns.acceptanceTimestamp(),
    });
  });
  return {
    f: { ...f, run: run!, source: researchSource },
    request: {
      ...request,
      expectedInputRevision: run!.inputRevision,
      operationKey: randomUUID(),
      sourceRunId: run!.id,
      sourceId: researchSource.id,
    },
    admission,
  };
}
it.each([false, true])(
  "actual selected-run extraction and immutable reconstruction consume selection after registry change=%s",
  async (registryChanged) => {
    await executeSelectedRun(registryChanged);
  },
);

it.each(["revision", "self_cycle"])(
  "rejects malformed actual origin %s before recursive proof reads",
  async (kind) => {
    const { f, request, admission } = await selectionFixture();
    const accepted = await db.forWorkspace(request.workspaceId, (r) =>
      confirmWineIdentity(r, request, admission),
    );
    const { readWineIdentitySelection } = await import("@wukong/db");
    await db.forWorkspace(request.workspaceId, async (r) => {
      const input = (await r.listingInputs.getCurrent(request.listingId))!;
      const readStage = vi.fn(r.wineEnrichment.readStage);
      const repositories = {
        ...r,
        pipelineRuns: {
          ...r.pipelineRuns,
          getOperation: async (id: string) => {
            const operation = await r.pipelineRuns.getOperation(id);
            return operation && id === f.run.id
              ? { ...operation, inputRevision: input.revision }
              : operation;
          },
        },
        wineEnrichment: { ...r.wineEnrichment, readStage },
      };
      await expect(
        readWineIdentitySelection(
          repositories,
          input,
          kind === "self_cycle" ? f.run.id : accepted.processing.runId,
        ),
      ).rejects.toThrow("wine_identity_selection_invalid");
      expect(readStage).not.toHaveBeenCalled();
    });
  },
);

it("bounds actual persisted repeated-selection traversal at sixteen ancestors", async () => {
  let seed = await selectionFixture();
  // Finish only fixture operation bookkeeping between real extraction/verification
  // rounds; the complete ambiguity-to-terminal acceptance path is tested separately.
  for (let count = 1; count <= 16; count++) {
    seed.admission = await selectionAdmission(seed.f);
    seed = await executeSelectedRun(false, seed);
    await db.forWorkspace(seed.request.workspaceId, async (r) => {
      await r.pipelineRuns.setOperationState(seed.f.run.id, "succeeded");
      await r.wineEnrichment.settleTerminalBudgets(seed.f.run.id);
    });
  }
  const { readWineIdentitySelection } = await import("@wukong/db");
  await db.forWorkspace(seed.request.workspaceId, async (r) => {
    const current = (await r.listingInputs.getCurrent(seed.request.listingId))!;
    let reads = 0;
    const counted = {
      ...r,
      wineEnrichment: {
        ...r.wineEnrichment,
        readStage: async (
          ...args: Parameters<typeof r.wineEnrichment.readStage>
        ) => {
          reads++;
          return r.wineEnrichment.readStage(...args);
        },
      },
    };
    expect(
      await readWineIdentitySelection(counted, current, seed.f.run.id),
    ).toBeDefined();
    expect(reads).toBe(80); // three prefix stages, deep-stage exclusion, and original extraction for each origin
  });
  seed.admission = await selectionAdmission(seed.f);
  const before = await counts(seed.request.workspaceId);
  await expect(
    db.forWorkspace(seed.request.workspaceId, (r) =>
      confirmWineIdentity(r, seed.request, seed.admission),
    ),
  ).rejects.toMatchObject({ code: "wine_identity_candidate_unavailable" });
  expect(await counts(seed.request.workspaceId)).toEqual(before);
  await db.forWorkspace(seed.request.workspaceId, async (r) => {
    const progress = await readWineProgress(
      r,
      (await r.pipelineRuns.getOperation(seed.f.run.id))!,
    );
    expect(
      progress!.candidates.every(
        (candidate) => !candidate.confirmationAvailable,
      ),
    ).toBe(true);
  });
  // Deliberately construct an over-depth persisted input through the internal port
  // to verify the historical reader independently of admission protection.
  await db.forWorkspace(seed.request.workspaceId, async (r) => {
    const { listingInputDigest, wineSelectionContextDigest } =
      await import("@wukong/db");
    const current = (await r.listingInputs.getCurrent(seed.request.listingId))!;
    const stage = (await r.wineEnrichment.readStage(
      seed.f.run.id,
      "verification",
    ))!;
    const source = (stage.output as any).result.frozenVerification.sources.find(
      (source: any) => source.id === seed.f.source.id,
    );
    const selection = {
      ...current.workingContent.wineIdentitySelection!,
      sourceRunId: seed.f.run.id,
      sourceId: source.id,
      sourceInputRevision: current.revision,
      sourceInputDigest: current.inputDigest,
      sourceBaseVersionId: seed.f.run.baseVersionId,
      sourceStageDigest: listingInputDigest(stage),
      identityDigest: listingInputDigest(source.identity),
      selectedInputRevision: current.revision + 1,
      selectedAt: await r.pipelineRuns.acceptanceTimestamp(),
      contextDigest: wineSelectionContextDigest(current),
    };
    await r.listingInputs.saveIdentitySelection(
      {
        ...seed.request,
        changes: [],
        requestDigest: listingInputDigest(selection),
      },
      selection,
      {
        workspaceId: seed.request.workspaceId,
        actorId: "operator",
        entityId: seed.request.listingId,
      },
      r.audit,
    );
  });
  await db.forWorkspace(seed.request.workspaceId, async (r) => {
    const current = (await r.listingInputs.getCurrent(seed.request.listingId))!;
    let reads = 0;
    const counted = {
      ...r,
      wineEnrichment: {
        ...r.wineEnrichment,
        readStage: async (
          ...args: Parameters<typeof r.wineEnrichment.readStage>
        ) => {
          reads++;
          return r.wineEnrichment.readStage(...args);
        },
      },
    };
    await expect(
      readWineIdentitySelection(counted, current, randomUUID()),
    ).rejects.toThrow("wine_identity_selection_invalid");
    expect(reads).toBe(80);
  });
}, 180_000);

import { readWineProgress } from "../../../lib/wine-progress";
it("offers only currently authorized persisted verification candidate references", async () => {
  const { f, request } = await selectionFixture();
  const progress = await db.forWorkspace(request.workspaceId, async (r) =>
    readWineProgress(r, (await r.pipelineRuns.getOperation(f.run.id))!),
  );
  expect(progress!.candidates).toContainEqual(
    expect.objectContaining({
      id: f.source.id,
      stage: "verification",
      confirmationAvailable: true,
    }),
  );
  expect(
    progress!.candidates
      .filter((c) => c.stage === "extraction" || c.stage === "search_basic")
      .every((c) => !c.confirmationAvailable),
  ).toBe(true);
});

import { acceptListingOperation } from "../../../lib/listing-operation-service";
import { createWineGenerationHandler } from "../../../../worker/src/wine-generation-handler";
import { projectWineCandidate } from "../../../../worker/src/wine-candidate-projection";
import { createHash } from "node:crypto";
const syntheticResponse = (value: unknown) =>
  Response.json({
    model: "deepseek-v4.1-flash",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(value) },
      },
    ],
  });
it("actual unknown-vintage pipeline exposes alternatives, accepts 2020, and verifies matching identity without erasing 2021", async () => {
  const seed = await selectionFixture();
  const workspaceId = seed.request.workspaceId;
  const note =
    "Producer: Fixture Estate\nProduct: Reserve Red\nVolume: 750 ml\nPack quantity: 1 bottles\nMarket: HK\nABV: 13%";
  const created = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    await r.listingInputs.initialize(
      {
        listingId: listing.id,
        actorId: "operator",
        note,
        workingContent: {
          ...emptyWorkingListing(),
          priceHkd: 159,
          stockQuantity: 7,
          sku: "merchant-sku",
        },
      },
      { workspaceId, actorId: "operator", entityId: listing.id },
      r.audit,
    );
    return acceptListingOperation(
      r,
      {
        workspaceId,
        listingId: listing.id,
        actorId: "operator",
        expectedInputRevision: 1,
        baseVersionId: null,
        operationKey: randomUUID(),
        wineMode: "research",
        wineOnly: true,
      },
      seed.admission,
    );
  });
  const store = createWineStageStore(db, {
    projectCandidate: projectWineCandidate,
  });
  const initialRun = await db.forWorkspace(workspaceId, (r) =>
    r.pipelineRuns.getOperation(created.processing.runId),
  );
  const listingId = initialRun!.listingId;
  const originalIdentity = wineIdentity({
    volumeMl: 750,
    packQuantity: 1,
    marketVariant: "HK",
    abvPercent: 13,
    status: "needs_confirmation",
  });
  const source = webEvidence({
    kind: "merchant",
    assetId: null,
    url: null,
    domain: null,
    contentScope: "note",
    excerpt: note,
    identity: originalIdentity,
  });
  const extract = createWineExtractionHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => {
      throw Error("no images");
    },
    transport: {
      fetch: async () =>
        syntheticResponse({
          schemaVersion: 1,
          identity: originalIdentity,
          evidence: [source],
        }),
    },
  });
  const verify = createWineVerificationHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    transport: {
      fetch: async () =>
        syntheticResponse({
          schemaVersion: 1,
          candidates: [],
          claims: [],
          supportProposals: [],
          needsDeepSearch: false,
          issues: [],
        }),
    },
  });
  const empty = { en: "", "zh-Hant": "" };
  const generate = createWineGenerationHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    transport: {
      fetch: async () =>
        syntheticResponse({
          schemaVersion: 1,
          content: {
            title: empty,
            sections: [],
            seo: { title: empty, description: empty },
            tags: [],
          },
          annotations: [],
        }),
    },
  });
  const jobFor = (run: typeof initialRun, stage: any) => ({
    schemaVersion: 2 as const,
    flowVersion: "wine-enrichment-v1" as const,
    workspaceId,
    draftId: listingId,
    runId: run!.id,
    inputRevision: run!.inputRevision,
    activeVersionSequence: run!.activeVersionSequence,
    stage,
  });
  async function research(
    run: NonNullable<typeof initialRun>,
    stage: "search_basic" | "search_deep",
  ) {
    return runWineStage(jobFor(run, stage), {
      store,
      execute: async () => {
        if (stage === "search_basic") {
          const sources = [2020, 2021].map((year) => {
            const excerpt = `Kind: wine\n${note}\nVintage: ${year}`;
            return webEvidence({
              id: randomUUID(),
              domain: "wine.test",
              url: `https://wine.test/${year}`,
              excerpt,
              capturedAt: new Date().toISOString(),
              identity: null,
              documentDigest:
                "sha256:" + createHash("sha256").update(excerpt).digest("hex"),
              independenceKey: "wine.test",
            });
          });
          await db.forWorkspace(workspaceId, (r) =>
            r.wineEnrichment.saveEvidence(run.id, sources),
          );
        }
        const evidence = await db.forWorkspace(workspaceId, (r) =>
          r.wineEnrichment.readEvidence(run.id),
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
    });
  }
  const advance = (value: any) =>
    expect(value, JSON.stringify(value)).toMatchObject({ status: "advanced" });
  advance(
    await runWineStage(jobFor(initialRun, "extraction"), {
      store,
      execute: extract,
    }),
  );
  advance(await research(initialRun!, "search_basic"));
  advance(
    await runWineStage(jobFor(initialRun, "verification"), {
      store,
      execute: verify,
    }),
  );
  advance(await research(initialRun!, "search_deep"));
  advance(
    await runWineStage(jobFor(initialRun, "verification_deep"), {
      store,
      execute: verify,
    }),
  );
  const originalStage = await db.forWorkspace(workspaceId, (r) =>
    r.wineEnrichment.readStage(initialRun!.id, "verification_deep"),
  );
  const original = (originalStage!.output as any).result;
  expect(original.identity.vintage.state).toBe("unknown");
  expect(original.identity.status).toBe("needs_confirmation");
  advance(
    await runWineStage(jobFor(initialRun, "generation"), {
      store,
      execute: generate,
    }),
  );
  const quality = createWineGenerationHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    transport: {
      fetch: async () => syntheticResponse({ schemaVersion: 1, issues: [] }),
    },
  });
  advance(
    await runWineStage(jobFor(initialRun, "quality_check"), {
      store,
      execute: quality,
    }),
  );
  const committed = await runWineStage(jobFor(initialRun, "commit_candidate"), {
    store,
    execute: generate,
  });
  expect(committed, JSON.stringify(committed)).toMatchObject({
    status: "completed",
  });
  const progress = await db.forWorkspace(workspaceId, async (r) =>
    readWineProgress(r, (await r.pipelineRuns.getOperation(initialRun!.id))!),
  );
  expect(progress!.state).toBe("needs_info");
  const alternatives = progress!.candidates.filter(
    (c) => c.confirmationAvailable,
  );
  expect(alternatives.map((c) => c.identity.vintage.year).sort()).toEqual([
    2020, 2021,
  ]);
  const chosen = alternatives.find((c) => c.identity.vintage.year === 2020)!;
  const listing = await db.forWorkspace(workspaceId, (r) =>
    r.listings.requireById(listingId),
  );
  const selected = await db.forWorkspace(workspaceId, (r) =>
    confirmWineIdentity(
      r,
      {
        workspaceId,
        listingId,
        actorId: "operator",
        expectedInputRevision: 1,
        baseVersionId: listing.activeVersionId,
        operationKey: randomUUID(),
        sourceRunId: initialRun!.id,
        sourceStage: "verification_deep",
        sourceId: chosen.id,
      },
      seed.admission,
    ),
  );
  const selectedRun = await db.forWorkspace(workspaceId, (r) =>
    r.pipelineRuns.getOperation(selected.processing.runId),
  );
  advance(
    await runWineStage(jobFor(selectedRun, "extraction"), {
      store,
      execute: extract,
    }),
  );
  advance(await research(selectedRun!, "search_basic"));
  advance(
    await runWineStage(jobFor(selectedRun, "verification"), {
      store,
      execute: verify,
    }),
  );
  const selectedStage = await db.forWorkspace(workspaceId, (r) =>
    r.wineEnrichment.readStage(selectedRun!.id, "verification"),
  );
  const v = (selectedStage!.output as any).result;
  expect(v.identity).toMatchObject({
    vintage: { state: "known", year: 2020 },
    status: "matched",
  });
  expect(
    v.issues.some((i: any) => i.code === "verification_identity_unresolved"),
  ).toBe(false);
  expect(
    v.frozenVerification.sources.filter((s: any) => s.kind === "web"),
  ).toHaveLength(2);
  expect(v.issues).toContainEqual(
    expect.objectContaining({
      code: "source_identity_mismatch",
      blocking: false,
    }),
  );
  await db.forWorkspace(workspaceId, async (r) => {
    const input = await r.listingInputs.getCurrent(listingId);
    expect(input!.workingContent).toMatchObject({
      priceHkd: 159,
      stockQuantity: 7,
      sku: "merchant-sku",
    });
    await authorizeWineVerifiedEvidence(r, {
      workspaceId,
      run: selectedRun!,
      input: input!,
      frozen: v.frozenVerification,
      claims: v.claims.filter((c: any) => c.state === "accepted"),
      now: await r.pipelineRuns.acceptanceTimestamp(),
    });
    expect(
      await r.wineEnrichment.readStage(initialRun!.id, "verification_deep"),
    ).toEqual(originalStage);
  });
});

import { ApiError } from "../../../lib/route-support";
async function counts(workspaceId: string) {
  return (
    await admin`select (select count(*)::int from listing_input_revisions where workspace_id=${workspaceId}) inputs, (select count(*)::int from listing_pipeline_runs where workspace_id=${workspaceId}) runs, (select count(*)::int from ai_budget_reservations where workspace_id=${workspaceId}) go, (select count(*)::int from search_budget_reservations where workspace_id=${workspaceId}) search, (select count(*)::int from listing_dispatch_outbox where workspace_id=${workspaceId}) outbox, (select count(*)::int from audit_events where workspace_id=${workspaceId}) audit`
  )[0];
}
it.each(["preflight", "after_outbox"])(
  "rolls back selection input/audit/run/both holds/outbox on %s failure",
  async (point) => {
    const { request, admission } = await selectionFixture();
    const before = await counts(request.workspaceId);
    await db.forWorkspace(request.workspaceId, async (r) => {
      const original = r.dispatchOutbox.record;
      if (point === "after_outbox")
        r.dispatchOutbox.record = async (...args) => {
          await original(...args);
          throw new ApiError(503, "synthetic_failure", "Synthetic failure");
        };
      await expect(
        confirmWineIdentity(
          r,
          request,
          point === "preflight"
            ? {
                winePreflightError: new ApiError(
                  503,
                  "wine_capability_unavailable",
                  "Synthetic failure",
                ),
              }
            : admission,
        ),
      ).rejects.toBeInstanceOf(ApiError);
      expect(
        (await r.listingInputs.getCurrent(request.listingId))!.revision,
      ).toBe(1);
    });
    expect(await counts(request.workspaceId)).toEqual(before);
  },
);
it.each(["revision", "base", "source", "run", "stage", "tenant"])(
  "fails closed for changed or foreign %s",
  async (kind) => {
    const { request, admission } = await selectionFixture();
    const before = await counts(request.workspaceId);
    const next = { ...request };
    if (kind === "revision") next.expectedInputRevision++;
    if (kind === "base") next.baseVersionId = randomUUID();
    if (kind === "source") next.sourceId = randomUUID();
    if (kind === "run") next.sourceRunId = randomUUID();
    if (kind === "stage") next.sourceStage = "verification_deep" as never;
    await expect(
      db.forWorkspace(
        kind === "tenant" ? "foreign-selection-tenant" : request.workspaceId,
        (r) => confirmWineIdentity(r, next, admission),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await counts(request.workspaceId)).toEqual(before);
  },
);
it("rejects substitution on replay without allocating another input or operation", async () => {
  const { request, admission } = await selectionFixture();
  await db.forWorkspace(request.workspaceId, (r) =>
    confirmWineIdentity(r, request, admission),
  );
  const before = await counts(request.workspaceId);
  await expect(
    db.forWorkspace(request.workspaceId, (r) =>
      confirmWineIdentity(r, { ...request, sourceId: randomUUID() }, admission),
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await counts(request.workspaceId)).toEqual(before);
});
it("preserves selection for merchant price/copy edits and invalidates identity/source edits", async () => {
  const { request, admission } = await selectionFixture();
  await db.forWorkspace(request.workspaceId, (r) =>
    confirmWineIdentity(r, request, admission),
  );
  const original = await db.forWorkspace(request.workspaceId, (r) =>
    r.listingInputs.getCurrent(request.listingId),
  );
  await db.forWorkspace(request.workspaceId, async (r) => {
    const saved = await r.listingInputs.save(
      {
        ...request,
        expectedInputRevision: 2,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [
          { field: "priceHkd", value: 499 },
          { field: "title.en", value: "Merchant copy" },
        ],
      },
      {
        workspaceId: request.workspaceId,
        actorId: "operator",
        entityId: request.listingId,
      },
      r.audit,
    );
    expect(saved.workingContent.wineIdentitySelection).toEqual(
      original!.workingContent.wineIdentitySelection,
    );
    const changed = await r.listingInputs.save(
      {
        ...request,
        expectedInputRevision: 3,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        note: "Changed original source context",
        changes: [],
      },
      {
        workspaceId: request.workspaceId,
        actorId: "operator",
        entityId: request.listingId,
      },
      r.audit,
    );
    expect(changed.workingContent.wineIdentitySelection).toBeUndefined();
    expect(
      (await r.listingInputs.getRevision(request.listingId, 2))!.workingContent
        .wineIdentitySelection,
    ).toEqual(original!.workingContent.wineIdentitySelection);
  });
});

it("rejects a selection conflicting with a protected merchant identity value", async () => {
  const { request, admission } = await selectionFixture({
    ...emptyWorkingListing(),
    producer: "Merchant Estate",
  });
  await expect(
    db.forWorkspace(request.workspaceId, (r) =>
      confirmWineIdentity(r, request, admission),
    ),
  ).rejects.toMatchObject({ code: "wine_identity_selection_conflict" });
});
it.each(["identity", "sources"])(
  "invalidates selection on %s edit without changing historical selection",
  async (kind) => {
    const { request, admission } = await selectionFixture();
    await db.forWorkspace(request.workspaceId, (r) =>
      confirmWineIdentity(r, request, admission),
    );
    await db.forWorkspace(request.workspaceId, async (r) => {
      const saved = await r.listingInputs.save(
        {
          ...request,
          expectedInputRevision: 2,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          ...(kind === "sources" ? { note: "different evidence" } : {}),
          changes:
            kind === "identity"
              ? [{ field: "producer", value: "Other estate" }]
              : [],
        },
        {
          workspaceId: request.workspaceId,
          actorId: "operator",
          entityId: request.listingId,
        },
        r.audit,
      );
      expect(saved.workingContent.wineIdentitySelection).toBeUndefined();
      expect(
        (await r.listingInputs.getRevision(request.listingId, 2))!
          .workingContent.wineIdentitySelection,
      ).toBeDefined();
    });
  },
);
it.each(["selectedIdentity", "sourceId", "selectedBy", "sourceInputDigest"])(
  "rejects tampered persisted %s during selected-run authorization",
  async (key) => {
    const { request, admission } = await selectionFixture();
    const accepted = await db.forWorkspace(request.workspaceId, (r) =>
      confirmWineIdentity(r, request, admission),
    );
    await db.forWorkspace(request.workspaceId, async (r) => {
      const input = structuredClone(
        (await r.listingInputs.getCurrent(request.listingId))!,
      );
      const selection = input.workingContent.wineIdentitySelection!;
      if (key === "selectedIdentity")
        selection.selectedIdentity.producer = "Forged estate";
      if (key === "sourceId") selection.sourceId = randomUUID();
      if (key === "selectedBy") selection.selectedBy = "forged actor";
      if (key === "sourceInputDigest")
        selection.sourceInputDigest = "f".repeat(64);
      await expect(
        import("@wukong/db").then((m) =>
          m.readWineIdentitySelection(r, input, accepted.processing.runId),
        ),
      ).rejects.toThrow();
    });
  },
);

it.each(["stale", "rejected", "evidence_changed"])(
  "does not offer or accept %s origin evidence",
  async (kind) => {
    const { request, admission } = await selectionFixture();
    await db.forWorkspace(request.workspaceId, async (r) => {
      const originalTime = r.pipelineRuns.acceptanceTimestamp;
      const originalStage = r.wineEnrichment.readStage;
      const originalEvidence = r.wineEnrichment.readEvidence;
      if (kind === "stale")
        r.pipelineRuns.acceptanceTimestamp = async () =>
          new Date(
            Date.parse(await originalTime()) + 8 * 86400000,
          ).toISOString();
      if (kind === "rejected")
        r.wineEnrichment.readStage = async (...args) => {
          const row = await originalStage(...args);
          return row?.stage === "verification"
            ? { ...row, output: { ...(row.output as any), fresh: false } }
            : row;
        };
      if (kind === "evidence_changed")
        r.wineEnrichment.readEvidence = async (...args) =>
          (await originalEvidence(...args)).map((s) =>
            s.id === request.sourceId
              ? { ...s, excerpt: "changed evidence" }
              : s,
          );
      await expect(
        confirmWineIdentity(r, request, admission),
      ).rejects.toBeInstanceOf(ApiError);
      const run = await r.pipelineRuns.getOperation(request.sourceRunId);
      expect(
        (await readWineProgress(r, run!))!.candidates.every(
          (c) => !c.confirmationAvailable,
        ),
      ).toBe(true);
    });
  },
);
it("public save rejects forged selection metadata", async () => {
  const { request } = await selectionFixture();
  await expect(
    db.forWorkspace(request.workspaceId, (r) =>
      r.listingInputs.save(
        {
          ...request,
          requestDigest: randomUUID(),
          changes: [],
          reviewContent: {
            ...emptyWorkingListing(),
            wineIdentitySelection: { selectedBy: "forged" },
          } as never,
        },
        {
          workspaceId: request.workspaceId,
          actorId: "operator",
          entityId: request.listingId,
        },
        r.audit,
      ),
    ),
  ).rejects.toThrow("wine_selection_server_only");
});

it.each(["location", "id"])(
  "rejects provider imitation of reserved selection %s before persistence",
  async (kind) => {
    const { f, request, admission } = await selectionFixture();
    const accepted = await db.forWorkspace(request.workspaceId, (r) =>
      confirmWineIdentity(r, request, admission),
    );
    const run = (await db.forWorkspace(request.workspaceId, (r) =>
      r.pipelineRuns.getOperation(accepted.processing.runId),
    ))!;
    const input = run.execution
      .input as import("@wukong/db").ListingInputSnapshot;
    const assertion = (await import("@wukong/db")).createWineIdentityAssertion(
      input.workingContent.wineIdentitySelection!,
      run.id,
    );
    const identity = wineIdentity({ volumeMl: 750, packQuantity: 1 });
    const source = webEvidence({
      kind: "merchant",
      assetId: null,
      url: null,
      domain: null,
      contentScope: "note",
      excerpt: input.note!,
      identity,
      ...(kind === "location"
        ? { location: assertion.source.location }
        : { id: assertion.source.id }),
    });
    for (const obs of Object.values(identity.observations))
      if (obs) obs.evidenceIds = [source.id];
    const execute = createWineExtractionHandler({
      database: db,
      env: { OPENCODE_GO_API_KEY: "synthetic" },
      resolveImage: async () => {
        throw Error("no images");
      },
      transport: {
        fetch: async () =>
          syntheticResponse({ schemaVersion: 1, identity, evidence: [source] }),
      },
    });
    const job = {
      ...f.job,
      runId: run.id,
      inputRevision: run.inputRevision,
      activeVersionSequence: run.activeVersionSequence,
    };
    expect(
      await runWineStage(job, { store: createWineStageStore(db), execute }),
    ).toMatchObject({ status: "blocked", code: "extraction_selection_forged" });
    expect(
      await db.forWorkspace(request.workspaceId, (r) =>
        r.wineEnrichment.readEvidence(run.id),
      ),
    ).toEqual([]);
  },
);
