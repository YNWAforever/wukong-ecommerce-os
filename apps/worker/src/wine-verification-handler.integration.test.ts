import { createDatabase, type Database } from "@wukong/db";
import { createWineStageStore } from "./wine-enrichment-runtime.js";
import { afterAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { db, extracted } from "./wine-research.integration-fixture.js";
import { createWineResearchHandler } from "./wine-research-handler.js";
import {
  createWineVerificationHandler,
  createWineVerificationCacheHook,
  createWineEvidenceStageHandlers,
} from "./wine-verification-handler.js";
import {
  runWineStage,
  parseWineStageResult,
  type WineStageContext,
} from "./wine-enrichment-pipeline.js";
import type { WineFrozenContext } from "@wukong/ai";
type VerificationPrompt = Pick<
  WineFrozenContext,
  "identity" | "sources" | "acceptedPremises" | "lockedFields"
>;
import type { WineSourceAuthority } from "@wukong/core";

import { createRequire } from "node:module";
const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
afterAll(async () => {
  await admin.end();
});
type F = Awaited<ReturnType<typeof extracted>>;
const label =
  "Kind: wine\nProducer: Fixture Estate\nProduct: Reserve Red\nVintage: 2020\nVolume: 750 ml\nPack quantity: 1\nMarket: HK";
async function setup(
  options: {
    abv?: boolean;
    market?: boolean;
    operator?: boolean;
    ambiguous?: boolean;
    domains?: string[];
    duration?: number;
  } = {},
) {
  return extracted(
    {
      operator: options.operator,
      domains: options.domains,
      duration: options.duration,
    },
    (v) => {
      if (options.abv === false) {
        v.identity.abvPercent = null;
        delete v.identity.observations.abvPercent;
      }
      if (options.market) {
        v.identity.marketVariant = "HK";
        v.identity.observations.marketVariant = {
          value: "HK",
          state: "observed",
          evidenceIds: [v.evidence[0]!.id],
        };
        v.evidence[0]!.excerpt += "\nHK";
      }
      if (options.ambiguous) v.identity.status = "needs_confirmation";
      v.evidence[0]!.identity = structuredClone(v.identity);
      return v;
    },
  );
}
async function researched(
  f: F,
  options: {
    docs?: Record<string, string>;
    empty?: boolean;
    count?: number;
    large?: boolean;
  } = {},
  stage: "search_basic" | "search_deep" = "search_basic",
) {
  const execute = createWineResearchHandler({
    database: db,
    tavilyApiKey: "synthetic",
    queueSecret: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    fetch: async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (String(url).includes("tavily.com"))
        return Response.json({
          request_id: "synthetic",
          usage: { credits: body.search_depth === "advanced" ? 2 : 1 },
          results: options.empty
            ? []
            : Object.keys(options.docs ?? { "wine.test": label }).flatMap(
                (domain) =>
                  Array.from({ length: options.count ?? 1 }, (_, index) => ({
                    url: `https://${domain}/product/${index}/${body.query.includes("technical") ? "second" : "first"}`,
                    title: "Fixture",
                    content: options.large
                      ? "lead ".repeat(3000)
                      : "Research lead",
                  })),
              ),
          failed_results: [],
        });
      const sources = await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readEvidence(f.run.id),
      );
      const s = sources.find((s) => s.id === body.sourceId)!;
      const text =
        (options.docs?.[s.domain!] ?? label) +
        (options.large ? "\n" + "content ".repeat(1850) : "");
      return Response.json({
        status: "completed",
        result: {
          ...body,
          schemaVersion: 1,
          state: "ready",
          url: s.url,
          capturedAt: new Date().toISOString(),
          title: "Fixture",
          text,
          documentDigest:
            "sha256:" + createHash("sha256").update(text).digest("hex"),
          truncated: false,
          spans: [{ start: 0, end: text.length, location: "body:text" }],
          warnings: [],
          extractEligible: true,
        },
      });
    },
  });
  expect(
    await runWineStage({ ...f.job, stage }, { store: f.store, execute }),
  ).toMatchObject({ status: "advanced" });
}
async function authority(f: F, domain = "wine.test", reliable = false) {
  const reviewer = randomUUID();
  await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values(${f.workspaceId},${reviewer},'reviewer')`;
  const value: WineSourceAuthority = {
    schemaVersion: 1,
    domain,
    subject: reliable
      ? { kind: "reliable_source", name: domain }
      : { kind: "producer", name: "Fixture Estate" },
    proofUrl: `https://${domain}/about`,
    proofDigest: "a".repeat(64),
    verifiedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    revokedAt: null,
    verifierId: reviewer,
  };
  await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.recordReviewedAuthority(reviewer, value),
  );
  return value;
}
function verifier(
  f: F,
  options: {
    needsDeepSearch?: boolean;
    beforeResponse?: () => Promise<void>;
    unknown?: boolean;
    mutate?: (v: Record<string, unknown>, request: VerificationPrompt) => void;
  } = {},
) {
  let calls = 0;
  const requests: VerificationPrompt[] = [];
  const execute = createWineVerificationHandler({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    transport: {
      fetch: async (_url, init) => {
        calls++;
        const request = JSON.parse(
          JSON.parse(String(init!.body)).messages[1].content,
        );
        requests.push(request);
        // An independent transaction must see the physical reservation before HTTP.
        const rows =
          await admin`select status,stage from ai_runs where pipeline_run_id=${f.run.id}`;
        expect(
          rows.some(
            (row: { status: string; stage: string }) =>
              row.status === "started" &&
              ["verification", "verification_deep"].includes(String(row.stage)),
          ),
        ).toBe(true);
        if (options.unknown) throw Error("lost synthetic response");
        await options.beforeResponse?.();
        const value: Record<string, unknown> = {
          schemaVersion: 1,
          candidates: [],
          claims: [],
          supportProposals: [],
          needsDeepSearch: options.needsDeepSearch ?? false,
          issues: [],
        };
        options.mutate?.(value, request);
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
      },
    },
  });
  return { execute, requests, calls: () => calls };
}
async function stored(
  f: F,
  stage: "verification" | "verification_deep" = "verification",
) {
  const row = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.run.id, stage),
  );
  const result = parseWineStageResult(
    (row!.output as { result: unknown }).result,
    stage,
  );
  if (
    result.state !== "succeeded" ||
    (result.stage !== "verification" && result.stage !== "verification_deep")
  )
    throw Error(JSON.stringify(result));
  return result;
}
it("uses complete photo facts independent of model omissions and ignores optional model search requests", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f, {
    needsDeepSearch: true,
    mutate: (v) => {
      v.issues = [
        {
          path: "brand_background",
          code: "conflict",
          blocking: true,
          evidenceIds: [],
        },
      ];
    },
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toEqual({ status: "advanced", nextStage: "generation" });
  const out = await stored(f);
  expect(out.deepSearchReasons).toEqual([]);
  expect(out.claims).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "volumeMl",
        value: 750,
        state: "accepted",
      }),
      expect.objectContaining({
        field: "abvPercent",
        value: 13,
        state: "accepted",
      }),
    ]),
  );
  expect(out.issues.some((i) => i.blocking)).toBe(false);
  expect(s.requests[0]!.acceptedPremises.length).toBeGreaterThan(3);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toEqual({ status: "duplicate" });
  expect(s.calls()).toBe(1);
});
it("accepts fresh precise official supplemental facts from independently parsed full documents", async () => {
  const f = await setup({ abv: false, market: true });
  await authority(f);
  await researched(f, { docs: { "wine.test": label + "\nABV: 13 %" } });
  const s = verifier(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ nextStage: "generation" });
  expect((await stored(f)).claims).toContainEqual(
    expect.objectContaining({
      field: "abvPercent",
      value: 13,
      state: "accepted",
      reason: "authoritative_support",
    }),
  );
  expect(s.requests[0]!.sources.some((s) => s.contentScope === "snippet")).toBe(
    true,
  );
});
it("missing ABV requests only one deep pass and remains nonblocking when still missing", async () => {
  const f = await setup({ abv: false });
  await researched(f, { empty: true });
  const s = verifier(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ nextStage: "search_deep" });
  expect((await stored(f)).deepSearchReasons).toEqual(["core_fact_gap"]);
  await researched(f, { empty: true }, "search_deep");
  expect(
    await runWineStage(
      { ...f.job, stage: "verification_deep" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ nextStage: "generation" });
  const out = await stored(f, "verification_deep");
  expect(out.needsDeepSearch).toBe(false);
  expect(out.issues.some((i) => i.blocking)).toBe(false);
  expect(s.calls()).toBe(2);
});
it("retains contrary applicable official facts omitted by the model and blocks completion after bounded deep", async () => {
  const f = await setup({ market: true });
  await authority(f);
  await researched(f, { docs: { "wine.test": label + "\nABV: 14 %" } });
  const s = verifier(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ nextStage: "search_deep" });
  expect((await stored(f)).deepSearchReasons).toContain("conflict");
  await researched(f, { empty: true }, "search_deep");
  await runWineStage(
    { ...f.job, stage: "verification_deep" },
    { store: f.store, execute: s.execute },
  );
  const out = await stored(f, "verification_deep");
  expect(out.issues.some((i) => i.blocking)).toBe(true);
  expect(out.needsDeepSearch).toBe(false);
  expect(
    out.claims
      .filter((c) => c.field === "abvPercent")
      .every((c) => c.state !== "accepted"),
  ).toBe(true);
});
it("publishes only after the actual no-deep checkpoints commit and recovers idempotently", async () => {
  const f = await setup();
  await researched(f);
  const s = verifier(f);
  const afterCommit = createWineVerificationCacheHook({ database: db });
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute, afterCommit },
    ),
  ).toEqual({ status: "advanced", nextStage: "generation" });
  const copy = await extracted({ workspaceId: f.workspaceId });
  let transports = 0;
  const research = createWineResearchHandler({
    database: db,
    tavilyApiKey: "synthetic",
    queueSecret: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    fetch: async () => {
      transports++;
      throw Error("cache miss");
    },
  });
  expect(
    await runWineStage(
      { ...copy.job, stage: "search_basic" },
      { store: copy.store, execute: research },
    ),
  ).toMatchObject({ status: "advanced" });
  expect(transports).toBe(0);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute, afterCommit },
    ),
  ).toEqual({ status: "duplicate" });
  expect(s.calls()).toBe(1);
});

it("requires the exact frozen verification artifact at the real semantic handoff", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f);
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  const out = await stored(f);
  expect(out.frozenVerification).toMatchObject({
    binding: {
      workspaceId: f.workspaceId,
      operationId: f.run.id,
      inputRevision: f.run.inputRevision,
    },
  });
  expect(
    out.frozenVerification!.acceptedPremises.every(
      (c) => c.state === "accepted" && c.kind === "fact",
    ),
  ).toBe(true);
});
it.each(["binding", "future", "before", "source", "premise"])(
  "frozen verification rejects foreign binding, invalid clock and substituted evidence at committed finish (%s)",
  async (corruption) => {
    const f = await setup();
    await researched(f, { empty: true });
    const s = verifier(f);
    const delivery = await runWineStage(
      { ...f.job, stage: "verification" },
      {
        store: f.store,
        execute: async (c) => {
          const out = await s.execute(c);
          if (
            out.state !== "succeeded" ||
            out.stage !== "verification" ||
            !out.frozenVerification
          )
            throw Error("fixture");
          if (corruption === "binding")
            out.frozenVerification.binding.operationId = crypto.randomUUID();
          if (corruption === "future")
            out.frozenVerification.now = new Date(
              Date.now() + 60000,
            ).toISOString();
          if (corruption === "before")
            out.frozenVerification.now = "2000-01-01T00:00:00.000Z";
          if (corruption === "source")
            out.frozenVerification.sources[0]!.capturedAt =
              new Date().toISOString();
          if (corruption === "premise")
            out.frozenVerification.acceptedPremises[0]!.value = "forged";
          return out;
        },
      },
    );
    expect(delivery).toMatchObject({
      status: "blocked",
      code: "verification_binding_mismatch",
    });
  },
);

it.each([false, true])(
  "accepts two independently reviewed agreeing full sources, but not copied excerpts (%s)",
  async (copied) => {
    const f = await setup({
      abv: false,
      market: true,
      domains: ["wine.test", "second.test"],
    });
    await authority(f, "wine.test", true);
    await authority(f, "second.test", true);
    await researched(f, {
      docs: {
        "wine.test": label + "\nABV: 13 %",
        "second.test":
          label +
          "\nABV: 13 %" +
          (copied ? "" : "\nIndependent laboratory statement"),
      },
    });
    const s = verifier(f);
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    );
    expect(
      (await stored(f)).claims.some(
        (c) => c.field === "abvPercent" && c.state === "accepted",
      ),
    ).toBe(!copied);
  },
);
it("wrong page identity and unrelated equal numbers cannot fill a missing core fact", async () => {
  const f = await setup({ abv: false, market: true });
  await authority(f);
  await researched(f, {
    docs: {
      "wine.test":
        label.replace("Reserve Red", "Unrelated White") +
        "\nInventory: 13\nABV: 13 %",
    },
  });
  const s = verifier(f);
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  const out = await stored(f);
  expect(out.deepSearchReasons).toEqual(["core_fact_gap"]);
  expect(
    out.claims.some((c) => c.field === "abvPercent" && c.state === "accepted"),
  ).toBe(false);
  expect(out.issues.some((i) => i.blocking)).toBe(false);
});
it.each([false, true])(
  "low trust contrary sources and official wrong variants remain nonblocking with complete photo facts (%s)",
  async (variant) => {
    const f = await setup({ market: true });
    if (variant) await authority(f);
    await researched(f, {
      docs: {
        "wine.test":
          (variant ? label.replace("2020", "2019") : label) + "\nABV: 14 %",
      },
    });
    const s = verifier(f);
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    );
    const out = await stored(f);
    expect(out.needsDeepSearch).toBe(false);
    expect(out.issues.some((i) => i.blocking)).toBe(false);
    expect(out.claims).toContainEqual(
      expect.objectContaining({
        field: "abvPercent",
        value: 13,
        state: "accepted",
      }),
    );
  },
);
it("preserves original extraction ambiguity diagnostics and observation capture time", async () => {
  const f = await setup({ ambiguous: true });
  await researched(f);
  const original = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.run.id, "extraction"),
  );
  const s = verifier(f);
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  const out = await stored(f);
  const extraction = parseWineStageResult(
    (original!.output as { result: unknown }).result,
    "extraction",
  );
  if (extraction.state !== "succeeded" || extraction.stage !== "extraction")
    throw Error("fixture");
  expect(out.issues).toEqual(expect.arrayContaining(extraction.issues));
  expect(out.identity.status).toBe("needs_confirmation");
  expect(out.deepSearchReasons).toContain("identity_gap");
  expect(
    out.frozenVerification!.sources.find((s) => s.kind === "photo")!.capturedAt,
  ).toBe(extraction.observedAt);
});
it("uses accepted operator locks and never promotes operator-owned facts", async () => {
  const f = await setup({ operator: true });
  await researched(f, { empty: true });
  const s = verifier(f);
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  const out = await stored(f);
  expect(out.frozenVerification!.lockedFields).toContain("producer");
  expect(
    out.claims
      .filter((c) => c.field === "producer")
      .every((c) => c.state === "rejected" && c.reason === "operator_locked"),
  ).toBe(true);
});
it("unknown Go response holds the reservation and duplicate delivery never replays", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f, { unknown: true });
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ status: "blocked", code: "verification_outcome_unknown" });
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  expect(s.calls()).toBe(1);
  const rows =
    await admin`select state from ai_budget_reservations where pipeline_run_id=${f.run.id}`;
  expect(rows[0]!.state).toBe("unknown");
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.run.id, "generation"),
    ),
  ).toBeNull();
});
it("started checkpoint duplicates do not call Go", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f);
  expect(
    (await f.store.claim({ ...f.job, stage: "verification" })).status,
  ).toBe("claimed");
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ status: "blocked", code: "stage_outcome_unknown" });
  expect(s.calls()).toBe(0);
});
it("cancellation and revision supersession during Go persist no fresh verification or next outbox", async () => {
  for (const kind of ["cancel", "revision"]) {
    const f = await setup();
    await researched(f, { empty: true });
    const s = verifier(f, {
      beforeResponse: async () => {
        if (kind === "cancel")
          await admin`update listing_pipeline_runs set execution_state='cancelled' where id=${f.run.id}`;
        else
          await admin`update listing_drafts set input_revision=input_revision+1 where id=${f.run.listingId}`;
      },
    });
    const out = await runWineStage(
      { ...f.job, stage: "verification" },
      {
        store: f.store,
        execute: s.execute,
        afterCommit: createWineVerificationCacheHook({ database: db }),
      },
    );
    expect(out.status).not.toBe("advanced");
    expect(s.calls()).toBe(1);
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.run.id, "verification"),
    );
    expect(row!.output).toMatchObject({ fresh: false });
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.run.id, "generation"),
      ),
    ).toBeNull();
  }
});
it("cache hook refuses a precommit artifact and publishes after required deep commits", async () => {
  const f = await setup({ abv: false });
  await researched(f);
  const s = verifier(f);
  const hook = createWineVerificationCacheHook({ database: db });
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute, afterCommit: hook },
  );
  await researched(f, {}, "search_deep");
  const claim = await f.store.claim({ ...f.job, stage: "verification_deep" });
  if (claim.status !== "claimed") throw Error("claim");
  const result = await s.execute(claim.context);
  if (result.state !== "succeeded") throw Error("result");
  expect(await hook({ context: claim.context, result })).toEqual({
    code: "post_commit_skipped",
  });
  expect(await f.store.finish(claim.context, result)).toMatchObject({
    nextStage: "generation",
  });
  expect(await hook({ context: claim.context, result })).toBeUndefined();
  const rows =
    await admin`select snapshot_id from wine_evidence_cache where workspace_id=${f.workspaceId}`;
  expect(rows.length).toBeGreaterThan(0);
});
it("composition explicitly blocks ownership-dependent generation and quality", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f);
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  const handlers = createWineEvidenceStageHandlers({
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => {
      throw Error("unexpected");
    },
    tavilyApiKey: "synthetic",
    queueSecret: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "generation" },
      { store: f.store, ...handlers },
    ),
  ).toMatchObject({
    status: "blocked",
    code: "generation_ownership_unavailable",
  });
  const context = {
    schemaVersion: 1 as const,
    job: { ...f.job, stage: "quality_check" as const },
    run: f.run,
    dependencyDigest: "",
    dependencies: [],
  };
  expect(await handlers.execute(context)).toMatchObject({
    state: "blocked",
    code: "quality_handler_unavailable",
  });
});
it("cache publication failure diagnostics cannot block committed next stage", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      {
        store: f.store,
        execute: s.execute,
        afterCommit: createWineVerificationCacheHook({ database: db }),
      },
    ),
  ).toMatchObject({
    status: "advanced",
    nextStage: "generation",
    postCommitDiagnostic: { code: "post_commit_skipped" },
  });
});
it("rejects current registry changes during verification without a second model call", async () => {
  const f = await setup({ abv: false, market: true });
  await researched(f, { docs: { "wine.test": label + "\nABV: 13 %" } });
  const s = verifier(f, {
    beforeResponse: async () => {
      await authority(f);
    },
  });
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      { store: f.store, execute: s.execute },
    ),
  ).toMatchObject({ status: "blocked", code: "verification_context_changed" });
  expect(s.calls()).toBe(1);
});
it("derived recommendations use independently accepted current-run factual premises", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const recommendationId = randomUUID();
  const s = verifier(f, {
    mutate: (v, request) => {
      const premise = request.acceptedPremises.find(
        (c) => c.field === "abvPercent",
      );
      v.claims = [
        {
          id: recommendationId,
          field: "serving",
          value: "Serve slightly chilled",
          kind: "recommendation",
          scope: "product",
          evidenceIds: [],
          premiseClaimIds: [premise!.id],
        },
      ];
    },
  });
  await runWineStage(
    { ...f.job, stage: "verification" },
    { store: f.store, execute: s.execute },
  );
  const out = await stored(f);
  const recommendation = out.claims.find((c) => c.id === recommendationId)!;
  expect(recommendation).toMatchObject({
    state: "accepted",
    reason: "grounded_recommendation",
  });
  expect(recommendation.evidenceIds.length).toBeGreaterThan(0);
  expect(
    out.frozenVerification!.acceptedPremises.some((c) =>
      recommendation.premiseClaimIds.includes(c.id),
    ),
  ).toBe(true);
});

it("expired DB deadline after claim prevents physical verification admission", async () => {
  const f = await setup({ duration: 4000 });
  await researched(f, { empty: true });
  const claim = await f.store.claim({ ...f.job, stage: "verification" });
  if (claim.status !== "claimed") throw Error("fixture");
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Date.parse(f.run.acceptedAt) + 4050 - Date.now()),
    ),
  );
  const s = verifier(f);
  expect(await s.execute(claim.context)).toMatchObject({
    state: "blocked",
    code: "research_deadline_or_stale",
  });
  expect(s.calls()).toBe(0);
});
it("runtime commit rejects a registry changed after executor returns", async () => {
  const f = await setup();
  await researched(f, { empty: true });
  const s = verifier(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      {
        store: f.store,
        execute: async (c) => {
          const result = await s.execute(c);
          await authority(f);
          return result;
        },
      },
    ),
  ).toMatchObject({ status: "blocked", code: "verification_binding_mismatch" });
});

it("oversized complete cache is diagnostic only and retains the entire pool", async () => {
  const f = await setup();
  await researched(f, { count: 5, large: true });
  const s = verifier(f);
  expect(
    await runWineStage(
      { ...f.job, stage: "verification" },
      {
        store: f.store,
        execute: s.execute,
        afterCommit: createWineVerificationCacheHook({ database: db }),
      },
    ),
  ).toMatchObject({
    status: "advanced",
    nextStage: "generation",
    postCommitDiagnostic: { code: "post_commit_oversized" },
  });
  const sources = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readEvidence(f.run.id),
  );
  expect(sources.filter((s) => s.kind === "web")).toHaveLength(20);
  expect((await stored(f)).frozenVerification!.sources).toHaveLength(
    sources.length,
  );
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function taggedDatabase(name: string) {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set("application_name", name);
  return createDatabase(url.toString(), { maxConnections: 1 });
}
async function blockedBy(
  waiter: string,
  holder: string,
  completed: () => boolean,
) {
  for (let probe = 0; probe < 100 && !completed(); probe++) {
    const rows =
      await admin`select w.pid,pg_blocking_pids(w.pid) blockers,h.pid holder from pg_stat_activity w cross join pg_stat_activity h where w.application_name=${waiter} and h.application_name=${holder}`;
    if (
      rows.some((row: { blockers: number[]; holder: number }) =>
        row.blockers.includes(row.holder),
      )
    )
      return true;
  }
  return false;
}
it("registry revocation waits for the verification transaction after comparison through COMMIT", async () => {
  const f = await setup();
  const active = await authority(f);
  await researched(f, { empty: true });
  const s = verifier(f);
  const claim = await f.store.claim({ ...f.job, stage: "verification" });
  if (claim.status !== "claimed") throw Error("claim");
  const output = await s.execute(claim.context);
  const finishTag = `wine-finish-${randomUUID()}`,
    writerTag = `wine-revoke-${randomUUID()}`,
    finishDb = taggedDatabase(finishTag),
    writerDb = taggedDatabase(writerTag);
  const atTerminal = signal(),
    release = signal();
  let writerDone = false;
  const wrapped: Pick<Database, "forWorkspace"> = {
    forWorkspace: (ws, work) =>
      finishDb.forWorkspace(ws, (r) =>
        work({
          ...r,
          wineEnrichment: {
            ...r.wineEnrichment,
            finishStage: async (input) => {
              atTerminal.resolve();
              await release.promise;
              return r.wineEnrichment.finishStage(input);
            },
          },
        }),
      ),
  };
  const finishing = createWineStageStore(wrapped).finish(claim.context, output);
  await Promise.race([
    atTerminal.promise,
    finishing.then(() => {
      throw Error("finish bypassed terminal barrier");
    }),
  ]);
  const revoking = writerDb
    .forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.recordReviewedAuthority(active.verifierId, {
        ...active,
        revokedAt: new Date().toISOString(),
      }),
    )
    .finally(() => {
      writerDone = true;
    });
  try {
    expect(await blockedBy(writerTag, finishTag, () => writerDone)).toBe(true);
    const persisted =
      await admin`select state from wine_stages where run_id=${f.run.id} and stage='verification'`;
    expect(persisted[0]!.state).toBe("started");
  } finally {
    release.resolve();
    await Promise.all([finishing, revoking]);
    await Promise.all([finishDb.close(), writerDb.close()]);
  }
  expect(await finishing).toMatchObject({ status: "advanced" });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readAuthorities(),
    ),
  ).toHaveLength(2);
});
it("registry revocation committed first makes waiting verification finish reject", async () => {
  const f = await setup();
  const active = await authority(f);
  await researched(f, { empty: true });
  const s = verifier(f);
  const claim = await f.store.claim({ ...f.job, stage: "verification" });
  if (claim.status !== "claimed") throw Error("claim");
  const output = await s.execute(claim.context);
  const finishTag = `wine-finish-${randomUUID()}`,
    writerTag = `wine-revoke-${randomUUID()}`,
    finishDb = taggedDatabase(finishTag),
    writerDb = taggedDatabase(writerTag);
  const inserted = signal(),
    release = signal();
  let finished = false;
  const revoking = writerDb.forWorkspace(f.workspaceId, async (r) => {
    await r.wineEnrichment.recordReviewedAuthority(active.verifierId, {
      ...active,
      revokedAt: new Date().toISOString(),
    });
    inserted.resolve();
    await release.promise;
  });
  await Promise.race([
    inserted.promise,
    revoking.then(() => {
      throw Error("writer bypassed insert barrier");
    }),
  ]);
  const finishing = createWineStageStore(finishDb)
    .finish(claim.context, output)
    .finally(() => {
      finished = true;
    });
  try {
    expect(await blockedBy(finishTag, writerTag, () => finished)).toBe(true);
  } finally {
    release.resolve();
    await Promise.all([finishing, revoking]);
    await Promise.all([finishDb.close(), writerDb.close()]);
  }
  expect(await finishing).toMatchObject({
    status: "blocked",
    code: "verification_binding_mismatch",
  });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.run.id, "generation"),
    ),
  ).toBeNull();
});
