import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { db, extracted } from "./wine-research.integration-fixture.js";
import { createWineResearchHandler } from "./wine-research-handler.js";
import { runWineStage } from "./wine-enrichment-pipeline.js";
import { verifyQueueRequest, WINE_DOCUMENT_PATH } from "@wukong/jobs";
type Fixture = Awaited<ReturnType<typeof extracted>>;
function synthetic(
  f: Fixture,
  options: {
    empty?: boolean;
    unknown?: boolean;
    docs?: boolean;
    denied?: boolean;
    count?: number;
    unknownSlot?: string;
    afterSearch?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const execute = createWineResearchHandler({
    database: db,
    tavilyApiKey: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    queueSecret: "synthetic",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (String(url).includes("api.tavily.com")) {
        const slot = body.urls
          ? "extract_1"
          : body.search_depth === "advanced"
            ? "advanced_1"
            : body.query.includes("technical")
              ? "basic_2"
              : "basic_1";
        calls.push(slot);
        expect(
          await db.forWorkspace(f.workspaceId, (r) =>
            r.wineEnrichment.readSearchCall(f.run.id, slot),
          ),
        ).toMatchObject({ status: "started" });
        if (options.unknown || options.unknownSlot === slot)
          throw Error("synthetic lost response");
        await options.afterSearch?.();
        return Response.json({
          request_id: "synthetic",
          usage: { credits: slot === "advanced_1" ? 2 : 1 },
          results: body.urls
            ? body.urls.map((url: string) => ({
                url,
                raw_content: "Producer: Contrary Estate\nABV: 14 %",
              }))
            : options.empty
              ? []
              : Array.from({ length: options.count ?? 1 }, (_, i) => ({
                  url: `https://wine.test/${slot}/${i}`,
                  title: "Synthetic",
                  content:
                    "Producer: Unrelated Estate\nProduct: Unrelated bottle\nABV: 14 %",
                })),
          failed_results: [],
        });
      }
      calls.push("document");
      const headers = new Headers(init!.headers);
      expect(
        await verifyQueueRequest({
          secret: "synthetic",
          nowSeconds: Math.floor(Date.now() / 1000),
          timestamp: headers.get("x-wukong-timestamp")!,
          signature: headers.get("x-wukong-signature")!,
          path: WINE_DOCUMENT_PATH,
          body: String(init!.body),
        }),
      ).toBe(true);
      const source = (
        await db.forWorkspace(f.workspaceId, (r) =>
          r.wineEnrichment.readEvidence(f.run.id),
        )
      ).find((s) => s.id === body.sourceId)!;
      expect(source).toBeDefined();
      const text = options.docs
        ? "Producer: Fixture Estate\nProduct: Reserve Red\nABV: 13 %"
        : "";
      return Response.json({
        status: "completed",
        result: {
          ...body,
          schemaVersion: 1,
          state: options.denied ? "denied" : "ready",
          url: source.url,
          capturedAt: new Date().toISOString(),
          title: "Synthetic",
          text,
          documentDigest:
            "sha256:" + createHash("sha256").update(text).digest("hex"),
          truncated: false,
          spans: text
            ? [{ start: 0, end: text.length, location: "body:text" }]
            : [],
          warnings: [],
          extractEligible: !options.denied,
        },
      });
    },
  });
  return { execute, calls };
}
async function basic(
  f: Fixture,
  execute: ReturnType<typeof createWineResearchHandler>,
) {
  return runWineStage(
    { ...f.job, stage: "search_basic" },
    { store: f.store, execute },
  );
}
async function result(
  f: Fixture,
  stage: "search_basic" | "search_deep" = "search_basic",
) {
  const row = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.run.id, stage),
  );
  return (row!.output as any).result;
}
it("executes both basic slots once and returns every persisted photo, snippet and Node document", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  expect(await basic(f, s.execute)).toEqual({
    status: "advanced",
    nextStage: "verification",
  });
  expect(s.calls.filter((x) => x !== "document")).toEqual([
    "basic_1",
    "basic_2",
  ]);
  expect(await basic(f, s.execute)).toEqual({ status: "duplicate" });
  expect(s.calls.filter((x) => x !== "document")).toHaveLength(2);
  const r = await result(f),
    rows = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    );
  expect(r.evidence).toEqual(rows);
  expect(rows).toHaveLength(5);
  expect(r.partial).toBe(false);
  expect(r.issues.some((x: any) => x.blocking)).toBe(false);
});
it("keeps photo-only partial after successful empty searches", async () => {
  const f = await extracted(),
    s = synthetic(f, { empty: true });
  expect(await basic(f, s.execute)).toMatchObject({ status: "advanced" });
  expect(await result(f)).toMatchObject({
    partial: true,
    evidence: [{ kind: "photo" }],
  });
  expect(s.calls).toEqual(["basic_1", "basic_2"]);
});
it("stops unknown physical work without calling second search, document or Extract", async () => {
  const f = await extracted(),
    s = synthetic(f, { unknown: true });
  expect(await basic(f, s.execute)).toMatchObject({
    status: "blocked",
    code: "research_outcome_unknown",
  });
  expect(s.calls).toEqual(["basic_1"]);
  expect(await result(f)).toMatchObject({ state: "unknown" });
  const call = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readSearchCall(f.run.id, "basic_1"),
  );
  expect(call).toMatchObject({ status: "unknown", credits: null });
});
it("uses one eligible Extract batch of at most five persisted snippets with missing documents", async () => {
  const f = await extracted(),
    s = synthetic(f, { count: 5 });
  expect(await basic(f, s.execute)).toMatchObject({ status: "advanced" });
  expect(s.calls.filter((x) => x === "extract_1")).toHaveLength(1);
  const r = await result(f);
  expect(
    r.evidence.filter((x: any) => x.location.startsWith("tavily:extract_1")),
  ).toHaveLength(5);
  expect(r.evidence).toEqual(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  );
});
it("robots denial never authorizes Extract", async () => {
  const f = await extracted(),
    s = synthetic(f, { denied: true });
  expect(await basic(f, s.execute)).toMatchObject({ status: "advanced" });
  expect(s.calls).not.toContain("extract_1");
  expect((await result(f)).issues).toContainEqual(
    expect.objectContaining({ code: "document_denied", blocking: false }),
  );
});

import { readWineResearchEvidence } from "./wine-research-handler.js";
import { readWineExtractionContext } from "./wine-extraction-handler.js";
import { createWineCompleteEvidenceCache } from "./wine-complete-evidence-cache.js";

async function verify(f: Fixture, required: boolean, deep = false) {
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
it("reads current exact evidence and original extraction diagnostics without attaching query identity or trust", async () => {
  const f = await extracted({}, (value) => {
      value.identity = structuredClone(value.identity);
      value.evidence[0]!.identity!.status = "needs_confirmation";
      return value;
    }),
    s = synthetic(f, { docs: true });
  expect(await basic(f, s.execute)).toMatchObject({ status: "advanced" });
  const claim = await f.store.claim({ ...f.job, stage: "verification" });
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") throw Error("claim");
  const current = await readWineResearchEvidence(db, claim.context);
  expect(current.evidence).toEqual(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readEvidence(f.run.id),
    ),
  );
  expect(current.extraction.issues).toContainEqual(
    expect.objectContaining({
      code: "observation_identity_ambiguous",
      blocking: true,
    }),
  );
  expect((await result(f)).issues).toEqual(current.extraction.issues);
  expect(
    current.evidence
      .filter((s) => s.kind === "web")
      .every((s) => s.identity === null && s.trust === "unverified"),
  ).toBe(true);
  expect(current.extraction.context.identity.producer).toBe("Fixture Estate");
});
it("required deep performs actual advanced request and preserves basic pool", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await basic(f, s.execute);
  const before = (await result(f)).evidence;
  expect(await verify(f, true)).toMatchObject({
    status: "advanced",
    nextStage: "search_deep",
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "search_deep" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ status: "advanced", nextStage: "verification_deep" });
  expect(s.calls.filter((x) => x !== "document")).toEqual([
    "basic_1",
    "basic_2",
    "advanced_1",
  ]);
  const r = await result(f, "search_deep");
  expect(r.evidence).toEqual(expect.arrayContaining(before));
  expect(r.evidence).toHaveLength(7);
  expect(
    await runWineStage(
      { ...f.job, stage: "search_deep" },
      { store: f.store, execute: s.execute },
    ),
  ).toEqual({ status: "duplicate" });
});
it("complete cache hit issues no basic call but still performs currently required deep and preserves origin", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await basic(f, s.execute);
  await verify(f, false);
  const cache = createWineCompleteEvidenceCache({ database: db });
  expect(
    await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id }),
  ).toMatchObject({ status: "published" });
  const current = await extracted({ workspaceId: f.workspaceId }),
    t = synthetic(current, { docs: true });
  expect(await basic(current, t.execute)).toMatchObject({ status: "advanced" });
  expect(t.calls).toEqual([]);
  const b = await result(current);
  expect(b.cacheOrigin.runId).toBe(f.run.id);
  const old = (await result(f)).evidence.filter((x: any) => x.kind === "web");
  expect(b.evidence).toEqual(expect.arrayContaining(old));
  await verify(current, true);
  expect(
    await runWineStage(
      { ...current.job, stage: "search_deep" },
      { store: current.store, execute: t.execute },
    ),
  ).toMatchObject({ status: "advanced" });
  expect(t.calls.filter((x) => x !== "document")).toEqual(["advanced_1"]);
  expect((await result(current, "search_deep")).cacheOrigin).toEqual(
    b.cacheOrigin,
  );
  await verify(current, false, true);
  expect(
    await cache.publish({
      workspaceId: current.workspaceId,
      runId: current.run.id,
    }),
  ).toMatchObject({ status: "skipped" });
});
it("research mode bypasses a complete cache and incomplete prior research is not reused", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await basic(f, s.execute);
  await verify(f, false);
  const cache = createWineCompleteEvidenceCache({ database: db });
  await cache.publish({ workspaceId: f.workspaceId, runId: f.run.id });
  const current = await extracted({
      workspaceId: f.workspaceId,
      mode: "research",
    }),
    t = synthetic(current, { docs: true });
  await basic(current, t.execute);
  expect(t.calls.filter((x) => x !== "document")).toEqual([
    "basic_1",
    "basic_2",
  ]);
  expect((await result(current)).cacheOrigin).toBeUndefined();
  const partial = await extracted(),
    u = synthetic(partial, { empty: true });
  await basic(partial, u.execute);
  await verify(partial, false);
  expect(
    await cache.publish({
      workspaceId: partial.workspaceId,
      runId: partial.run.id,
    }),
  ).toMatchObject({ status: "skipped" });
  const retry = await extracted({ workspaceId: partial.workspaceId }),
    v = synthetic(retry, { docs: true });
  await basic(retry, v.execute);
  expect(v.calls.filter((x) => x !== "document")).toEqual([
    "basic_1",
    "basic_2",
  ]);
});
it("deep may use unused Extract for new missing documents and never spends it twice", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await basic(f, s.execute);
  await verify(f, true);
  const t = synthetic(f);
  await runWineStage(
    { ...f.job, stage: "search_deep" },
    { store: f.store, execute: t.execute },
  );
  expect(t.calls.filter((x) => x !== "document")).toEqual([
    "advanced_1",
    "extract_1",
  ]);
  const g = await extracted(),
    u = synthetic(g);
  await basic(g, u.execute);
  await verify(g, true);
  const v = synthetic(g);
  await runWineStage(
    { ...g.job, stage: "search_deep" },
    { store: g.store, execute: v.execute },
  );
  expect(v.calls.filter((x) => x !== "document")).toEqual(["advanced_1"]);
});
it("refuses forged dependencies and immutable run coordinates before network", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true }),
    claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("claim");
  const forged = structuredClone(claim.context);
  forged.run.inputRevision++;
  expect(await s.execute(forged)).toMatchObject({
    state: "blocked",
    code: "research_context_invalid",
  });
  const forgedDeps = structuredClone(claim.context);
  forgedDeps.dependencies[0]!.dependencyDigest = "bad";
  expect(await s.execute(forgedDeps)).toMatchObject({
    state: "blocked",
    code: "research_dependency_invalid",
  });
  expect(s.calls).toEqual([]);
});
it("cancelled started operation does not perform provider calls", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true }),
    claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("claim");
  await db.forWorkspace(f.workspaceId, (r) =>
    r.pipelineRuns.setOperationState(f.run.id, "cancelled", "synthetic"),
  );
  expect(await s.execute(claim.context)).toMatchObject({
    state: "blocked",
    code: "research_operation_stale",
  });
  expect(s.calls).toEqual([]);
});
it("deadline expiring after stage claim blocks work using the real DB clock", async () => {
  const f = await extracted({ duration: 2000 }),
    s = synthetic(f, { docs: true }),
    claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("claim");
  const end = Date.parse(
    (f.run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
  );
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, end - Date.now() + 30)),
  );
  expect(await s.execute(claim.context)).toMatchObject({
    state: "blocked",
    code: "research_deadline_or_stale",
  });
  expect(s.calls).toEqual([]);
});
it("persisted measured failed call yields partial with no later calls including required deep", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await db.forWorkspace(f.workspaceId, async (r) => {
    await r.wineEnrichment.beginSearchCall({
      runId: f.run.id,
      slot: "basic_1",
      requestDigest: "synthetic-definitive",
      maximumCredits: 1,
    });
    await r.wineEnrichment.finishSearchCall({
      runId: f.run.id,
      slot: "basic_1",
      requestDigest: "synthetic-definitive",
      maximumCredits: 1,
      status: "failed",
      credits: 0,
    });
  });
  expect(await basic(f, s.execute)).toMatchObject({ status: "advanced" });
  expect((await result(f)).partial).toBe(true);
  expect(s.calls).toEqual([]);
  await verify(f, true);
  expect(
    await runWineStage(
      { ...f.job, stage: "search_deep" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ status: "advanced" });
  expect((await result(f, "search_deep")).partial).toBe(true);
  expect(s.calls).toEqual([]);
});

it("deep preserves partial basic diagnostics even when fresh deep search succeeds", async () => {
  const f = await extracted(),
    s = synthetic(f, { denied: true });
  await basic(f, s.execute);
  expect((await result(f)).partial).toBe(true);
  await verify(f, true);
  const t = synthetic(f, { docs: true });
  expect(
    await runWineStage(
      { ...f.job, stage: "search_deep" },
      { store: f.store, execute: t.execute },
    ),
  ).toMatchObject({ status: "advanced" });
  expect((await result(f, "search_deep")).partial).toBe(true);
  expect(t.calls.filter((x) => x !== "document")).toEqual(["advanced_1"]);
});
it("unknown Extract stops and retains every prior source and the whole cost hold", async () => {
  const f = await extracted(),
    s = synthetic(f, { unknownSlot: "extract_1" });
  expect(await basic(f, s.execute)).toMatchObject({
    status: "blocked",
    code: "research_outcome_unknown",
  });
  expect(s.calls.filter((x) => x !== "document")).toEqual([
    "basic_1",
    "basic_2",
    "extract_1",
  ]);
  const rows = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  expect(rows).toHaveLength(3);
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readSearchCall(f.run.id, "extract_1"),
    ),
  ).toMatchObject({ status: "unknown", credits: null });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.searchBudgetReservations.settleFromCalls(f.run.id),
    ),
  ).toBe("unknown");
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.searchBudgetReservations.reserve({
        pipelineRunId: f.run.id,
        reservedCredits: 5,
        workspaceCapCredits: 100,
        policyVersion: "wine-enrichment@1",
      }),
    ),
  ).toMatchObject({ accepted: true, state: "unknown" });
});
it("cancellation during Search retains measured usage and starts no later callback or search", async () => {
  const f = await extracted(),
    s = synthetic(f, {
      docs: true,
      afterSearch: async () => {
        await db.forWorkspace(f.workspaceId, (r) =>
          r.pipelineRuns.setOperationState(f.run.id, "cancelled", "synthetic"),
        );
      },
    });
  expect(await basic(f, s.execute)).toMatchObject({ status: "stopped" });
  expect(s.calls).toEqual(["basic_1"]);
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readSearchCall(f.run.id, "basic_1"),
    ),
  ).toMatchObject({ status: "succeeded", credits: 1 });
});

it("started physical call cannot be hidden by research or cache and keeps unknown reservation", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.beginSearchCall({
      runId: f.run.id,
      slot: "basic_1",
      requestDigest: "synthetic-started",
      maximumCredits: 1,
    }),
  );
  expect(await basic(f, s.execute)).toMatchObject({
    status: "blocked",
    code: "research_outcome_unknown",
  });
  expect(s.calls).toEqual([]);
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.searchBudgetReservations.settleFromCalls(f.run.id),
    ),
  ).toBe("unknown");
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.searchBudgetReservations.reserve({
        pipelineRunId: f.run.id,
        reservedCredits: 5,
        workspaceCapCredits: 100,
        policyVersion: "wine-enrichment@1",
      }),
    ),
  ).toMatchObject({ state: "unknown" });
});
it("input revision change supersedes a claimed handler before work", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true }),
    claim = await f.store.claim({ ...f.job, stage: "search_basic" });
  if (claim.status !== "claimed") throw Error("claim");
  await db.forWorkspace(f.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.run.listingId,
        actorId: "test",
        expectedInputRevision: 1,
        baseVersionId: null,
        operationKey: "research-test-change",
        requestDigest: "research-test-change",
        note: "Changed input",
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
  expect(await s.execute(claim.context)).toMatchObject({
    state: "blocked",
    code: "research_operation_stale",
  });
  expect(s.calls).toEqual([]);
});
it("verification reader rejects omitted repository sources from an otherwise valid checkpoint", async () => {
  const f = await extracted(),
    s = synthetic(f, { docs: true });
  await basic(f, s.execute);
  const claim = await f.store.claim({ ...f.job, stage: "verification" });
  if (claim.status !== "claimed") throw Error("claim");
  const wrapped = {
    forWorkspace: async (workspaceId: string, callback: any) =>
      db.forWorkspace(workspaceId, (r) =>
        callback({
          ...r,
          wineEnrichment: {
            ...r.wineEnrichment,
            readEvidence: async (runId: string) =>
              (await r.wineEnrichment.readEvidence(runId)).filter(
                (source) => source.contentScope !== "snippet",
              ),
          },
        }),
      ),
  };
  await expect(
    readWineResearchEvidence(wrapped as any, claim.context),
  ).rejects.toThrow("research_evidence_checkpoint_invalid");
});
