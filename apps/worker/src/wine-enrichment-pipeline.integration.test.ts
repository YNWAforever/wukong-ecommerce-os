import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect, it } from "vitest";
import {
  createDatabase,
  listingInputDigest,
  createWineEvidenceStore,
} from "@wukong/db";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  wineIdentity,
} from "@wukong/core";
import { WINE_EXECUTION_SNAPSHOT } from "@wukong/ai";
import { type WineListingJob, wineStageMessageKey } from "@wukong/jobs";
import { createWineStageStore } from "./wine-enrichment-runtime.js";
import {
  runWineStage,
  type WineStageResult,
} from "./wine-enrichment-pipeline.js";
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
const extracted = (): WineStageResult => ({
  schemaVersion: 1,
  state: "succeeded",
  stage: "extraction",
  identity: wineIdentity(),
  evidence: [],
  issues: [],
});
async function fixture() {
  const workspaceId = `wine-stage-${randomUUID()}`;
  const run = await db.forWorkspace(workspaceId, async (r) => {
    const d = await r.listings.create({ target: "shopline" });
    const input = await r.listingInputs.initialize(
      { listingId: d.id, actorId: "test" },
      { workspaceId, actorId: "test", entityId: d.id },
      r.audit,
    );
    const acceptedAt = await r.pipelineRuns.acceptanceTimestamp();
    const run = await r.pipelineRuns.acceptOperation({
      listingId: d.id,
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
          deadlineAt: new Date(Date.parse(acceptedAt) + 900000).toISOString(),
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
    return run;
  });
  const job: WineListingJob = {
    schemaVersion: 2,
    flowVersion: "wine-enrichment-v1",
    workspaceId,
    draftId: run.listingId,
    runId: run.id,
    inputRevision: run.inputRevision,
    activeVersionSequence: 0,
    stage: "extraction",
  };
  return { run, job, store: createWineStageStore(db) };
}
it("commits the claim before execution and terminal output with one next-stage outbox; duplicate does not repeat", async () => {
  const { job, store } = await fixture();
  let calls = 0;
  const execute = async () => {
    calls++;
    expect(
      (
        await db.forWorkspace(job.workspaceId, (r) =>
          r.wineEnrichment.readStage(job.runId, job.stage),
        )
      )?.state,
    ).toBe("started");
    return extracted();
  };
  expect(await runWineStage(job, { store, execute })).toMatchObject({
    status: "advanced",
    nextStage: "search_basic",
  });
  expect(await runWineStage(job, { store, execute })).toMatchObject({
    status: "duplicate",
  });
  expect(calls).toBe(1);
  const rows =
    await admin`select * from listing_dispatch_outbox where workspace_id=${job.workspaceId} and dedupe_key=${wineStageMessageKey(job.runId, "search_basic")}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].payload.stage).toBe("search_basic");
});
it("a crash after committed claim blocks replay without starting another call", async () => {
  const { job, store } = await fixture();
  expect((await store.claim(job)).status).toBe("claimed");
  let calls = 0;
  expect(
    await runWineStage(job, {
      store,
      execute: async () => {
        calls++;
        return extracted();
      },
    }),
  ).toMatchObject({ status: "blocked", code: "stage_outcome_unknown" });
  expect(calls).toBe(0);
  const [hold] =
    await admin`select state from ai_budget_reservations where pipeline_run_id=${job.runId}`;
  expect(hold.state).toBe("held");
});
it("rejects out-of-order quality and commit messages without stage work", async () => {
  const { job, store } = await fixture();
  let calls = 0;
  for (const stage of ["quality_check", "commit_candidate"] as const)
    expect(
      await runWineStage(
        { ...job, stage },
        {
          store,
          execute: async () => {
            calls++;
            return extracted();
          },
        },
      ),
    ).toMatchObject({ status: "blocked" });
  expect(calls).toBe(0);
});
it("cancellation prevents new work and settles only zero-start holds", async () => {
  const { job, store } = await fixture();
  await db.forWorkspace(job.workspaceId, (r) =>
    r.pipelineRuns.setOperationState(job.runId, "cancelled"),
  );
  expect(
    await runWineStage(job, {
      store,
      execute: async () => {
        throw Error("must not execute");
      },
    }),
  ).toMatchObject({ status: "stopped" });
  const [go] =
    await admin`select state,settled_usd from ai_budget_reservations where pipeline_run_id=${job.runId}`;
  const [search] =
    await admin`select state,settled_credits from search_budget_reservations where pipeline_run_id=${job.runId}`;
  expect(go.state).toBe("settled");
  expect(Number(go.settled_usd)).toBe(0);
  expect(search.settled_credits).toBe(0);
});
it("expiry with an injected clock prevents a claim", async () => {
  const { job, run } = await fixture();
  const store = createWineStageStore(db, {
    now: () => new Date(Date.parse(run.acceptedAt) + 900000),
  });
  expect(
    await runWineStage(job, {
      store,
      execute: async () => {
        throw Error("must not execute");
      },
    }),
  ).toMatchObject({ status: "stopped", code: "operation_deadline" });
  expect(
    await db.forWorkspace(job.workspaceId, (r) =>
      r.wineEnrichment.readStage(job.runId, job.stage),
    ),
  ).toBeNull();
});
it("keeps stale output inspectable without the next outbox", async () => {
  const { job, store } = await fixture();
  expect(
    await runWineStage(job, {
      store,
      execute: async () => {
        await admin`update listing_drafts set input_revision=input_revision+1 where id=${job.draftId}`;
        return extracted();
      },
    }),
  ).toMatchObject({ status: "stopped", code: "operation_superseded" });
  const stage = await db.forWorkspace(job.workspaceId, (r) =>
    r.wineEnrichment.readStage(job.runId, job.stage),
  );
  expect(stage?.output).toMatchObject({ result: extracted(), fresh: false });
  const rows =
    await admin`select * from listing_dispatch_outbox where workspace_id=${job.workspaceId}`;
  expect(rows).toHaveLength(0);
});
it("atomic completion rolls back output when outbox insertion fails", async () => {
  const { job, store } = await fixture();
  const claim = await store.claim(job);
  if (claim.status !== "claimed") throw Error("claim");
  const faulty = createWineStageStore({
    forWorkspace: (ws, work) =>
      db.forWorkspace(ws, (r) =>
        work({
          ...r,
          dispatchOutbox: {
            ...r.dispatchOutbox,
            record: async (entries) => {
              await r.dispatchOutbox.record(entries);
              throw Error("outbox fault");
            },
          },
        }),
      ),
  });
  await expect(faulty.finish(claim.context, extracted())).rejects.toThrow(
    "outbox fault",
  );
  expect(
    (
      await db.forWorkspace(job.workspaceId, (r) =>
        r.wineEnrichment.readStage(job.runId, job.stage),
      )
    )?.state,
  ).toBe("started");
  expect(
    await admin`select * from listing_dispatch_outbox where workspace_id=${job.workspaceId}`,
  ).toHaveLength(0);
});
it("executor throw retains started physical call costs as unknown", async () => {
  const { job, store } = await fixture();
  expect(
    await runWineStage(job, {
      store,
      execute: async () => {
        await db.forWorkspace(job.workspaceId, (r) =>
          r.wineEnrichment.beginSearchCall({
            runId: job.runId,
            slot: "basic_1",
            maximumCredits: 1,
            requestDigest: "synthetic",
          }),
        );
        throw Error("lost response");
      },
    }),
  ).toMatchObject({ status: "blocked", code: "stage_execution_unknown" });
  const [search] =
    await admin`select state,settled_credits from search_budget_reservations where pipeline_run_id=${job.runId}`;
  expect(search.state).toBe("unknown");
  expect(search.settled_credits).toBeNull();
});

const content = () => ({
  title: { en: "Fixture", "zh-Hant": "測試" },
  sections: [],
  seo: {
    title: { en: "", "zh-Hant": "" },
    description: { en: "", "zh-Hant": "" },
  },
  tags: [],
});
const matched = (): WineStageResult =>
  ({
    ...extracted(),
    identity: wineIdentity({
      status: "matched",
      vintage: { state: "known", year: 2020 },
      volumeMl: 750,
      packQuantity: 1,
    }),
  }) as WineStageResult;
async function throughQuality(
  f: Awaited<ReturnType<typeof fixture>>,
  qualityDigest = listingInputDigest(content()),
  extractionResult: WineStageResult = matched(),
) {
  const results: WineStageResult[] = [
    extractionResult,
    {
      schemaVersion: 1,
      state: "succeeded",
      stage: "search_basic",
      evidence: [],
      partial: false,
      issues: [],
    },
    {
      schemaVersion: 1,
      state: "succeeded",
      stage: "verification",
      identity: wineIdentity({ status: "matched" }),
      claims: [],
      needsDeepSearch: false,
      deepSearchReasons: [],
      issues: [],
    },
    {
      schemaVersion: 1,
      state: "succeeded",
      stage: "generation",
      content: content(),
      issues: [],
    },
    {
      schemaVersion: 1,
      state: "succeeded",
      stage: "quality_check",
      contentDigest: qualityDigest,
      outcome: "ready",
      issues: [],
    },
  ];
  for (const result of results)
    expect(
      await runWineStage(
        { ...f.job, stage: result.stage },
        { store: f.store, execute: async () => result },
      ),
    ).toMatchObject({ status: "advanced" });
}
it("concurrent duplicate is non-destructive while the original executor is active", async () => {
  const { job, store } = await fixture();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  let calls = 0;
  const first = runWineStage(job, {
    store,
    execute: async () => {
      calls++;
      entered();
      await barrier;
      return extracted();
    },
  });
  await started;
  try {
    expect(
      await runWineStage(job, {
        store,
        execute: async () => {
          calls++;
          return extracted();
        },
      }),
    ).toMatchObject({ status: "blocked", code: "stage_outcome_unknown" });
    expect(
      (
        await db.forWorkspace(job.workspaceId, (r) =>
          r.pipelineRuns.getOperation(job.runId),
        )
      )?.executionState,
    ).toBe("running");
  } finally {
    release();
  }
  expect(await first).toMatchObject({ status: "advanced" });
  expect(calls).toBe(1);
});
it("persisted verification skips both deep stages explicitly and enqueues generation", async () => {
  const f = await fixture();
  await throughQuality(f);
  const stages =
    await admin`select stage,state from wine_stages where run_id=${f.job.runId} order by stage`;
  expect(
    stages
      .filter((x: { state: string }) => x.state === "skipped")
      .map((x: { stage: string }) => x.stage),
  ).toEqual(["search_deep", "verification_deep"]);
  const rows =
    await admin`select dedupe_key from listing_dispatch_outbox where workspace_id=${f.job.workspaceId}`;
  expect(
    rows.some(
      (x: { dedupe_key: string }) =>
        x.dedupe_key === wineStageMessageKey(f.job.runId, "generation"),
    ),
  ).toBe(true);
  expect(
    rows.some(
      (x: { dedupe_key: string }) =>
        x.dedupe_key === wineStageMessageKey(f.job.runId, "search_deep"),
    ),
  ).toBe(false);
});
it("partial search requires complete validated photo identity", async () => {
  const f = await fixture();
  await runWineStage(f.job, {
    store: f.store,
    execute: async () => extracted(),
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "search_basic" },
      {
        store: f.store,
        execute: async () => ({
          schemaVersion: 1,
          state: "succeeded",
          stage: "search_basic",
          evidence: [],
          partial: true,
          issues: [],
        }),
      },
    ),
  ).toMatchObject({ status: "blocked", code: "photo_identity_incomplete" });
});
it("partial search with complete identity persists its warning before verification", async () => {
  const f = await fixture();
  await runWineStage(f.job, { store: f.store, execute: async () => matched() });
  const result: WineStageResult = {
    schemaVersion: 1,
    state: "succeeded",
    stage: "search_basic",
    evidence: [],
    partial: true,
    issues: [
      {
        path: "evidence",
        code: "photo_only",
        blocking: false,
        evidenceIds: [],
      },
    ],
  };
  expect(
    await runWineStage(
      { ...f.job, stage: "search_basic" },
      { store: f.store, execute: async () => result },
    ),
  ).toMatchObject({ status: "advanced", nextStage: "verification" });
  expect(
    (
      await db.forWorkspace(f.job.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.job.runId, "search_basic"),
      )
    )?.output,
  ).toMatchObject({ result });
});
it("missing projection leaves commit stage unclaimed for later wiring", async () => {
  const f = await fixture();
  await throughQuality(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "commit_candidate" },
      {
        store: f.store,
        execute: async () => {
          throw Error("not an execution stage");
        },
      },
    ),
  ).toMatchObject({
    status: "blocked",
    code: "candidate_projection_unavailable",
  });
  expect(
    await db.forWorkspace(f.job.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.job.runId, "commit_candidate"),
    ),
  ).toBeNull();
});
it("quality result must bind the generated content before projection is claimed", async () => {
  const f = await fixture();
  await throughQuality(f, "f".repeat(64));
  let projections = 0;
  const store = createWineStageStore(db, {
    projectCandidate: async () => {
      projections++;
      return {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        versionId: null,
        outcome: "needs_info",
      };
    },
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "commit_candidate" },
      { store, execute: async () => extracted() },
    ),
  ).toMatchObject({ status: "blocked", code: "quality_content_mismatch" });
  expect(projections).toBe(0);
  expect(
    await db.forWorkspace(f.job.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.job.runId, "commit_candidate"),
    ),
  ).toBeNull();
});
it("transaction projection cannot run for forged dependency context", async () => {
  const f = await fixture();
  await throughQuality(f);
  let projections = 0;
  const store = createWineStageStore(db, {
    projectCandidate: async () => {
      projections++;
      return {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        versionId: null,
        outcome: "needs_info",
      };
    },
  });
  const claim = await store.claim({ ...f.job, stage: "commit_candidate" });
  if (claim.status !== "claimed") throw Error("claim");
  expect(
    await store.commitCandidate({
      ...claim.context,
      dependencyDigest: "wrong",
    }),
  ).toMatchObject({ status: "blocked", code: "stage_dependency_mismatch" });
  expect(projections).toBe(0);
});
it("projection runs once in the terminal transaction with mandatory quality context", async () => {
  const f = await fixture();
  await throughQuality(f);
  let projections = 0;
  const store = createWineStageStore(db, {
    projectCandidate: async (r, context) => {
      projections++;
      expect(context.requiredOutcome).toBe("ready");
      expect(
        context.dependencies.find((x) => x.stage === "quality_check")?.state,
      ).toBe("succeeded");
      await r.listings.updateNote(
        f.job.draftId,
        "synthetic transaction marker",
      );
      return {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        versionId: null,
        outcome: "needs_info",
      };
    },
  });
  const job = { ...f.job, stage: "commit_candidate" as const };
  expect(
    await runWineStage(job, { store, execute: async () => extracted() }),
  ).toMatchObject({ status: "completed", outcome: "needs_info" });
  await runWineStage(job, { store, execute: async () => extracted() });
  expect(projections).toBe(1);
  expect(
    (
      await db.forWorkspace(job.workspaceId, (r) =>
        r.pipelineRuns.getOperation(job.runId),
      )
    )?.executionState,
  ).toBe("succeeded");
});
it("deadline crossing during execution retains output without advancing", async () => {
  const f = await fixture();
  let time = Date.parse(f.run.acceptedAt) + 1;
  const store = createWineStageStore(db, { now: () => new Date(time) });
  expect(
    await runWineStage(f.job, {
      store,
      execute: async () => {
        time += 900000;
        return extracted();
      },
    }),
  ).toMatchObject({ status: "stopped", code: "operation_deadline" });
  expect(
    (
      await db.forWorkspace(f.job.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.job.runId, "extraction"),
      )
    )?.output,
  ).toMatchObject({ fresh: false, result: extracted() });
});
it("envelope revision/workspace mismatch starts no stage", async () => {
  const f = await fixture();
  let calls = 0;
  for (const job of [
    { ...f.job, inputRevision: f.job.inputRevision + 1 },
    { ...f.job, workspaceId: `other-${randomUUID()}` },
  ])
    expect(
      await runWineStage(job, {
        store: f.store,
        execute: async () => {
          calls++;
          return extracted();
        },
      }),
    ).toMatchObject({ status: "blocked", code: "operation_envelope_mismatch" });
  expect(calls).toBe(0);
});
it("started Go usage remains unknown while unused Tavily credits settle separately", async () => {
  const f = await fixture();
  await runWineStage(f.job, {
    store: f.store,
    execute: async () => {
      await db.forWorkspace(f.job.workspaceId, (r) =>
        r.aiRuns.beginInvocation({
          listingId: f.job.draftId,
          pipelineRunId: f.job.runId,
          task: "extract",
          stage: "extraction",
          callOrdinal: 1,
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          promptVersion: WINE_EXECUTION_SNAPSHOT.promptVersions.extract,
        }),
      );
      throw Error("crash");
    },
  });
  const [go] =
    await admin`select state,settled_usd from ai_budget_reservations where pipeline_run_id=${f.job.runId}`;
  const [search] =
    await admin`select state,settled_credits from search_budget_reservations where pipeline_run_id=${f.job.runId}`;
  expect(go.state).toBe("unknown");
  expect(go.settled_usd).toBeNull();
  expect(search.state).toBe("settled");
  expect(search.settled_credits).toBe(0);
});
it("verification with deep work persists the acquisition guard decision", async () => {
  const f = await fixture();
  await runWineStage(f.job, { store: f.store, execute: async () => matched() });
  await runWineStage(
    { ...f.job, stage: "search_basic" },
    {
      store: f.store,
      execute: async () => ({
        schemaVersion: 1,
        state: "succeeded",
        stage: "search_basic",
        evidence: [],
        partial: false,
        issues: [],
      }),
    },
  );
  const result = {
    schemaVersion: 1,
    state: "succeeded",
    stage: "verification",
    identity: wineIdentity({ status: "matched" }),
    claims: [],
    needsDeepSearch: true,
    deepSearchReasons: ["core_fact_gap"],
    issues: [],
  } as WineStageResult;
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: async () => result },
    ),
  ).toMatchObject({ status: "advanced", nextStage: "search_deep" });
  expect(
    (
      await db.forWorkspace(f.job.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.job.runId, "verification"),
      )
    )?.output,
  ).toMatchObject({
    deepSearchDecision: {
      schemaVersion: 1,
      required: true,
      reasons: ["core_fact_gap"],
    },
  });
  const physical = createWineEvidenceStore(db),
    coordinates = {
      workspaceId: f.job.workspaceId,
      runId: f.job.runId,
      inputRevision: f.job.inputRevision,
      policyDigest: "wine-enrichment@1",
      rulesVersion: "wine-grounding@1",
      allowedDomains: ["wine.test"],
    };
  const call = {
    slot: "advanced_1" as const,
    maximumCredits: 2,
    requestDigest: "synthetic-deep",
  };
  expect(
    await runWineStage(
      { ...f.job, stage: "search_deep" },
      {
        store: f.store,
        execute: async () => {
          expect(await physical.admit(coordinates, call)).toEqual({
            state: "claimed",
          });
          await physical.finish(coordinates, {
            ...call,
            status: "succeeded",
            credits: 2,
            output: { schemaVersion: 1, results: [], requestId: null },
          });
          return {
            schemaVersion: 1,
            state: "succeeded",
            stage: "search_deep",
            evidence: [],
            partial: false,
            issues: [],
          };
        },
      },
    ),
  ).toMatchObject({ status: "advanced", nextStage: "verification_deep" });
  expect(
    await runWineStage(
      { ...f.job, stage: "verification_deep" },
      {
        store: f.store,
        execute: async () => ({
          schemaVersion: 1,
          state: "succeeded",
          stage: "verification_deep",
          identity: wineIdentity({ status: "matched" }),
          claims: [],
          needsDeepSearch: false,
          deepSearchReasons: [],
          issues: [],
        }),
      },
    ),
  ).toMatchObject({ status: "advanced", nextStage: "generation" });
});

it("projection completion uses the pre-projection fence after a synthetic active-version change", async () => {
  const f = await fixture();
  await throughQuality(f);
  let projected = false;
  const wrapper: Pick<import("@wukong/db").Database, "forWorkspace"> = {
    forWorkspace: (ws, work) =>
      db.forWorkspace(ws, (r) =>
        work({
          ...r,
          listings: {
            ...r.listings,
            getById: async (id) => {
              const row = await r.listings.getById(id);
              return row && projected
                ? { ...row, activeVersionId: randomUUID() }
                : row;
            },
          },
        }),
      ),
  };
  const store = createWineStageStore(wrapper, {
    projectCandidate: async () => {
      projected = true;
      return {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        versionId: null,
        outcome: "needs_info",
      };
    },
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "commit_candidate" },
      { store, execute: async () => extracted() },
    ),
  ).toMatchObject({ status: "completed" });
});

it("resolved candidate identity can proceed automatically after matched verification", async () => {
  const f = await fixture();
  await throughQuality(f, listingInputDigest(content()), extracted());
  const store = createWineStageStore(db, {
    projectCandidate: async (_r, ctx) => {
      expect(ctx.requiredOutcome).toBe("ready");
      return {
        schemaVersion: 1,
        state: "succeeded",
        stage: "commit_candidate",
        versionId: null,
        outcome: "needs_info",
      };
    },
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "commit_candidate" },
      { store, execute: async () => extracted() },
    ),
  ).toMatchObject({ status: "completed" });
});
it("incompatible checkpoint lineage is rejected before stage execution", async () => {
  const f = await fixture();
  await db.forWorkspace(f.job.workspaceId, async (r) => {
    const c = {
      runId: f.job.runId,
      stage: "extraction" as const,
      inputDigest: "different-parent-input",
      dependencyDigest: "different-parent-policy",
    };
    await r.wineEnrichment.claimStage(c);
    await r.wineEnrichment.finishStage({
      ...c,
      state: "succeeded",
      updatedAt: new Date().toISOString(),
      output: { schemaVersion: 1, result: matched(), fresh: true },
    });
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "search_basic" },
      {
        store: f.store,
        execute: async () => {
          throw Error("must not execute");
        },
      },
    ),
  ).toMatchObject({ status: "blocked", code: "stage_dependency_mismatch" });
});
it("rechecks time after dependency reads immediately before committing a new claim", async () => {
  const f = await fixture();
  let clocks = 0,
    calls = 0;
  const accepted = Date.parse(f.run.acceptedAt);
  const store = createWineStageStore(db, {
    now: () => new Date(++clocks === 1 ? accepted + 1 : accepted + 900000),
  });
  expect(
    await runWineStage(f.job, {
      store,
      execute: async () => {
        calls++;
        return extracted();
      },
    }),
  ).toMatchObject({ status: "stopped", code: "operation_deadline" });
  expect(calls).toBe(0);
});
