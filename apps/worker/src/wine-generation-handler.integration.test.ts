import { afterAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  listingInputDigest,
  WINE_STAGE_ORDER,
  wineStageDependencyDigest,
  type WorkspaceRepositories,
  type Database,
  type StageRecord,
} from "@wukong/db";
import { emptyWorkingListing } from "@wukong/core";
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
          await admin`select status,stage from ai_runs where pipeline_run_id=${f.job.runId}`;
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
  for (const name of WINE_STAGE_ORDER.slice(
    0,
    WINE_STAGE_ORDER.indexOf(stage) + 1,
  )) {
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
        rows.find((row) => row.stage === name) ?? null,
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
