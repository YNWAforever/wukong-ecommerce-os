import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  wineCopyDependencyDigest,
  buildWineCopySnapshot,
  readAdoptedWineDependencies,
  resolveWineGenerationOwnership,
  listingInputDigest,
  WINE_STAGE_ORDER,
  wineStageOrder,
  wineStageDependencyDigest,
  type WorkspaceRepositories,
  type Database,
  type StageRecord,
} from "@wukong/db";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
  workingListingSchema,
  emptyWorkingListing,
} from "@wukong/core";
import { createWineGenerationHandler } from "./wine-generation-handler.js";
import type {
  WineGenerationRequest,
  WineGenerationCandidate,
  WineStage,
} from "@wukong/core";
import { db, extracted } from "./wine-research.integration-fixture.js";
import { createWineEvidenceStageHandlers } from "./wine-verification-handler.js";
import { createWineStageStore } from "./wine-enrichment-runtime.js";
import { projectWineCandidate } from "./wine-candidate-projection.js";
import {
  runWineStage,
  parseWineStageResult,
} from "./wine-enrichment-pipeline.js";
const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
afterAll(async () => {
  await admin.end();
});
const profile = {
  tone: "calm and precise",
  claimPolicy: ["Use accepted facts only"],
};
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
function candidate(request: WineGenerationRequest): WineGenerationCandidate {
  const claim = request.claims.find((c) => c.field === "volumeMl")!;
  const text = {
    en: "Presented in a 750 ml bottle, this wine is ready for your table.",
    "zh-Hant": "這款葡萄酒的瓶裝容量為 750 毫升。",
  };
  const metadata = { en: "750 ml bottle", "zh-Hant": "750 毫升瓶裝" };
  return {
    schemaVersion: 1,
    content: {
      title: metadata,
      seo: { title: metadata, description: metadata },
      tags: [],
      sections: [
        {
          key: "introduction",
          ...text,
          claimIds: [claim.id],
          owner: "automatic",
          locked: false,
        },
      ],
    },
    annotations: (["en", "zh-Hant"] as const).flatMap((lang) =>
      ["title", "seo.title", "seo.description", "sections.introduction"].map(
        (path) => ({
          path: `${path}.${lang}`,
          span: path === "sections.introduction" ? text[lang] : metadata[lang],
          claimId: claim.id,
          value: claim.value,
          evidenceIds: claim.evidenceIds,
          premiseClaimIds: claim.premiseClaimIds,
        }),
      ),
    ),
  };
}
async function setup(
  mode: "full" | "research" = "full",
  blocking = false,
  workingContent?: ReturnType<typeof emptyWorkingListing>,
  baseContent?: import("@wukong/core").ReviewableListing,
  deep = false,
) {
  const f = await extracted(
    { mode, profile, workingContent, baseContent },
    (value) => {
      if (deep) {
        value.identity.abvPercent = null;
        delete value.identity.observations.abvPercent;
        value.evidence[0]!.excerpt = value.evidence[0]!.excerpt.replace(
          "13 %",
          "",
        );
        value.evidence[0]!.identity = structuredClone(value.identity);
      }
      return value;
    },
  );
  let executing: WineStage = "verification";
  const control: {
    clock?: Date;
    beforeResponse?: (stage: string) => Promise<void>;
    unknownStage?: string;
    repairStage?: string;
    mutateCandidate?: (
      value: WineGenerationCandidate,
      request: WineGenerationRequest,
    ) => void;
  } = {};
  const calls: string[] = [];
  const requests: WineGenerationRequest[] = [];
  const config = {
    database: db,
    env: { OPENCODE_GO_API_KEY: "synthetic" },
    resolveImage: async () => {
      throw Error("already extracted");
    },
    tavilyApiKey: "synthetic",
    queueSecret: "synthetic",
    websiteFetchBaseUrl: "https://callback.test",
    fetch: async () =>
      Response.json({
        request_id: "synthetic",
        usage: { credits: 1 },
        results: [],
        failed_results: [],
      }),
    transport: {
      fetch: async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = JSON.parse(String(init!.body));
        const value = JSON.parse(body.messages[1].content);
        const stage = value.candidate
          ? "quality_check"
          : value.claims
            ? "generation"
            : executing;
        calls.push(stage);
        if (control.unknownStage === stage)
          throw Error("lost synthetic response");
        await control.beforeResponse?.(stage);
        if (
          control.repairStage === stage &&
          calls.filter((s) => s === stage).length === 1
        )
          return response({ invalid: true });
        const rows =
          await admin`select status,stage from ai_runs where pipeline_run_id=${value.binding?.operationId ?? value.request?.binding?.operationId ?? f.job.runId}`;
        expect(
          rows.some(
            (r: { status: string; stage: string }) =>
              r.status === "started" && r.stage === stage,
          ),
        ).toBe(true);
        if (stage === "generation") {
          requests.push(value);
          const proposed = candidate(value);
          control.mutateCandidate?.(proposed, value);
          return response(proposed);
        }
        if (stage === "quality_check")
          return response({
            schemaVersion: 1,
            issues: blocking
              ? [
                  {
                    path: "sections.introduction.en",
                    code: "semantic_entailment",
                    blocking: true,
                    evidenceIds: [],
                  },
                ]
              : [],
          });
        return response({
          schemaVersion: 1,
          candidates: [],
          claims: [],
          supportProposals: [],
          needsDeepSearch: false,
          issues: [],
        });
      },
    },
  };
  const handlers = createWineEvidenceStageHandlers(config);
  const store = createWineStageStore(db, {
    projectCandidate: projectWineCandidate,
    now: () => control.clock ?? new Date(),
  });
  const run = async (stage: WineStage) => {
    executing = stage;
    const result = await runWineStage(
      { ...f.job, stage },
      { store, ...handlers },
    );
    return result;
  };
  expect(await run("search_basic")).toMatchObject({ status: "advanced" });
  expect(await run("verification")).toMatchObject({
    status: "advanced",
    nextStage: deep ? "search_deep" : "generation",
  });
  if (deep) {
    expect(await run("search_deep")).toMatchObject({ status: "advanced" });
    expect(await run("verification_deep")).toMatchObject({
      nextStage: "generation",
    });
  }
  return { ...f, run, calls, requests, handlers, store, config, control };
}
it.each(["full", "research"] as const)(
  "generates bilingual prose, mandatory quality and real projection for %s",
  async (mode) => {
    const f = await setup(mode);
    expect(await f.run("generation")).toMatchObject({
      status: "advanced",
      nextStage: "quality_check",
    });
    expect(f.requests[0]).toMatchObject({
      ...profile,
      section: null,
      ownership: { priorKind: "empty" },
    });
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.job.runId, "generation"),
    );
    const g = parseWineStageResult(
      (row!.output as { result: unknown }).result,
      "generation",
    );
    if (g.state !== "succeeded" || g.stage !== "generation")
      throw Error("generation failed");
    expect(g.frozenQuality!.request).toEqual(f.requests[0]);
    expect(g.frozenQuality!.candidate).toEqual(candidate(f.requests[0]!));
    expect(await f.run("generation")).toEqual({ status: "duplicate" });
    expect(await f.run("quality_check")).toMatchObject({
      status: "advanced",
      nextStage: "commit_candidate",
    });
    expect(await f.run("quality_check")).toEqual({ status: "duplicate" });
    expect(await f.run("commit_candidate")).toMatchObject({
      status: "completed",
      outcome: "complete",
    });
    const review = await db.forWorkspace(f.workspaceId, (r) =>
      r.listings.getReviewSnapshot(f.job.draftId),
    );
    expect(review!.activeVersion!.content.description.en).toContain(
      "750 ml bottle",
    );
    expect(review!.activeVersion!.content.description["zh-Hant"]).toContain(
      "750 毫升",
    );
    expect(f.calls).toEqual(["verification", "generation", "quality_check"]);
  },
);
it("preserves semantic blocking issues and reaches needs_info without rewrite", async () => {
  const f = await setup("full", true);
  expect(await f.run("generation")).toMatchObject({ status: "advanced" });
  expect(await f.run("quality_check")).toMatchObject({ status: "advanced" });
  const row = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.job.runId, "quality_check"),
  );
  expect((row!.output as { result: unknown }).result).toMatchObject({
    outcome: "needs_info",
    issues: [{ code: "semantic_entailment", blocking: true }],
  });
  expect(await f.run("commit_candidate")).toMatchObject({
    status: "completed",
    outcome: "needs_info",
  });
  expect(f.calls).toEqual(["verification", "generation", "quality_check"]);
});
it.each(["generation", "quality_check"] as const)(
  "unknown %s response holds usage and never repeats",
  async (stage) => {
    const f = await setup();
    if (stage === "quality_check") await f.run("generation");
    f.control.unknownStage = stage;
    expect(await f.run(stage)).toMatchObject({
      status: "blocked",
      code: "generation_outcome_unknown",
    });
    await f.run(stage);
    expect(f.calls.filter((s) => s === stage)).toHaveLength(1);
    expect(
      (
        await admin`select state from ai_budget_reservations where pipeline_run_id=${f.job.runId}`
      )[0].state,
    ).toBe("unknown");
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(
          f.job.runId,
          stage === "generation" ? "quality_check" : "commit_candidate",
        ),
      ),
    ).toBeNull();
  },
);
it.each(["generation", "quality_check"] as const)(
  "only reviewed schema repair may make a second physical %s call",
  async (stage) => {
    const f = await setup();
    if (stage === "quality_check") await f.run("generation");
    f.control.repairStage = stage;
    expect(await f.run(stage)).toMatchObject({ status: "advanced" });
    expect(f.calls.filter((s) => s === stage)).toHaveLength(2);
    await f.run(stage);
    expect(f.calls.filter((s) => s === stage)).toHaveLength(2);
  },
);
it.each(["cancel", "revision", "deadline"] as const)(
  "%s during generation preserves candidate inspection but starts no quality",
  async (kind) => {
    const f = await setup();
    const acceptedRun = await db.forWorkspace(f.workspaceId, (r) =>
      r.pipelineRuns.getOperation(f.job.runId),
    );
    const controlClock = () => {
      f.control.clock = new Date(Date.parse(acceptedRun!.acceptedAt) + 900001);
    };
    f.control.beforeResponse = async (stage) => {
      if (stage !== "generation") return;
      if (kind === "cancel")
        await db.forWorkspace(f.workspaceId, (r) =>
          r.pipelineRuns.setOperationState(f.job.runId, "cancelled"),
        );
      if (kind === "revision")
        await admin`update listing_drafts set input_revision=input_revision+1 where id=${f.job.draftId}`;
      if (kind === "deadline") controlClock();
    };
    expect((await f.run("generation")).status).toBe("stopped");
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.job.runId, "generation"),
    );
    expect(row!.output).toMatchObject({
      fresh: false,
      result: {
        state: "succeeded",
        frozenQuality: {
          candidate: { content: { sections: expect.any(Array) } },
        },
      },
    });
    await f.run("quality_check");
    expect(f.calls).toEqual(["verification", "generation"]);
  },
);
// Rehashed repository-view corruption is deliberately stronger than a changed digest alone.
async function corrupted(
  f: Awaited<ReturnType<typeof setup>>,
  stage: "generation" | "quality_check" | "commit_candidate",
  mutate: (stage: WineStage, result: any) => void,
) {
  const claim = await f.store.claim({ ...f.job, stage });
  if (claim.status !== "claimed") throw Error(JSON.stringify(claim));
  const context = structuredClone(claim.context),
    rows: StageRecord[] = [];
  const order = wineStageOrder(context.run.execution.wineMode);
  for (const name of order.slice(0, order.indexOf(stage) + 1)) {
    const row = structuredClone(
      (await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.job.runId, name),
      ))!,
    );
    mutate(name, (row.output as { result?: unknown })?.result);
    row.dependencyDigest = wineStageDependencyDigest(context.run, rows);
    rows.push(row);
  }
  context.dependencies = rows.slice(0, -1);
  context.dependencyDigest = rows.at(-1)!.dependencyDigest;
  const wrap = (r: WorkspaceRepositories): WorkspaceRepositories => ({
    ...r,
    wineEnrichment: {
      ...r.wineEnrichment,
      readStage: async (_id, name) =>
        _id === context.run.id
          ? (rows.find((row) => row.stage === name) ?? null)
          : r.wineEnrichment.readStage(_id, name),
    },
  });
  const database: Pick<Database, "forWorkspace"> = {
    forWorkspace: (workspace, fn) =>
      db.forWorkspace(workspace, (r) => fn(wrap(r))),
  };
  return { context, wrap, database };
}
it.each(["missing_verification", "supports", "trust", "aliases", "claims"])(
  "generation rejects rehashed %s before Go",
  async (kind) => {
    const f = await setup();
    const x = await corrupted(f, "generation", (stage, result) => {
      if (stage !== "verification") return;
      if (kind === "missing_verification") delete result.frozenVerification;
      if (kind === "supports") result.frozenVerification.supports = [];
      if (kind === "trust")
        result.frozenVerification.sources[0].trust = "reliable";
      if (kind === "aliases")
        result.frozenVerification.verifiedAliases = [
          {
            producer: "Fixture Estate",
            canonicalName: "Reserve Red",
            alias: "Invented",
          },
        ];
      if (kind === "claims") result.claims[0].value = "Invented";
    });
    const out = await createWineGenerationHandler({
      ...f.config,
      database: x.database,
    })(x.context);
    expect(out.state).toBe("blocked");
    expect(f.calls).toEqual(["verification"]);
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.job.runId, "quality_check"),
      ),
    ).toBeNull();
  },
);
it.each(["missing", "request", "ownership", "annotation", "content"])(
  "quality rejects rehashed %s artifact before Go",
  async (kind) => {
    const f = await setup();
    await f.run("generation");
    const x = await corrupted(f, "quality_check", (stage, result) => {
      if (stage !== "generation") return;
      if (kind === "missing") delete result.frozenQuality;
      if (kind === "request") result.frozenQuality.request.tone = "unaccepted";
      if (kind === "ownership")
        result.frozenQuality.request.ownership.provenanceDigest = "a".repeat(
          64,
        );
      if (kind === "annotation")
        result.frozenQuality.candidate.annotations[0].claimId =
          "00000000-0000-4000-8000-000000000000";
      if (kind === "content")
        result.frozenQuality.candidate.content.title.en = "different";
    });
    const out = await createWineGenerationHandler({
      ...f.config,
      database: x.database,
    })(x.context);
    expect(out.state).toBe("blocked");
    expect(f.calls).toEqual(["verification", "generation"]);
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(f.job.runId, "commit_candidate"),
      ),
    ).toBeNull();
  },
);
it.each(["supports", "trust", "aliases"])(
  "projection independently rejects rehashed %s after completed actual quality",
  async (kind) => {
    const f = await setup();
    await f.run("generation");
    await f.run("quality_check");
    const x = await corrupted(f, "commit_candidate", (stage, result) => {
      if (stage !== "verification") return;
      if (kind === "supports") result.frozenVerification.supports = [];
      if (kind === "trust")
        result.frozenVerification.sources[0].trust = "reliable";
      if (kind === "aliases")
        result.frozenVerification.verifiedAliases = [
          {
            producer: "Fixture Estate",
            canonicalName: "Reserve Red",
            alias: "Forged",
          },
        ];
    });
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        projectWineCandidate(x.wrap(r), {
          ...x.context,
          requiredOutcome: "ready",
        }),
      ),
    ).rejects.toThrow("adopted_grounding_invalid");
    expect(
      (
        await admin`select count(*)::int n from listing_versions where workspace_id=${f.workspaceId}`
      )[0].n,
    ).toBe(0);
  },
);
it.each(["legacy", "structured"] as const)(
  "actual generation preserves accepted operator metadata and %s description ownership",
  async (kind) => {
    const section = {
      key: "introduction" as const,
      en: "Operator paragraph",
      "zh-Hant": "操作員保留段落",
      claimIds: ["00000000-0000-4000-8000-000000000009"],
      locked: true,
      owner: "operator" as const,
    };
    const working = {
      ...emptyWorkingListing(),
      title: { en: "Operator title", "zh-Hant": "操作員標題" },
      description: { en: section.en, "zh-Hant": section["zh-Hant"] },
      ...(kind === "structured"
        ? { wineOwnership: { schemaVersion: 1 as const, sections: [section] } }
        : {}),
    };
    const f =
      kind === "legacy"
        ? await setup("full", false, working)
        : await setup("full", false, undefined, {
            ...working,
            packQuantity: 1,
            seo: {
              title: { en: "Operator SEO", "zh-Hant": "操作員 SEO" },
              description: { en: "Operator summary", "zh-Hant": "操作員摘要" },
            },
          });
    f.control.mutateCandidate = (value, request) => {
      value.content.title = structuredClone(request.ownership!.metadata.title);
      value.annotations = value.annotations.filter(
        (a) => !a.path.startsWith("title."),
      );
      if (request.lockedPaths.some((p) => p.startsWith("seo"))) {
        value.content.seo = structuredClone(request.ownership!.metadata.seo);
        value.annotations = value.annotations.filter(
          (a) => !a.path.startsWith("seo."),
        );
      }
      if (request.current) {
        value.content.sections = structuredClone(request.current.sections);
        value.annotations = value.annotations.filter(
          (a) => !a.path.startsWith("sections."),
        );
      }
    };
    expect(await f.run("generation")).toMatchObject({ status: "advanced" });
    expect(f.requests[0]).toMatchObject({
      ownership: { priorKind: kind, metadata: { title: working.title } },
    });
    if (kind === "legacy")
      expect(f.requests[0]!.ownership!.legacyDescription).toEqual(
        working.description,
      );
    else expect(f.requests[0]!.current!.sections).toEqual([section]);
    expect(await f.run("quality_check")).toMatchObject({ status: "advanced" });
    expect(await f.run("commit_candidate")).toMatchObject({
      status: "completed",
    });
    const review = await db.forWorkspace(f.workspaceId, (r) =>
      r.listings.getReviewSnapshot(f.job.draftId),
    );
    expect(review!.activeVersion!.content.title).toEqual(working.title);
    expect(review!.activeVersion!.content.description).toEqual(
      working.description,
    );
    if (kind === "structured")
      expect(review!.activeVersion!.content.wineOwnership!.sections).toEqual([
        section,
      ]);
    else expect(review!.activeVersion!.content.wineOwnership).toBeUndefined();
  },
);
it.each(["generation", "quality_check"] as const)(
  "trusted finish rechecks registry after actual %s HTTP and retains rejected output",
  async (stage) => {
    const f = await setup();
    if (stage === "quality_check") await f.run("generation");
    const claim = await f.store.claim({ ...f.job, stage });
    if (claim.status !== "claimed") throw Error("claim");
    const output = await f.handlers.execute(claim.context);
    expect(output.state).toBe("succeeded");
    const reviewer = crypto.randomUUID();
    await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
    await admin`insert into memberships(workspace_id,user_id,role) values(${f.workspaceId},${reviewer},'reviewer')`;
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.recordReviewedAuthority(reviewer, {
        schemaVersion: 1,
        domain: "wine.test",
        subject: { kind: "producer", name: "Fixture Estate" },
        proofUrl: "https://wine.test/about",
        proofDigest: "a".repeat(64),
        verifiedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null,
        verifierId: reviewer,
      }),
    );
    expect(await f.store.finish(claim.context, output)).toEqual({
      status: "blocked",
      code: "generation_authorization_changed",
    });
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.job.runId, stage),
    );
    expect(row!.output).toMatchObject({
      fresh: false,
      result: { state: "blocked" },
      rejectedResult: output,
    });
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(
          f.job.runId,
          stage === "generation" ? "quality_check" : "commit_candidate",
        ),
      ),
    ).toBeNull();
  },
);

it("generation uses the latest completed deep verification with the full factual premise set", async () => {
  const f = await setup("full", false, undefined, undefined, true);
  const row = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.job.runId, "verification_deep"),
  );
  const verified = parseWineStageResult(
    (row!.output as { result: unknown }).result,
    "verification_deep",
  );
  if (verified.state !== "succeeded" || verified.stage !== "verification_deep")
    throw Error("verification");
  expect(await f.run("generation")).toMatchObject({ status: "advanced" });
  expect(f.requests[0]!.claims).toEqual(
    verified.claims.filter((c) => c.state === "accepted"),
  );
  expect(f.requests[0]!.claims).toEqual(
    expect.arrayContaining(verified.frozenVerification!.acceptedPremises),
  );
  expect(f.requests[0]!.claims.some((c) => c.field === "abvPercent")).toBe(
    false,
  );
  expect(await f.run("quality_check")).toMatchObject({ status: "advanced" });
  expect(await f.run("commit_candidate")).toMatchObject({
    status: "completed",
    outcome: "complete",
  });
  expect(f.calls).toEqual([
    "verification",
    "verification_deep",
    "generation",
    "quality_check",
  ]);
});
it.each(["generation", "quality_check"] as const)(
  "already started %s cannot replay a Go call",
  async (stage) => {
    const f = await setup();
    if (stage === "quality_check") await f.run("generation");
    expect((await f.store.claim({ ...f.job, stage })).status).toBe("claimed");
    expect(await f.run(stage)).toEqual({
      status: "blocked",
      code: "stage_outcome_unknown",
    });
    expect(f.calls).toEqual(
      stage === "generation"
        ? ["verification"]
        : ["verification", "generation"],
    );
  },
);
it("mechanically invalid actual generation has known usage and never triggers a rewrite or quality call", async () => {
  const f = await setup();
  f.control.mutateCandidate = (value) => {
    value.annotations[0]!.value = 123;
  };
  expect(await f.run("generation")).toMatchObject({ status: "blocked" });
  await f.run("generation");
  expect(f.calls).toEqual(["verification", "generation"]);
  const rows =
    await admin`select status,usage_certainty from ai_runs where pipeline_run_id=${f.job.runId} and stage='generation'`;
  expect(rows).toHaveLength(1);
  expect(rows[0].usage_certainty).toBe("estimated");
  expect(
    (
      await admin`select state from ai_budget_reservations where pipeline_run_id=${f.job.runId}`
    )[0].state,
  ).toBe("settled");
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(f.job.runId, "quality_check"),
    ),
  ).toBeNull();
});

// Test-only acceptance fixture: real immutable input/base, live reader and pure builder
// inside the owned local transaction. Web admission remains disabled until Task C.
async function copyRun(
  f: Awaited<ReturnType<typeof setup>>,
  mode: "copy" | "section",
  mutate?: (snapshot: import("@wukong/core").WineCopySnapshot) => void,
) {
  const run = await db.forWorkspace(f.workspaceId, async (r) => {
    await r.listings.lockReviewState(f.job.draftId);
    const listing = await r.listings.requireById(f.job.draftId);
    const input = (await r.listingInputs.getCurrent(listing.id))!;
    const review = await r.listings.getReviewSnapshot(listing.id);
    const ownership = resolveWineGenerationOwnership(
      input,
      workingListingSchema.parse(input.workingContent),
      review!.activeVersion!.content,
      {
        workspaceId: f.workspaceId,
        listingId: listing.id,
        operationId: randomUUID(),
        inputRevision: input.revision,
        baseVersionId: listing.activeVersionId,
      },
    );
    const policy = wineEnrichmentPolicySchema.parse({
      enabled: true,
      allowedDomains: [],
      tavilyCreditCap: 0,
    });
    const original = (await r.pipelineRuns.getOperation(f.job.runId))!;
    const adopted = await readAdoptedWineDependencies(r, {
      workspaceId: f.workspaceId,
      listingId: listing.id,
      versionId: listing.activeVersionId!,
      inputRevision: input.revision,
    });
    expect(adopted.status).toBe("available");
    const { snapshot } = buildWineCopySnapshot({
      adopted,
      input,
      ownership,
      policy,
      model: wineExecutionSnapshotSchema.parse(original.execution.wineGo),
      mode,
      section: mode === "section" ? "introduction" : null,
    });
    mutate?.(snapshot);
    snapshot.dependencyDigest = wineCopyDependencyDigest(snapshot);
    const acceptedAt = await r.pipelineRuns.acceptanceTimestamp();
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: input.revision,
      baseVersionId: listing.activeVersionId,
      activeVersionSequence: listing.activeVersionSequence,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      acceptedAt,
      execution: {
        ...original.execution,
        input,
        wineInputDigest: input.inputDigest,
        wineSourceDigest: listingInputDigest(input.sources),
        wineMode: mode,
        wineCopy: snapshot,
        wineBudget: createWineBudgetSnapshot(mode),
        wineEnrichment: policy,
        wineAcquisition: {
          schemaVersion: 1,
          policyVersion: policy.policyVersion,
          rulesVersion: policy.rulesVersion,
          allowedDomains: [],
          deadlineAt: new Date(Date.parse(acceptedAt) + 900000).toISOString(),
        },
      },
    });
    await r.aiBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedUsd: "1.277952",
      workspaceCapUsd: "20",
      pricingVersion: "wine-enrichment@1",
    });
    return run;
  });
  const job = {
    ...f.job,
    runId: run.id,
    inputRevision: run.inputRevision,
    activeVersionSequence: run.activeVersionSequence,
    stage: "generation" as const,
  };
  return {
    run,
    job,
    execute: (stage: WineStage) =>
      runWineStage({ ...job, stage }, { store: f.store, ...f.handlers }),
  };
}
it.each(["copy", "section"] as const)(
  "runs actual search-free %s and repeated origins with original claims and zero search",
  async (mode) => {
    const f = await setup();
    for (const stage of [
      "generation",
      "quality_check",
      "commit_candidate",
    ] as const)
      await f.run(stage);
    const original = f.requests[0]!;
    const beforeCalls = f.calls.length;
    for (let round = 0; round < 2; round++) {
      const c = await copyRun(f, mode);
      expect(await c.execute("generation")).toMatchObject({
        status: "advanced",
        nextStage: "quality_check",
      });
      const request = f.requests.at(-1)!;
      expect(request.binding.operationId).toBe(c.run.id);
      expect(
        request.claims.every((x) =>
          original.claims.some(
            (y) => listingInputDigest(x) === listingInputDigest(y),
          ),
        ),
      ).toBe(true);
      expect(await c.execute("quality_check")).toMatchObject({
        status: "advanced",
        nextStage: "commit_candidate",
      });
      expect(await c.execute("commit_candidate")).toMatchObject({
        status: "completed",
        outcome: "complete",
      });
      const result = await db.forWorkspace(f.workspaceId, async (r) => ({
        adopted: await readAdoptedWineDependencies(r, {
          workspaceId: f.workspaceId,
          listingId: c.run.listingId,
          versionId: (await r.listings.requireById(c.run.listingId))
            .activeVersionId!,
          inputRevision: c.run.inputRevision,
        }),
        stages: await Promise.all(
          WINE_STAGE_ORDER.map((s) => r.wineEnrichment.readStage(c.run.id, s)),
        ),
      }));
      expect(result.stages.filter(Boolean).map((x) => x!.stage)).toEqual([
        "generation",
        "quality_check",
        "commit_candidate",
      ]);
      expect(result.adopted).toMatchObject({
        status: "available",
        refreshRequired: false,
      });
      if (result.adopted.status === "available")
        expect(
          result.adopted.origins.every((x) => x.runId === f.job.runId),
        ).toBe(true);
    }
    expect(f.calls.slice(beforeCalls)).toEqual([
      "generation",
      "quality_check",
      "generation",
      "quality_check",
    ]);
  },
);
async function completedCopyBase() {
  const f = await setup();
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    expect((await f.run(stage)).status).not.toBe("blocked");
  return f;
}
it.each(["cancel", "revision", "deadline"] as const)(
  "copy %s preserves stale candidate and zero search accounting",
  async (kind) => {
    const f = await completedCopyBase(),
      c = await copyRun(f, "copy"),
      before = f.calls.length;
    f.control.beforeResponse = async (stage) => {
      if (stage !== "generation") return;
      if (kind === "cancel")
        await db.forWorkspace(f.workspaceId, (r) =>
          r.pipelineRuns.setOperationState(c.run.id, "cancelled"),
        );
      if (kind === "revision")
        await admin`update listing_drafts set input_revision=input_revision+1 where id=${c.run.listingId}`;
      if (kind === "deadline")
        f.control.clock = new Date(Date.parse(c.run.acceptedAt) + 900001);
    };
    expect(await c.execute("generation")).toMatchObject({ status: "stopped" });
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(c.run.id, "generation"),
    );
    expect(row!.output).toMatchObject({
      fresh: false,
      result: {
        state: "succeeded",
        frozenQuality: { request: { binding: { operationId: c.run.id } } },
      },
    });
    await c.execute("quality_check");
    expect(f.calls.slice(before)).toEqual(["generation"]);
    expect(
      await admin`select pipeline_run_id from search_budget_reservations where pipeline_run_id=${c.run.id}`,
    ).toHaveLength(0);
    expect(
      (
        await admin`select state from ai_budget_reservations where pipeline_run_id=${c.run.id}`
      )[0].state,
    ).toBe("settled");
  },
);
it.each(["generation", "quality_check"] as const)(
  "copy unknown %s holds Go and never starts another call",
  async (stage) => {
    const f = await completedCopyBase(),
      c = await copyRun(f, "copy");
    if (stage === "quality_check") await c.execute("generation");
    const before = f.calls.length;
    f.control.unknownStage = stage;
    expect((await c.execute(stage)).status).toBe("blocked");
    await c.execute(stage);
    expect(f.calls.slice(before)).toEqual([stage]);
    expect(
      (
        await admin`select state from ai_budget_reservations where pipeline_run_id=${c.run.id}`
      )[0].state,
    ).toBe("unknown");
    expect(
      await admin`select pipeline_run_id from search_budget_reservations where pipeline_run_id=${c.run.id}`,
    ).toHaveLength(0);
  },
);
it.each(["generation", "quality_check"] as const)(
  "copy started %s cannot replay",
  async (stage) => {
    const f = await completedCopyBase(),
      c = await copyRun(f, "copy");
    if (stage === "quality_check") await c.execute("generation");
    const before = f.calls.length;
    expect((await f.store.claim({ ...c.job, stage })).status).toBe("claimed");
    expect(await c.execute(stage)).toMatchObject({
      status: "blocked",
      code: "stage_outcome_unknown",
    });
    expect(f.calls.length).toBe(before);
  },
);
it("copy must reject a lifecycle-only generation without its actual frozen request", async () => {
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  const claim = await f.store.claim(c.job);
  if (claim.status !== "claimed") throw Error("claim");
  const result = {
    schemaVersion: 1 as const,
    state: "succeeded" as const,
    stage: "generation" as const,
    content: candidate(f.requests[0]!).content,
    issues: [],
  };
  expect(await f.store.finish(claim.context, result)).toMatchObject({
    status: "blocked",
    code: "generation_authorization_changed",
  });
  const row = await db.forWorkspace(f.workspaceId, (r) =>
    r.wineEnrichment.readStage(c.run.id, "generation"),
  );
  expect(row!.output).toMatchObject({ fresh: false, rejectedResult: result });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(c.run.id, "quality_check"),
    ),
  ).toBeNull();
});
it.each(["input", "ownership", "claim", "origin", "target", "tenant"] as const)(
  "copy rejects rehashed accepted %s mismatch before any Go",
  async (kind) => {
    const f = await completedCopyBase(),
      before = f.calls.length;
    const c = await copyRun(f, "copy", (s) => {
      if (kind === "input") s.inputDigest = "f".repeat(64);
      if (kind === "ownership") s.ownershipDigest = "f".repeat(64);
      if (kind === "claim") s.claims[0]!.claimDigest = "f".repeat(64);
      if (kind === "origin") s.origins[0]!.identityDigest = "f".repeat(64);
      if (kind === "target") s.targetPaths = s.targetPaths.slice(1);
      if (kind === "tenant") s.workspaceId = "foreign-workspace";
    });
    expect((await c.execute("generation")).status).toBe("blocked");
    expect(f.calls.length).toBe(before);
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.wineEnrichment.readStage(c.run.id, "quality_check"),
      ),
    ).toBeNull();
  },
);
it.each(["generation", "quality_check"] as const)(
  "copy reauthorizes registry after actual %s response",
  async (stage) => {
    const f = await completedCopyBase(),
      c = await copyRun(f, "copy");
    if (stage === "quality_check") await c.execute("generation");
    const claim = await f.store.claim({ ...c.job, stage });
    if (claim.status !== "claimed") throw Error("claim");
    const output = await f.handlers.execute(claim.context);
    expect(output.state).toBe("succeeded");
    const reviewer = randomUUID();
    await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
    await admin`insert into memberships(workspace_id,user_id,role) values(${f.workspaceId},${reviewer},'reviewer')`;
    await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.recordReviewedAuthority(reviewer, {
        schemaVersion: 1,
        domain: "wine.test",
        subject: { kind: "producer", name: "Fixture Estate" },
        proofUrl: "https://wine.test/about",
        proofDigest: "a".repeat(64),
        verifiedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null,
        verifierId: reviewer,
      }),
    );
    expect(await f.store.finish(claim.context, output)).toMatchObject({
      status: "blocked",
      code: "generation_authorization_changed",
    });
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(c.run.id, stage),
    );
    expect(row!.output).toMatchObject({ fresh: false, rejectedResult: output });
  },
);
it.each(["copy", "section"] as const)(
  "changes bilingual %s repeatedly while retaining unavailable protected content and original captures",
  async (mode) => {
    const protectedSection = {
      key: "tasting" as const,
      en: "Operator tasting paragraph",
      "zh-Hant": "操作員品酒段落",
      claimIds: ["00000000-0000-4000-8000-000000000099"],
      owner: "operator" as const,
      locked: true,
    };
    const metadata = { en: "Baseline title", "zh-Hant": "原有標題" };
    const base = {
      ...emptyWorkingListing(),
      title: metadata,
      seo: { title: metadata, description: metadata },
      description: {
        en: protectedSection.en,
        "zh-Hant": protectedSection["zh-Hant"],
      },
      packQuantity: 1,
      wineOwnership: {
        schemaVersion: 1 as const,
        sections: [protectedSection],
      },
    };
    const f = await setup("full", false, emptyWorkingListing(), base);
    f.control.mutateCandidate = (v, r) => {
      v.content.sections.push(...structuredClone(r.current!.sections));
    };
    for (const stage of [
      "generation",
      "quality_check",
      "commit_candidate",
    ] as const)
      expect(await f.run(stage)).toMatchObject({
        status: stage === "commit_candidate" ? "completed" : "advanced",
      });
    const read = () =>
      db.forWorkspace(f.workspaceId, async (r) => {
        const l = await r.listings.requireById(f.job.draftId);
        return readAdoptedWineDependencies(r, {
          workspaceId: f.workspaceId,
          listingId: l.id,
          versionId: l.activeVersionId!,
          inputRevision: l.inputRevision,
        });
      });
    const first = await read();
    expect(first).toMatchObject({ status: "available", refreshRequired: true });
    if (first.status !== "available") throw Error("origin");
    const original = first.origins;
    for (let round = 0; round < 3; round++) {
      const c = await copyRun(f, mode);
      f.control.mutateCandidate = (v, r) => {
        v.content = structuredClone(r.current!);
        const text = {
          en: `This wine is presented in a 750 ml bottle${".".repeat(round + 1)}`,
          "zh-Hant": `此酒採用 750 毫升瓶裝${"。".repeat(round + 1)}`,
        };
        const section = v.content.sections.find(
          (s) => s.key === "introduction",
        )!;
        section.en = text.en;
        section["zh-Hant"] = text["zh-Hant"];
        const cl = r.claims.find((x) => x.field === "volumeMl")!;
        v.annotations = (["en", "zh-Hant"] as const).map((lang) => ({
          path: `sections.introduction.${lang}`,
          span: text[lang],
          claimId: cl.id,
          value: cl.value,
          evidenceIds: cl.evidenceIds,
          premiseClaimIds: cl.premiseClaimIds,
        }));
      };
      for (const stage of [
        "generation",
        "quality_check",
        "commit_candidate",
      ] as const)
        expect((await c.execute(stage)).status).not.toBe("blocked");
      const adopted = await read();
      expect(adopted.status).toBe("available");
      if (adopted.status !== "available") throw Error("copy reader");
      expect(adopted.origins).toEqual(original);
      expect(adopted.adopted.sections.find((s) => s.key === "tasting")).toEqual(
        protectedSection,
      );
      expect(adopted.adopted.title).toEqual(first.adopted.title);
      expect(adopted.adopted.seo).toEqual(first.adopted.seo);
      expect(adopted.unavailableSections.map((s) => s.path)).toContain(
        "sections.tasting.en",
      );
      expect(
        adopted.supports
          .filter((s) => s.path.startsWith("sections.introduction"))
          .every((s) => s.valid && s.originRunId === f.job.runId),
      ).toBe(true);
      expect(
        adopted.adopted.sections.find((s) => s.key === "introduction")!.en,
      ).not.toBe(
        first.adopted.sections.find((s) => s.key === "introduction")!.en,
      );
    }
  },
);
it("copy admits at most four physical Go calls including generation and quality repairs, with no search ledger", async () => {
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  const calls: string[] = [];
  const execute = createWineGenerationHandler({
    ...f.config,
    transport: {
      fetch: async (_url, init) => {
        const value = JSON.parse(
          JSON.parse(String(init!.body)).messages[1].content,
        );
        const stage = value.candidate ? "quality_check" : "generation";
        calls.push(stage);
        if (calls.filter((s) => s === stage).length === 1)
          return response({ invalid: true });
        return response(
          stage === "generation"
            ? candidate(value)
            : { schemaVersion: 1, issues: [] },
        );
      },
    },
  });
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    expect(
      await runWineStage({ ...c.job, stage }, { store: f.store, execute }),
    ).toMatchObject({
      status: stage === "commit_candidate" ? "completed" : "advanced",
    });
  expect(calls).toEqual([
    "generation",
    "generation",
    "quality_check",
    "quality_check",
  ]);
  for (const stage of [
    "extraction",
    "search_basic",
    "generation",
    "quality_check",
  ] as const)
    await runWineStage({ ...c.job, stage }, { store: f.store, execute });
  expect(calls).toHaveLength(4);
  expect(
    await admin`select stage from ai_runs where pipeline_run_id=${c.run.id}`,
  ).toHaveLength(4);
  expect(
    await admin`select run_id from wine_search_calls where run_id=${c.run.id}`,
  ).toHaveLength(0);
  expect(
    await admin`select pipeline_run_id from search_budget_reservations where pipeline_run_id=${c.run.id}`,
  ).toHaveLength(0);
  expect(
    (
      await admin`select reserved_usd,state from ai_budget_reservations where pipeline_run_id=${c.run.id}`
    )[0],
  ).toMatchObject({ reserved_usd: "1.277952", state: "settled" });
});
async function readCopyResult(
  f: Awaited<ReturnType<typeof setup>>,
  wrap: (r: WorkspaceRepositories) => WorkspaceRepositories = (r) => r,
) {
  return db.forWorkspace(f.workspaceId, async (r) => {
    const l = await r.listings.requireById(f.job.draftId);
    return readAdoptedWineDependencies(wrap(r), {
      workspaceId: f.workspaceId,
      listingId: l.id,
      versionId: l.activeVersionId!,
      inputRevision: l.inputRevision,
    });
  });
}
it.each([
  "base",
  "namespace",
  "claim",
  "quality",
  "missing-stage",
  "sequence",
  "cycle",
] as const)("copy origin rejects forged historical %s", async (kind) => {
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    await c.execute(stage);
  const result = await readCopyResult(f, (r) => ({
    ...r,
    pipelineRuns: {
      ...r.pipelineRuns,
      getOperation: async (id) => {
        const run = await r.pipelineRuns.getOperation(id);
        if (!run || id !== c.run.id) return run;
        const x = structuredClone(run),
          s = x.execution.wineCopy as import("@wukong/core").WineCopySnapshot;
        if (kind === "base") s.baseVersionId = randomUUID();
        if (kind === "namespace") s.claims[0]!.originRunId = randomUUID();
        if (kind === "claim") s.claims[0]!.claimDigest = "f".repeat(64);
        if (kind === "sequence") x.activeVersionSequence++;
        if (kind === "cycle") {
          x.baseVersionId = (
            await r.listings.requireById(x.listingId)
          ).activeVersionId;
          s.baseVersionId = x.baseVersionId!;
        }
        s.dependencyDigest = wineCopyDependencyDigest(s);
        return x;
      },
    },
    wineEnrichment: {
      ...r.wineEnrichment,
      readStage: async (id, stage) => {
        const row = await r.wineEnrichment.readStage(id, stage);
        if (id !== c.run.id || !row) return row;
        if (kind === "missing-stage" && stage === "quality_check") return null;
        if (kind === "quality" && stage === "quality_check") {
          const x = structuredClone(row);
          (x.output as any).result.contentDigest = "f".repeat(64);
          return x;
        }
        return row;
      },
    },
  }));
  expect(result.status).toBe("unavailable");
});
it.each([
  "request-claims",
  "annotation",
  "quality-digest",
  "quality-blocking",
] as const)(
  "copy projection independently rejects rehashed %s",
  async (kind) => {
    const f = await completedCopyBase(),
      c = await copyRun(f, "copy");
    await c.execute("generation");
    await c.execute("quality_check");
    const x = await corrupted(
      { ...f, job: c.job },
      "commit_candidate",
      (stage, result) => {
        if (stage === "generation" && kind === "request-claims")
          result.frozenQuality.request.claims[0].value = "forged";
        if (stage === "generation" && kind === "annotation")
          result.frozenQuality.candidate.annotations[0].claimId = randomUUID();
        if (stage === "quality_check" && kind === "quality-digest")
          result.contentDigest = "f".repeat(64);
        if (stage === "quality_check" && kind === "quality-blocking")
          result.issues = [
            {
              path: "sections.introduction.en",
              code: "semantic_entailment",
              blocking: true,
              evidenceIds: [],
            },
          ];
      },
    );
    await expect(
      db.forWorkspace(f.workspaceId, (r) =>
        projectWineCandidate(x.wrap(r), {
          ...x.context,
          requiredOutcome: "ready",
        }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await admin`select count(*)::int n from listing_versions where workspace_id=${f.workspaceId}`
      )[0].n,
    ).toBe(1);
  },
);
it("copy ancestry remains bounded after sixteen historical hops without renewing original evidence", async () => {
  const f = await completedCopyBase();
  for (let round = 0; round < 17; round++) {
    const c = await copyRun(f, "copy");
    for (const stage of [
      "generation",
      "quality_check",
      "commit_candidate",
    ] as const)
      expect((await c.execute(stage)).status).toBe(
        stage === "commit_candidate" ? "completed" : "advanced",
      );
    const result = await readCopyResult(f);
    expect(result.status).toBe(round < 16 ? "available" : "unavailable");
    if (round === 16) expect(result).toMatchObject({ code: "ancestry_depth" });
  }
}, 120000);
it.each(["verification", "quality_check"] as const)(
  "direct full projection derives persisted %s blockers despite caller ready",
  async (stage) => {
    const f = await setup();
    await f.run("generation");
    await f.run("quality_check");
    const x = await corrupted(f, "commit_candidate", (name, result) => {
      if (name === stage) {
        result.issues = [
          {
            path: "sections.introduction.en",
            code: "semantic_entailment",
            blocking: true,
            evidenceIds: [],
          },
        ];
        if (stage === "quality_check") result.outcome = "needs_info";
      }
    });
    const result = await db.forWorkspace(f.workspaceId, (r) =>
      projectWineCandidate(x.wrap(r), {
        ...x.context,
        requiredOutcome: "ready",
      }),
    );
    expect(result.outcome).toBe("needs_info");
  },
);
it("actual copy mandatory quality needs_info preserves the review base without rewriting", async () => {
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy"),
    calls: string[] = [];
  const execute = createWineGenerationHandler({
    ...f.config,
    transport: {
      fetch: async (_url, init) => {
        const value = JSON.parse(
            JSON.parse(String(init!.body)).messages[1].content,
          ),
          check = !!value.candidate;
        calls.push(check ? "quality_check" : "generation");
        return response(
          check
            ? {
                schemaVersion: 1,
                issues: [
                  {
                    path: "sections.introduction.en",
                    code: "semantic_entailment",
                    blocking: true,
                    evidenceIds: [],
                  },
                ],
              }
            : candidate(value),
        );
      },
    },
  });
  expect(await runWineStage(c.job, { store: f.store, execute })).toMatchObject({
    status: "advanced",
  });
  expect(
    await runWineStage(
      { ...c.job, stage: "quality_check" },
      { store: f.store, execute },
    ),
  ).toMatchObject({ status: "advanced" });
  expect(
    await runWineStage(
      { ...c.job, stage: "commit_candidate" },
      { store: f.store, execute },
    ),
  ).toMatchObject({
    status: "completed",
    outcome: "needs_info",
    versionId: null,
  });
  const listing = await db.forWorkspace(f.workspaceId, (r) =>
    r.listings.requireById(c.run.listingId),
  );
  expect(listing).toMatchObject({
    status: "in_review",
    activeVersionId: c.run.baseVersionId,
  });
  expect(calls).toEqual(["generation", "quality_check"]);
});
it("accepted copy title paraphrases keep original product support reusable", async () => {
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  f.control.mutateCandidate = (v, r) => {
    const text = { en: "A 750 ml bottle", "zh-Hant": "750 毫升瓶裝。" };
    v.content.title = text;
    for (const a of v.annotations.filter((a) => a.path.startsWith("title.")))
      a.span = text[a.path.endsWith("zh-Hant") ? "zh-Hant" : "en"];
  };
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const) {
    const result = await c.execute(stage);
    if (result.status === "blocked") throw Error(JSON.stringify(result));
    expect(result.status).toBe(
      stage === "commit_candidate" ? "completed" : "advanced",
    );
  }
  expect(await readCopyResult(f)).toMatchObject({
    status: "available",
    refreshRequired: false,
  });
  const next = await copyRun(f, "copy");
  expect((await next.execute("generation")).status).toBe("advanced");
});
it("manual title edit after a generated copy title invalidates original product support", async () => {
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  f.control.mutateCandidate = (v) => {
    const text = { en: "A 750 ml bottle", "zh-Hant": "750 毫升瓶裝。" };
    v.content.title = text;
    for (const a of v.annotations.filter((a) => a.path.startsWith("title.")))
      a.span = text[a.path.endsWith("zh-Hant") ? "zh-Hant" : "en"];
  };
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    expect((await c.execute(stage)).status).toBe(
      stage === "commit_candidate" ? "completed" : "advanced",
    );
  await db.forWorkspace(f.workspaceId, async (r) => {
    const l = await r.listings.requireById(c.run.listingId);
    await r.listingInputs.save(
      {
        listingId: l.id,
        actorId: "test",
        expectedInputRevision: l.inputRevision,
        baseVersionId: l.activeVersionId,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [
          { field: "title.en", value: "Different product", state: "manual" },
        ],
      },
      { workspaceId: f.workspaceId, actorId: "test", entityId: l.id },
      r.audit,
    );
  });
  const result = await readCopyResult(f);
  expect(result).toMatchObject({ status: "available", refreshRequired: true });
  if (result.status === "available")
    expect(
      result.supports.every(
        (s) => !s.valid && s.invalidReason === "identity_changed",
      ),
    ).toBe(true);
});

it.each(["copy", "section"] as const)(
  "actual Queue factory executes %s without Tavily and recovers ACK loss without replay",
  async (mode) => {
    const { createWineQueueRuntime } = await import("./wine-queue-runtime.js");
    const { handleQueue } = await import("./queue-consumer.js");
    const { consumeWineMessage } = await import("./wine-consumer.js");
    const f = await completedCopyBase(),
      c = await copyRun(f, mode);
    const sent: import("@wukong/jobs").WineListingJob[] = [];
    let failSend = true;
    const env = {
      OPENCODE_GO_API_KEY: "synthetic",
      LISTING_PAID_OPERATIONS_ENABLED: "false",
      LISTING_QUEUE: {
        send: async (job: import("@wukong/jobs").WineListingJob) => {
          if (failSend) {
            failSend = false;
            throw Error("synthetic send failure");
          }
          sent.push(job);
        },
      },
    } as never;
    const config = {
      databaseFactory: () => ({ ...db, close: async () => {} }),
      transport: f.config.transport,
      assetStoreFactory: () => {
        throw Error("copy must not open image storage");
      },
      acquisitionFetch: async () => {
        throw Error("copy must not search");
      },
    };
    const runtime = createWineQueueRuntime(env, config);
    const before = f.calls.length;
    await expect(runtime.deliver(c.job)).rejects.toThrow(
      "wine_outbox_send_failed",
    );
    expect(f.calls.slice(before)).toEqual(["generation"]);
    expect(await runtime.deliver(c.job)).toMatchObject({ status: "duplicate" });
    expect(sent.map((j) => j.stage)).toEqual(["quality_check"]);
    expect(f.calls.slice(before)).toEqual(["generation"]);
    let acknowledgements = 0;
    const deliver = async (body: import("@wukong/jobs").WineListingJob) =>
      handleQueue(
        {
          queue: "wukong-listing-preview",
          messages: [
            {
              body,
              attempts: 1,
              ack: () => {
                acknowledgements++;
              },
              retry: () => {
                throw Error("unexpected retry");
              },
            },
          ],
        } as never,
        env,
        undefined,
        {
          consumeWineMessage: (payload, bindings) =>
            consumeWineMessage(payload, bindings, config),
        },
      );
    await deliver(sent[0]!);
    expect(sent.map((j) => j.stage)).toEqual([
      "quality_check",
      "commit_candidate",
    ]);
    await deliver(sent[0]!); // Queue ACK lost after quality commit.
    expect(f.calls.slice(before)).toEqual(["generation", "quality_check"]);
    await deliver(sent[1]!);
    expect(acknowledgements).toBe(3);
    expect(
      (await db.forWorkspace(f.workspaceId, (r) =>
        r.pipelineRuns.getOperation(c.run.id),
      ))!.executionState,
    ).toBe("succeeded");
    expect(
      await admin`select run_id from wine_search_calls where run_id=${c.run.id}`,
    ).toHaveLength(0);
    expect(
      await admin`select pipeline_run_id from search_budget_reservations where pipeline_run_id=${c.run.id}`,
    ).toHaveLength(0);
  },
);

it("wine recovery ignores completed old outbox and started in-flight stages", async () => {
  const { recoverWineOperation } = await import("./wine-recovery.js");
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  const { wineStageMessageKey } = await import("@wukong/jobs");
  const record = async () =>
    db.forWorkspace(f.workspaceId, async (r) => {
      const rows = await r.dispatchOutbox.record([
        {
          listingId: c.job.draftId,
          dedupeKey: wineStageMessageKey(c.run.id, "generation"),
          payload: c.job,
        },
      ]);
      for (let i = 0; i < 5; i++)
        await r.dispatchOutbox.markAttempted([rows[0]!.id]);
    });
  await record();
  const claim = await f.store.claim(c.job);
  expect(claim.status).toBe("claimed");
  expect(await recoverWineOperation(db, f.workspaceId, c.run.id)).toEqual({
    failed: false,
  });
  if (claim.status !== "claimed") throw Error("fixture claim");
  const result = await f.handlers.execute(claim.context);
  expect(await f.store.finish(claim.context, result)).toMatchObject({
    status: "advanced",
  });
  expect(await recoverWineOperation(db, f.workspaceId, c.run.id)).toEqual({
    failed: false,
  });
});
it("wine recovery terminalizes only the exact exhausted pending stage and releases unused holds", async () => {
  const { recoverWineOperation } = await import("./wine-recovery.js");
  const { wineStageMessageKey } = await import("@wukong/jobs");
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  await db.forWorkspace(f.workspaceId, async (r) => {
    const [row] = await r.dispatchOutbox.record([
      {
        listingId: c.job.draftId,
        dedupeKey: wineStageMessageKey(c.run.id, "generation"),
        payload: c.job,
      },
    ]);
    for (let i = 0; i < 5; i++) await r.dispatchOutbox.markAttempted([row!.id]);
  });
  expect(await recoverWineOperation(db, f.workspaceId, c.run.id)).toEqual({
    failed: true,
    reason: "dispatch_exhausted",
  });
  expect(
    (
      await admin`select state,settled_usd from ai_budget_reservations where pipeline_run_id=${c.run.id}`
    )[0],
  ).toMatchObject({ state: "settled", settled_usd: "0.000000" });
});

it.skipIf(process.env.WINE_RUNTIME_HTTP_URL !== "http://127.0.0.1:8789")(
  "actual local Wrangler HTTP ingress delivers three Queue stages without Tavily",
  async () => {
    const { createServer } = await import("node:http");
    const { signQueueRequest, LISTING_INGRESS_PATH } =
      await import("@wukong/jobs");
    const calls: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const value = JSON.parse(body.messages[1].content);
        calls.push(value.candidate ? "quality_check" : "generation");
        const reply = response(
          value.candidate ? { schemaVersion: 1, issues: [] } : candidate(value),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await reply.text());
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(49221, "127.0.0.1", resolve),
    );
    try {
      const f = await completedCopyBase(),
        c = await copyRun(f, "copy");
      const webClientModule = "../../web/lib/cloudflare-queue-runtime.ts";
      const { createCloudflareIngressClient } = await import(webClientModule);
      const client = createCloudflareIngressClient({
        env: {
          QUEUE_INGRESS_URL: process.env.WINE_RUNTIME_HTTP_URL,
          QUEUE_INGRESS_SECRET: "wine-runtime-local-synthetic-ingress",
        },
      });
      const send = () => client.enqueue(LISTING_INGRESS_PATH, c.job);
      expect(await send()).toEqual({ accepted: true });
      let state = "";
      for (let i = 0; i < 60; i++) {
        state = (await db.forWorkspace(f.workspaceId, (r) =>
          r.pipelineRuns.getOperation(c.run.id),
        ))!.executionState;
        if (state === "succeeded" || state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(state).toBe("succeeded");
      expect(calls).toEqual(["generation", "quality_check"]);
      expect(await send()).toEqual({ accepted: true });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(calls).toEqual(["generation", "quality_check"]);
      expect(
        await admin`select stage from wine_stages where run_id=${c.run.id} order by stage`,
      ).toHaveLength(3);
      expect(
        await admin`select run_id from wine_search_calls where run_id=${c.run.id}`,
      ).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it.each(["full", "research"] as const)(
  "actual Queue runtime executes all required %s stages using reviewed handlers",
  async (mode) => {
    const { fixture, bytes, output } =
      await import("./wine-research.integration-fixture.js");
    const { createWineQueueRuntime } = await import("./wine-queue-runtime.js");
    const { MemoryAssetStore } = await import("@wukong/assets");
    const f = await fixture({ mode, profile });
    const memory = new MemoryAssetStore();
    const pending: import("@wukong/jobs").WineListingJob[] = [f.job];
    let stage: WineStage = "extraction";
    const calls: WineStage[] = [];
    let searches = 0;
    const runtime = createWineQueueRuntime(
      {
        OPENCODE_GO_API_KEY: "synthetic",
        TAVILY_API_KEY: "synthetic",
        WEBSITE_FETCH_BASE_URL: "https://callback.test",
        QUEUE_INGRESS_SECRET: "synthetic",
        LISTING_QUEUE: {
          send: async (job: import("@wukong/jobs").WineListingJob) => {
            pending.push(job);
          },
        },
      } as never,
      {
        databaseFactory: () => ({ ...db, close: async () => {} }),
        assetStoreFactory: () =>
          ({
            readObject: async () => bytes,
            createWineImageSnapshot:
              memory.createWineImageSnapshot.bind(memory),
          }) as never,
        acquisitionFetch: async () => {
          searches++;
          return Response.json({
            request_id: "synthetic",
            usage: { credits: 1 },
            results: [],
            failed_results: [],
          });
        },
        transport: {
          fetch: async (_url, init) => {
            calls.push(stage);
            if (stage === "extraction") return response(output(f.asset.id));
            if (stage === "generation")
              return response(
                candidate(
                  JSON.parse(
                    JSON.parse(String(init!.body)).messages[1].content,
                  ),
                ),
              );
            if (stage === "quality_check")
              return response({ schemaVersion: 1, issues: [] });
            return response({
              schemaVersion: 1,
              candidates: [],
              claims: [],
              supportProposals: [],
              needsDeepSearch: false,
              issues: [],
            });
          },
        },
      },
    );
    let last: unknown;
    for (let i = 0; pending.length && i < 8; i++) {
      const job = pending.shift()!;
      stage = job.stage;
      last = await runtime.deliver(job);
    }
    expect(last).toMatchObject({ status: "completed" });
    expect(pending).toHaveLength(0);
    expect(calls).toEqual([
      "extraction",
      "verification",
      "generation",
      "quality_check",
    ]);
    expect(searches).toBe(2);
  },
);
it.each(["cancel", "revision", "deadline", "unknown"] as const)(
  "actual Queue runtime preserves %s no-replay and inspectable stale results",
  async (kind) => {
    const { createWineQueueRuntime } = await import("./wine-queue-runtime.js");
    const f = await completedCopyBase(),
      c = await copyRun(f, "copy"),
      before = f.calls.length;
    const sent: unknown[] = [];
    if (kind === "unknown") f.control.unknownStage = "generation";
    else
      f.control.beforeResponse = async () => {
        if (kind === "cancel")
          await db.forWorkspace(f.workspaceId, (r) =>
            r.pipelineRuns.setOperationState(c.run.id, "cancelled"),
          );
        if (kind === "revision")
          await admin`update listing_drafts set input_revision=input_revision+1 where id=${c.run.listingId}`;
        if (kind === "deadline")
          f.control.clock = new Date(Date.parse(c.run.acceptedAt) + 900001);
      };
    const runtime = createWineQueueRuntime(
      {
        OPENCODE_GO_API_KEY: "synthetic",
        LISTING_QUEUE: {
          send: async (j: unknown) => {
            sent.push(j);
          },
        },
      } as never,
      {
        databaseFactory: () => ({ ...db, close: async () => {} }),
        transport: f.config.transport,
        now: () => f.control.clock ?? new Date(),
      },
    );
    expect(await runtime.deliver(c.job)).toMatchObject({
      status: kind === "unknown" ? "blocked" : "stopped",
    });
    await runtime.deliver(c.job);
    expect(f.calls.slice(before)).toEqual(["generation"]);
    expect(sent).toEqual([]);
    const row = await db.forWorkspace(f.workspaceId, (r) =>
      r.wineEnrichment.readStage(c.run.id, "generation"),
    );
    if (kind !== "unknown")
      expect(row!.output).toMatchObject({
        fresh: false,
        result: { state: "succeeded" },
      });
    expect(
      (
        await admin`select state from ai_budget_reservations where pipeline_run_id=${c.run.id}`
      )[0].state,
    ).toBe(kind === "unknown" ? "unknown" : "settled");
  },
);

it.skipIf(process.env.WINE_RUNTIME_HTTP_URL !== "http://127.0.0.1:8789")(
  "actual local Wrangler full mode uses immutable S3 bytes and bounded staged research",
  async () => {
    const { fixture, bytes, output } =
      await import("./wine-research.integration-fixture.js");
    const { S3AssetStore } = await import("@wukong/assets");
    const { createServer } = await import("node:http");
    const { signQueueRequest, LISTING_INGRESS_PATH } =
      await import("@wukong/jobs");
    const f = await fixture({ mode: "full", profile });
    const storage = S3AssetStore.fromConfig("wukong-local", {
      endpoint: "https://localhost:9012",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "wukong", secretAccessKey: "wukong-secret" },
    });
    await storage.writeObject(
      f.workspaceId,
      f.asset.storageKey,
      bytes,
      "image/png",
    );
    const calls: string[] = [];
    let snapshotVerified = false;
    let providerError: unknown;
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        let reply: Response;
        if (!body.messages) {
          calls.push("search");
          reply = Response.json({
            request_id: "synthetic-http",
            usage: { credits: 1 },
            results: [],
            failed_results: [],
          });
        } else if (Array.isArray(body.messages[1].content)) {
          calls.push("extraction");
          const url = body.messages[1].content.find(
            (v: { type: string }) => v.type === "image_url",
          ).image_url.url;
          expect(new URL(url).pathname).toContain(
            `/wine-snapshots/${f.job.runId}/${f.asset.id}/`,
          );
          await storage.writeObject(
            f.workspaceId,
            f.asset.storageKey,
            new Uint8Array(bytes.length).fill(9),
            "image/png",
          );
          expect(
            new Uint8Array(await (await fetch(url)).arrayBuffer()),
          ).toEqual(bytes);
          snapshotVerified = true;
          reply = response(output(f.asset.id));
        } else {
          const value = JSON.parse(body.messages[1].content);
          const stage = value.candidate
            ? "quality_check"
            : value.claims
              ? "generation"
              : "verification";
          calls.push(stage);
          reply = response(
            stage === "generation"
              ? candidate(value)
              : stage === "quality_check"
                ? { schemaVersion: 1, issues: [] }
                : {
                    schemaVersion: 1,
                    candidates: [],
                    claims: [],
                    supportProposals: [],
                    needsDeepSearch: false,
                    issues: [],
                  },
          );
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await reply.text());
      } catch (error) {
        providerError = error;
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(49221, "127.0.0.1", resolve),
    );
    try {
      const body = JSON.stringify(f.job),
        timestamp = Math.floor(Date.now() / 1000);
      const signature = await signQueueRequest({
        secret: "wine-runtime-local-synthetic-ingress",
        timestamp,
        path: LISTING_INGRESS_PATH,
        body,
      });
      expect(
        (
          await fetch(
            `${process.env.WINE_RUNTIME_HTTP_URL}${LISTING_INGRESS_PATH}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-wukong-timestamp": String(timestamp),
                "x-wukong-signature": signature,
              },
              body,
            },
          )
        ).status,
      ).toBe(202);
      let state = "";
      for (let i = 0; i < 80; i++) {
        state = (await db.forWorkspace(f.workspaceId, (r) =>
          r.pipelineRuns.getOperation(f.run.id),
        ))!.executionState;
        if (state === "succeeded" || state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(providerError).toBeUndefined();
      expect({ state, calls }).toMatchObject({ state: "succeeded" });
      expect(snapshotVerified).toBe(true);
      expect(calls).toEqual([
        "extraction",
        "search",
        "search",
        "verification",
        "generation",
        "quality_check",
      ]);
      expect(
        await admin`select stage,state from wine_stages where run_id=${f.run.id} and stage in ('search_deep','verification_deep') order by stage`,
      ).toEqual([
        { stage: "search_deep", state: "skipped" },
        { stage: "verification_deep", state: "skipped" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it("local0043 compatibility verifies finder bodies, grants and legacy exclusion", async () => {
  expect(await db.inspectWineRuntimeCompatibility!()).toEqual({
    version: "wine-runtime-0043-v1",
    ready: true,
    missing: [],
  });
  const { recoverWineOperation } = await import("./wine-recovery.js");
  const f = await completedCopyBase();
  const old = await db.forWorkspace(f.workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const acceptedAt = "2001-01-01T00:00:00.000Z";
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 1,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      acceptedAt,
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        wineMode: "copy",
        wineBudget: createWineBudgetSnapshot("copy"),
        wineAcquisition: { deadlineAt: "2001-01-01T00:15:00.000Z" },
      },
    });
    await r.aiBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedUsd: "1.277952",
      workspaceCapUsd: "20",
      pricingVersion: "wine-enrichment@1",
    });
    return run;
  });
  expect(
    await db.findAbandonedWineOperations!({ maxRows: 20, maxAttempts: 5 }),
  ).toContainEqual({ workspaceId: f.workspaceId, runId: old.id });
  expect(
    await db.findAbandonedListingOperations({
      olderThanSeconds: 900,
      maxRows: 20,
      maxAttempts: 5,
    }),
  ).not.toContainEqual({ workspaceId: f.workspaceId, runId: old.id });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.pipelineRuns.failAbandonedOperation(
        { runId: old.id, olderThanSeconds: 900, maxAttempts: 5 },
        { workspaceId: f.workspaceId, actorId: "test", entityId: old.id },
        r.audit,
      ),
    ),
  ).toEqual({ failed: false });
  expect(await recoverWineOperation(db, f.workspaceId, old.id)).toEqual({
    failed: true,
    reason: "operation_deadline",
  });
});

it("local0043 outbox scan skips old terminal/completed/started rows and finds the next pending stage", async () => {
  const { wineStageMessageKey } = await import("@wukong/jobs");
  const f = await completedCopyBase(),
    c = await copyRun(f, "copy");
  await db.forWorkspace(f.workspaceId, (r) =>
    r.dispatchOutbox.record([
      {
        listingId: c.job.draftId,
        dedupeKey: wineStageMessageKey(c.run.id, "generation"),
        payload: c.job,
      },
    ]),
  );
  await admin`update listing_dispatch_outbox set created_at='2000-01-01' where workspace_id=${f.workspaceId}`;
  let rows = await db.findUndispatchedListingJobs({
    olderThanSeconds: 0,
    maxRows: 1,
    maxAttempts: 5,
  });
  expect(rows[0]!.payload).toMatchObject({
    runId: c.run.id,
    stage: "generation",
  });
  await c.execute("generation");
  await admin`update listing_dispatch_outbox set created_at='2000-01-01' where workspace_id=${f.workspaceId}`;
  rows = await db.findUndispatchedListingJobs({
    olderThanSeconds: 0,
    maxRows: 1,
    maxAttempts: 5,
  });
  expect(rows[0]!.payload).toMatchObject({
    runId: c.run.id,
    stage: "quality_check",
  });
  expect(
    (await f.store.claim({ ...c.job, stage: "quality_check" })).status,
  ).toBe("claimed");
  rows = await db.findUndispatchedListingJobs({
    olderThanSeconds: 0,
    maxRows: 1,
    maxAttempts: 5,
  });
  expect(rows.some((r) => r.payload.runId === c.run.id)).toBe(false);
});
