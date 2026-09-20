import { createListingInputsHandler } from "./[id]/inputs/route";
import { createListingViewHandler } from "./[id]/route";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import {
  adoptWineProposal,
  readAdoptedWineDependencies,
  listingInputDigest,
} from "@wukong/db";
import { wineEnrichmentPolicySchema, emptyWorkingListing } from "@wukong/core";
import type {
  WineGenerationRequest,
  WineGenerationCandidate,
  WineStage,
} from "@wukong/core";
import {
  db,
  extracted,
} from "../../../../worker/src/wine-research.integration-fixture";
import { createWineEvidenceStageHandlers } from "../../../../worker/src/wine-verification-handler";
import { createWineStageStore } from "../../../../worker/src/wine-enrichment-runtime";
import { projectWineCandidate } from "../../../../worker/src/wine-candidate-projection";
import { runWineStage } from "../../../../worker/src/wine-enrichment-pipeline";
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
  workspaceId?: string,
  note?: string,
) {
  const f = await extracted(
    { mode, profile, workingContent, baseContent, workspaceId, note },
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
import { acceptListingOperation } from "../../../lib/listing-operation-service";
import { preflightWineCapability } from "../../../lib/wine-capability-client";
const WINE_EXECUTION_SNAPSHOT = {
  schemaVersion: 1,
  flowVersion: "wine-enrichment-v1",
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  contractVersion: "wine-contract@1",
  rulesVersion: "wine-grounding@1",
  maxOutputTokens: 4096,
  promptVersions: {
    extract: "wine-extract@1.0.0",
    verify: "wine-verify@1.0.0",
    generate: "wine-generate@1.0.0",
    check: "wine-check@1.0.0",
  },
};

beforeEach(() => {
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
  vi.stubEnv("QUEUE_INGRESS_URL", "https://worker.test");
  vi.stubEnv("QUEUE_INGRESS_SECRET", "synthetic");
});
afterEach(() => vi.unstubAllEnvs());
async function receipt(mode: "copy" | "section", now = Date.now()) {
  return preflightWineCapability({
    mode,
    now: () => now,
    fetch: async () =>
      Response.json({
        authenticated: true,
        fullResearchConfigured: true,
        wine: {
          schemaVersion: 1,
          execution: WINE_EXECUTION_SNAPSHOT,
          databaseSchemaVersion: "wine-enrichment-0042-v1",
          buildSha: "abcdef0",
          consumerSupported: true,
          goConfigured: true,
          tavilyConfigured: false,
          queueReady: true,
          databaseReady: true,
        },
      }),
  });
}
async function completedBase(workspaceId?: string) {
  const f = await setup(
    "full",
    false,
    undefined,
    undefined,
    false,
    workspaceId,
  );
  for (const s of ["generation", "quality_check", "commit_candidate"] as const)
    expect(await f.run(s)).toMatchObject({
      status: s === "commit_candidate" ? "completed" : "advanced",
    });
  await db.forWorkspace(f.workspaceId, async (r) => {
    await r.workspaces.updateProfile({
      name: "Synthetic",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      requiredFields: [],
      brandBackgroundColor: null,
      ...profile,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        allowedDomains: [],
        tavilyCreditCap: 0,
      }),
    });
  });
  return f;
}
async function requestFor(
  f: Awaited<ReturnType<typeof setup>>,
  mode: "copy" | "section" = "copy",
) {
  return db.forWorkspace(f.workspaceId, async (r) => {
    const listing = await r.listings.requireById(f.job.draftId);
    return {
      workspaceId: f.workspaceId,
      listingId: listing.id,
      expectedInputRevision: listing.inputRevision,
      baseVersionId: listing.activeVersionId,
      operationKey: randomUUID(),
      actorId: "tester",
      wineMode: mode,
      ...(mode === "section" ? { wineSection: "introduction" as const } : {}),
    };
  });
}
async function accept(
  input: Awaited<ReturnType<typeof requestFor>>,
  cap?: Awaited<ReturnType<typeof receipt>>,
) {
  return db.forWorkspace(input.workspaceId, (r) =>
    acceptListingOperation(r, input, { wineCapability: cap }),
  );
}
it.each(["copy", "section"] as const)(
  "atomically admits %s into real three-stage runtime and repeated changed bilingual copy",
  async (mode) => {
    const f = await completedBase();
    const baselineCalls = f.calls.length;
    for (let round = 0; round < 2; round++) {
      const input = await requestFor(f, mode);
      const a = await accept(input, await receipt(mode));
      expect(a.outbox).toHaveLength(1);
      expect(a.outbox[0]).toMatchObject({
        dedupeKey: `wine-run:${a.run.id}:generation`,
        payload: { stage: "generation", flowVersion: "wine-enrichment-v1" },
      });
      const saved = await db.forWorkspace(f.workspaceId, (r) =>
        r.pipelineRuns.getOperation(a.run.id),
      );
      expect(saved!.execution).toMatchObject({
        wineMode: mode,
        wineCapability: { mode, capability: { tavilyConfigured: false } },
        wineBudget: {
          goPhysicalCalls: 4,
          goReservedUsd: "1.277952",
          tavilyCredits: 0,
        },
        wineCopy: {
          mode,
          section: mode === "section" ? "introduction" : null,
          baseVersionId: input.baseVersionId,
        },
      });
      expect(
        await admin`select reserved_usd from ai_budget_reservations where pipeline_run_id=${a.run.id}`,
      ).toMatchObject([{ reserved_usd: "1.277952" }]);
      expect(
        await admin`select * from search_budget_reservations where pipeline_run_id=${a.run.id}`,
      ).toHaveLength(0);
      expect((await accept(input)).run.id).toBe(a.run.id);
      f.control.mutateCandidate = (value, req) => {
        const text =
          round === 0
            ? {
                en: "The bottle holds 750 ml.",
                "zh-Hant": "這瓶的容量是 750 毫升。",
              }
            : {
                en: "This wine is presented in a 750 ml bottle.",
                "zh-Hant": "此酒採用 750 毫升瓶裝。",
              };
        Object.assign(value.content.sections[0]!, text);
        for (const annotation of value.annotations)
          if (annotation.path.startsWith("sections.introduction."))
            annotation.span =
              text[annotation.path.endsWith(".en") ? "en" : "zh-Hant"];
        if (mode === "section") {
          value.content.title = req.current!.title;
          value.content.seo = req.current!.seo;
          value.content.tags = req.current!.tags;
          value.annotations = value.annotations.filter((x) =>
            x.path.startsWith("sections.introduction."),
          );
        }
      };
      for (const stage of [
        "generation",
        "quality_check",
        "commit_candidate",
      ] as const) {
        const result = await runWineStage(
          {
            ...f.job,
            runId: a.run.id,
            inputRevision: a.run.inputRevision,
            activeVersionSequence: a.run.activeVersionSequence,
            stage,
          },
          { store: f.store, ...f.handlers },
        );
        expect(result, JSON.stringify({ round, stage, result })).toMatchObject({
          status: stage === "commit_candidate" ? "completed" : "advanced",
        });
      }
      const adopted = await db.forWorkspace(f.workspaceId, async (r) =>
        readAdoptedWineDependencies(r, {
          workspaceId: f.workspaceId,
          listingId: input.listingId,
          versionId: (await r.listings.requireById(input.listingId))
            .activeVersionId!,
          inputRevision: input.expectedInputRevision,
        }),
      );
      expect(adopted).toMatchObject({
        status: "available",
        refreshRequired: false,
      });
      if (adopted.status === "available")
        expect(adopted.origins.every((x) => x.runId === f.job.runId)).toBe(
          true,
        );
      expect(
        await admin`select * from wine_search_calls where run_id=${a.run.id}`,
      ).toHaveLength(0);
    }
    expect(f.calls.slice(baselineCalls)).toEqual([
      "generation",
      "quality_check",
      "generation",
      "quality_check",
    ]);
  },
);
import { createProcessListingHandler } from "./[id]/process/route";
function processHandler(
  f: Awaited<ReturnType<typeof setup>>,
  role = "operator",
) {
  return createProcessListingHandler({
    getDatabase: () => db,
    sessionContext: {
      resolve: async () => ({
        workspaceId: f.workspaceId,
        actorId: "tester",
        role,
      }),
    } as never,
    publisher: { enqueue: vi.fn() } as never,
    preflightWineCapability: (options) =>
      receipt(options?.mode as "copy" | "section"),
  });
}
function processRequest(body: object, key: string = randomUUID()) {
  return new Request("https://local/api/listings/process", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}
it("authenticated section route accepts selected section with uppercase UUID replay and rejects substitution", async () => {
  const f = await completedBase(),
    input = await requestFor(f, "section"),
    handler = processHandler(f);
  const body = {
    expectedInputRevision: input.expectedInputRevision,
    baseVersionId: input.baseVersionId!.toUpperCase(),
    wineMode: "section",
    wineSection: "introduction",
  };
  const context = {
    params: Promise.resolve({ id: input.listingId.toUpperCase() }),
  };
  const result = await handler(
    processRequest(body, input.operationKey.toUpperCase()),
    context,
  );
  expect(result.status).toBe(202);
  const first = await result.json();
  const replay = await handler(
    processRequest(body, input.operationKey),
    context,
  );
  expect(replay.status).toBe(202);
  expect((await replay.json()).processing.runId).toBe(first.processing.runId);
  expect(
    (
      await handler(
        processRequest({ ...body, wineSection: "tasting" }, input.operationKey),
        context,
      )
    ).status,
  ).toBe(409);
  for (const extra of [
    "wineCopy",
    "wineCapability",
    "wineBudget",
    "claims",
    "ready",
  ])
    expect(
      (await handler(processRequest({ ...body, [extra]: {} }), context)).status,
    ).toBe(400);
  expect(
    (await processHandler(f, "viewer")(processRequest(body), context)).status,
  ).toBe(403);
});
it.each(["missing", "forged", "stale", "mode"] as const)(
  "copy admission rejects %s opaque receipt and leaves no operation",
  async (kind) => {
    const f = await completedBase(),
      input = await requestFor(f);
    const cap =
      kind === "missing"
        ? undefined
        : kind === "forged"
          ? {}
          : await receipt(
              kind === "mode" ? "section" : "copy",
              kind === "stale" ? Date.now() - 31000 : Date.now(),
            );
    await expect(accept(input, cap as never)).rejects.toMatchObject({
      code:
        kind === "stale" ? "wine_capability_stale" : "wine_capability_required",
    });
    expect(
      await db.forWorkspace(f.workspaceId, (r) =>
        r.pipelineRuns.findOperationRequest(
          input.listingId,
          input.operationKey,
        ),
      ),
    ).toBeNull();
  },
);
it.each(["base", "revision", "foreign", "missing", "section"] as const)(
  "copy admission rejects %s binding",
  async (kind) => {
    const f = await completedBase(),
      input = await requestFor(f, kind === "section" ? "section" : "copy");
    if (kind === "base") input.baseVersionId = randomUUID();
    if (kind === "revision") input.expectedInputRevision++;
    if (kind === "foreign") input.workspaceId = `foreign-${randomUUID()}`;
    if (kind === "missing")
      await db.forWorkspace(f.workspaceId, async (r) => {
        const l = await r.listings.create({ target: "shopline" });
        const current = await r.listingInputs.initialize(
          { listingId: l.id, actorId: "tester" },
          { workspaceId: f.workspaceId, actorId: "tester", entityId: l.id },
          r.audit,
        );
        input.listingId = l.id;
        input.baseVersionId = null;
        input.expectedInputRevision = current.revision;
      });
    if (kind === "section") input.wineSection = "tasting" as never;
    await expect(
      accept(input, await receipt(input.wineMode)),
    ).rejects.toMatchObject({
      code:
        kind === "base"
          ? "base_version_conflict"
          : kind === "revision"
            ? "input_revision_conflict"
            : kind === "foreign"
              ? "listing_not_found"
              : "evidence_refresh_required",
    });
  },
);
it.each(["outbox", "audit"] as const)(
  "copy %s failure rolls back run, hold, outbox and audit inside savepoint",
  async (failure) => {
    const f = await completedBase(),
      input = await requestFor(f),
      cap = await receipt("copy");
    const before =
      await admin`select count(*)::int as count from listing_dispatch_outbox where workspace_id=${f.workspaceId}`;
    await db.forWorkspace(f.workspaceId, async (r) => {
      const repositories = {
        ...r,
        ...(failure === "outbox"
          ? {
              dispatchOutbox: {
                ...r.dispatchOutbox,
                record: async (
                  ...args: Parameters<typeof r.dispatchOutbox.record>
                ) => {
                  await r.dispatchOutbox.record(...args);
                  throw Error("synthetic failure");
                },
              },
            }
          : {
              audit: {
                ...r.audit,
                write: async (...args: Parameters<typeof r.audit.write>) => {
                  await r.audit.write(...args);
                  throw Error("synthetic failure");
                },
              },
            }),
      };
      await expect(
        acceptListingOperation(repositories, input, { wineCapability: cap }),
      ).rejects.toThrow("synthetic failure");
      expect(
        await r.pipelineRuns.findOperationRequest(
          input.listingId,
          input.operationKey,
        ),
      ).toBeNull();
      expect(
        await r.audit.countByActionSince(
          "listing.processing_accepted",
          new Date(0),
        ),
      ).toBe(0);
    });
    expect(
      await admin`select count(*)::int as count from listing_dispatch_outbox where workspace_id=${f.workspaceId}`,
    ).toEqual(before);
    const accepted = await accept(input, await receipt("copy"));
    expect(accepted.outbox).toHaveLength(1);
  },
);
it.each(["unadopted", "forged-origin", "registry"] as const)(
  "admission live reader rejects %s original evidence",
  async (kind) => {
    const f = await completedBase(),
      input = await requestFor(f),
      cap = await receipt("copy");
    await db.forWorkspace(f.workspaceId, async (r) => {
      const repositories = {
        ...r,
        wineEnrichment: {
          ...r.wineEnrichment,
          ...(kind === "registry" ? { readAuthorities: async () => [] } : {}),
          readVersionOrigin: async (
            ...args: Parameters<typeof r.wineEnrichment.readVersionOrigin>
          ) => {
            const row = await r.wineEnrichment.readVersionOrigin(...args);
            if (!row) return row;
            return kind === "unadopted"
              ? { ...row, runId: null }
              : kind === "forged-origin"
                ? { ...row, pipelineIdempotencyKey: "forged" }
                : row;
          },
        },
      };
      if (kind === "registry") {
        // Registry digest is current authority, even where selected support is local.
        repositories.wineEnrichment.readAuthorities = async () =>
          [{ forged: true }] as never;
      }
      await expect(
        acceptListingOperation(repositories, input, { wineCapability: cap }),
      ).rejects.toMatchObject({ code: "evidence_refresh_required" });
      expect(
        await r.pipelineRuns.findOperationRequest(
          input.listingId,
          input.operationKey,
        ),
      ).toBeNull();
    });
  },
);
it.each(["manual-identity", "locked-description"] as const)(
  "admission rejects saved %s changes",
  async (kind) => {
    const f = await completedBase(),
      input = await requestFor(f, "section");
    await db.forWorkspace(f.workspaceId, async (r) => {
      const review = (await r.listings.getReviewSnapshot(input.listingId))!;
      await r.listingInputs.save(
        {
          listingId: input.listingId,
          actorId: "tester",
          expectedInputRevision: input.expectedInputRevision,
          baseVersionId: input.baseVersionId,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          changes:
            kind === "manual-identity"
              ? [
                  {
                    field: "title.en",
                    value: "Different product",
                    state: "manual",
                  },
                ]
              : [
                  {
                    field: "description.en",
                    value: review.activeVersion!.content.description.en,
                    state: "manual",
                    locked: true,
                  },
                ],
        },
        {
          workspaceId: f.workspaceId,
          actorId: "tester",
          entityId: input.listingId,
        },
        r.audit,
      );
    });
    await expect(
      accept(await requestFor(f, "section"), await receipt("section")),
    ).rejects.toMatchObject({ code: "evidence_refresh_required" });
  },
);
it("last Go budget competition preserves unknown hold and admits only one copy with no search holds", async () => {
  const first = await completedBase(),
    second = await completedBase(first.workspaceId);
  await admin`update ai_budget_reservations set state='unknown', reserved_usd=8.7, settled_usd=null where pipeline_run_id=${first.job.runId}`;
  const inputs = await Promise.all([requestFor(first), requestFor(second)]),
    cap = await receipt("copy");
  const results = await Promise.allSettled(inputs.map((i) => accept(i, cap)));
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "wine_go_budget_blocked" },
  });
  expect(
    await admin`select state,reserved_usd from ai_budget_reservations where pipeline_run_id=${first.job.runId}`,
  ).toMatchObject([{ state: "unknown", reserved_usd: "8.700000" }]);
  for (let i = 0; i < results.length; i++) {
    const run = await db.forWorkspace(first.workspaceId, (r) =>
      r.pipelineRuns.findOperationRequest(
        inputs[i]!.listingId,
        inputs[i]!.operationKey,
      ),
    );
    if (results[i]!.status === "rejected") expect(run).toBeNull();
    else
      expect(
        await admin`select * from search_budget_reservations where pipeline_run_id=${run!.id}`,
      ).toHaveLength(0);
  }
});
it("concurrent duplicate copy admissions produce one operation, hold and outbox", async () => {
  const f = await completedBase(),
    input = await requestFor(f),
    cap = await receipt("copy");
  const [a, b] = await Promise.all([accept(input, cap), accept(input, cap)]);
  expect(a.run.id).toBe(b.run.id);
  expect(a.outbox.length + b.outbox.length).toBe(1);
  expect(
    await admin`select id from ai_budget_reservations where pipeline_run_id=${a.run.id}`,
  ).toHaveLength(1);
});
it.each(["registry", "input"] as const)(
  "acceptance retains %s serialization until outer COMMIT",
  async (kind) => {
    const f = await completedBase(),
      input = await requestFor(f),
      cap = await receipt("copy");
    let release!: () => void,
      signal!: () => void,
      written = false;
    const held = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (signal = r));
    const admission = db.forWorkspace(f.workspaceId, async (r) => {
      const a = await acceptListingOperation(r, input, { wineCapability: cap });
      signal();
      await held;
      return a;
    });
    await ready;
    const writer = db.forWorkspace(f.workspaceId, async (r) => {
      if (kind === "registry") await r.wineEnrichment.lockAuthorities();
      else await r.listings.lockReviewState(input.listingId);
      written = true;
    });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(written).toBe(false);
    } finally {
      release();
    }
    const a = await admission;
    await writer;
    expect(a.outbox[0]!.payload.stage).toBe("generation");
  },
);
it("copy keeps exact four physical Go ceiling with both repairs and zero search calls", async () => {
  const f = await completedBase(),
    input = await requestFor(f),
    a = await accept(input, await receipt("copy"));
  const calls: string[] = [];
  const handlers = createWineEvidenceStageHandlers({
    ...f.config,
    transport: {
      fetch: async (_url, init) => {
        const envelope = JSON.parse(String(init!.body));
        const value = JSON.parse(envelope.messages[1].content);
        // A repair receives the same prompt plus schema repair instructions.
        const stage = value.candidate ? "quality_check" : "generation";
        calls.push(stage);
        if (calls.filter((x) => x === stage).length === 1)
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
  ] as const) {
    const result = await runWineStage(
      {
        ...f.job,
        runId: a.run.id,
        inputRevision: a.run.inputRevision,
        activeVersionSequence: a.run.activeVersionSequence,
        stage,
      },
      { store: f.store, ...handlers },
    );
    expect(result).toMatchObject({
      status: stage === "commit_candidate" ? "completed" : "advanced",
    });
  }
  expect(calls).toEqual([
    "generation",
    "generation",
    "quality_check",
    "quality_check",
  ]);
  expect(
    await admin`select * from wine_search_calls where run_id=${a.run.id}`,
  ).toHaveLength(0);
  expect(
    await admin`select * from search_budget_reservations where pipeline_run_id=${a.run.id}`,
  ).toHaveLength(0);
});
import { ready as webEvidenceReady } from "../../../../worker/src/wine-candidate-projection.fixture";
it.each(["compatible", "empty-domains", "changed-domains", "expired"] as const)(
  "retained web evidence admission enforces %s policy and original age",
  async (kind) => {
    const f = await webEvidenceReady(
      emptyWorkingListing(),
      (x) => x,
      undefined,
      1,
    );
    const committed = await f.store.commitCandidate(f.context);
    expect(committed.status).toBe("completed");
    const input = await db.forWorkspace(f.job.workspaceId, async (r) => {
      await r.workspaces.updateProfile({
        name: "Synthetic",
        currency: "HKD",
        locales: ["en", "zh-Hant"],
        requiredFields: [],
        brandBackgroundColor: null,
        ...profile,
        wineEnrichment: wineEnrichmentPolicySchema.parse({
          enabled: true,
          tavilyCreditCap: 0,
          allowedDomains:
            kind === "empty-domains"
              ? []
              : kind === "changed-domains"
                ? ["other.test"]
                : ["wine.test"],
        }),
      });
      const l = await r.listings.requireById(f.job.draftId);
      return {
        workspaceId: f.job.workspaceId,
        listingId: l.id,
        expectedInputRevision: l.inputRevision,
        baseVersionId: l.activeVersionId,
        operationKey: randomUUID(),
        actorId: "tester",
        wineMode: "copy" as const,
      };
    });
    const cap = await receipt("copy");
    const attempt = db.forWorkspace(input.workspaceId, (r) =>
      acceptListingOperation(
        kind === "expired"
          ? {
              ...r,
              pipelineRuns: {
                ...r.pipelineRuns,
                acceptanceTimestamp: async () =>
                  new Date(
                    Date.parse(f.source.capturedAt) + 7 * 86400000,
                  ).toISOString(),
              },
            }
          : r,
        input,
        { wineCapability: cap },
      ),
    );
    if (kind === "compatible") {
      const accepted = await attempt;
      expect(accepted.outbox[0]!.payload.stage).toBe("generation");
      expect(
        await admin`select * from search_budget_reservations where pipeline_run_id=${accepted.run.id}`,
      ).toHaveLength(0);
    } else
      await expect(attempt).rejects.toMatchObject({
        code: "evidence_refresh_required",
      });
  },
);
it.each(["copy", "section"] as const)(
  "accepted %s preserves outside protected section, metadata and commercial values",
  async (mode) => {
    const protectedSection = {
      key: "tasting" as const,
      en: "Operator tasting paragraph",
      "zh-Hant": "操作員品酒段落",
      claimIds: ["00000000-0000-4000-8000-000000000099"],
      owner: "operator" as const,
      locked: true,
    };
    const base = {
      ...emptyWorkingListing(),
      packQuantity: 1,
      volumeMl: 750,
      producer: "Fixture Estate",
      vintage: 2020,
      abvPercent: 13,
      priceHkd: 400,
      stockQuantity: 12,
      sku: "MERCHANT-SKU",
      title: { en: "Baseline title", "zh-Hant": "原有標題" },
      seo: {
        title: { en: "Baseline title", "zh-Hant": "原有標題" },
        description: { en: "Baseline title", "zh-Hant": "原有標題" },
      },
      description: {
        en: protectedSection.en,
        "zh-Hant": protectedSection["zh-Hant"],
      },
      wineOwnership: {
        schemaVersion: 1 as const,
        sections: [protectedSection],
      },
    };
    const f = await setup("full", false, emptyWorkingListing(), base);
    f.control.mutateCandidate = (v, r) =>
      v.content.sections.push(...structuredClone(r.current!.sections));
    for (const stage of [
      "generation",
      "quality_check",
      "commit_candidate",
    ] as const)
      expect(await f.run(stage)).toMatchObject({
        status: stage === "commit_candidate" ? "completed" : "advanced",
      });
    await db.forWorkspace(f.workspaceId, async (r) => {
      const run = (await r.pipelineRuns.getOperation(f.job.runId))!;
      await adoptWineProposal(r, {
        workspaceId: f.workspaceId,
        listingId: run.listingId,
        runId: run.id,
        actorId: "tester",
        expectedInputRevision: run.inputRevision,
        baseVersionId: run.baseVersionId!,
        operationKey: randomUUID(),
        selectedPaths:
          mode === "copy"
            ? [
                "sections.introduction",
                "title.en",
                "title.zh-Hant",
                "seo.title.en",
                "seo.title.zh-Hant",
                "seo.description.en",
                "seo.description.zh-Hant",
              ]
            : ["sections.introduction"],
      });
    });
    // Task11: use the real authenticated HTTP save/read surfaces, then regenerate
    // another paragraph through the real persisted pipeline below.
    const sessionContext = {
      resolve: async () => ({
        workspaceId: f.workspaceId,
        actorId: "tester",
        role: "operator" as const,
      }),
    };
    const saveParagraph = createListingInputsHandler({
      sessionContext,
      getDatabase: () => db,
    });
    const readListing = createListingViewHandler({
      sessionContext,
      getDatabase: () => db,
      getAssetStore: () => ({
        createReadUrl: async () => ({
          url: "https://fixture.test/image",
          expiresAt: new Date(Date.now() + 60000),
        }),
      }),
      connectionStatus: async () => "disconnected",
    });
    const editContext = { params: Promise.resolve({ id: f.job.draftId }) };
    const initialView = await (
      await readListing(new Request("http://localhost/listing"), editContext)
    ).json();
    const currentInput = initialView.workingInput;
    const editedText = {
      en: "My saved tasting paragraph",
      "zh-Hant": "我已儲存的品酒段落",
    };
    const savedParagraph = await saveParagraph(
      new Request("http://localhost/inputs", {
        method: "PATCH",
        headers: {
          "Idempotency-Key": randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedInputRevision: currentInput!.revision,
          baseVersionId: currentInput!.baseVersionId,
          sectionChanges: [{ key: "tasting", ...editedText, locked: true }],
          action: "save",
        }),
      }),
      editContext,
    );
    expect(savedParagraph.status).toBe(200);
    Object.assign(protectedSection, editedText, { claimIds: [] });
    const reloaded = await readListing(
      new Request("http://localhost/listing"),
      editContext,
    );
    expect(reloaded.status).toBe(200);
    const reloadedView = await reloaded.json();
    expect(
      reloadedView.workingInput.workingContent.wineOwnership.sections.find(
        (section: { key: string }) => section.key === "tasting",
      ),
    ).toEqual(protectedSection);
    expect(reloadedView.workingInput.revision).toBe(currentInput!.revision + 1);
    await db.forWorkspace(f.workspaceId, async (r) => {
      await r.workspaces.updateProfile({
        name: "Synthetic",
        currency: "HKD",
        locales: ["en", "zh-Hant"],
        requiredFields: [],
        brandBackgroundColor: null,
        ...profile,
        wineEnrichment: wineEnrichmentPolicySchema.parse({
          enabled: true,
          allowedDomains: [],
          tavilyCreditCap: 0,
        }),
      });
    });
    const input = await requestFor(f, mode),
      a = await accept(input, await receipt(mode));
    const before = await db.forWorkspace(f.workspaceId, (r) =>
      r.listings.getReviewSnapshot(input.listingId),
    );
    f.control.mutateCandidate = (v, r) => {
      v.content = structuredClone(r.current!);
      const section = v.content.sections.find((x) => x.key === "introduction")!;
      section.en = "This wine is presented in a 750 ml bottle.";
      section["zh-Hant"] = "此酒採用 750 毫升瓶裝。";
      const cl = r.claims.find((x) => x.field === "volumeMl")!;
      v.annotations = (["en", "zh-Hant"] as const).map((lang) => ({
        path: `sections.introduction.${lang}`,
        span: section[lang],
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
      expect(
        await runWineStage(
          {
            ...f.job,
            runId: a.run.id,
            inputRevision: a.run.inputRevision,
            activeVersionSequence: a.run.activeVersionSequence,
            stage,
          },
          { store: f.store, ...f.handlers },
        ),
      ).toMatchObject({
        status: stage === "commit_candidate" ? "completed" : "advanced",
      });
    await db.forWorkspace(f.workspaceId, (r) =>
      adoptWineProposal(r, {
        workspaceId: f.workspaceId,
        listingId: input.listingId,
        runId: a.run.id,
        actorId: "tester",
        expectedInputRevision: a.run.inputRevision,
        baseVersionId: a.run.baseVersionId!,
        operationKey: randomUUID(),
        selectedPaths: ["sections.introduction"],
      }),
    );
    const after = await db.forWorkspace(f.workspaceId, (r) =>
      r.listings.getReviewSnapshot(input.listingId),
    );
    expect(
      after!.activeVersion!.content.wineOwnership!.sections.find(
        (x) => x.key === "tasting",
      ),
    ).toEqual(protectedSection);
    for (const key of [
      "title",
      "seo",
      "tags",
      "priceHkd",
      "stockQuantity",
      "sku",
    ] as const)
      expect(after!.activeVersion!.content[key]).toEqual(
        before!.activeVersion!.content[key],
      );
    await expect(
      accept(
        {
          ...(await requestFor(f, "section")),
          wineSection: "tasting" as never,
        },
        await receipt("section"),
      ),
    ).rejects.toMatchObject({ code: "evidence_refresh_required" });
  },
);
it("legacy adopted description remains intact and cannot masquerade as structured section dependencies", async () => {
  const f = await webEvidenceReady({
    ...emptyWorkingListing(),
    description: { en: "Manual description", "zh-Hant": "手動描述" },
  });
  expect((await f.store.commitCandidate(f.context)).status).toBe("completed");
  const input = await db.forWorkspace(f.job.workspaceId, async (r) => {
    await r.workspaces.updateProfile({
      name: "Synthetic",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      requiredFields: [],
      brandBackgroundColor: null,
      ...profile,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        allowedDomains: [],
        tavilyCreditCap: 0,
      }),
    });
    const l = await r.listings.requireById(f.job.draftId);
    return {
      workspaceId: f.job.workspaceId,
      listingId: l.id,
      expectedInputRevision: l.inputRevision,
      baseVersionId: l.activeVersionId,
      operationKey: randomUUID(),
      actorId: "tester",
      wineMode: "section" as const,
      wineSection: "introduction" as const,
    };
  });
  await expect(accept(input, await receipt("section"))).rejects.toMatchObject({
    code: "evidence_refresh_required",
  });
  const review = await db.forWorkspace(input.workspaceId, (r) =>
    r.listings.getReviewSnapshot(input.listingId),
  );
  expect(review!.activeVersion!.content.description).toEqual({
    en: "Manual description",
    "zh-Hant": "手動描述",
  });
});
it("accepted copy unknown Go response keeps hold and cannot replay or start quality", async () => {
  const f = await completedBase(),
    a = await accept(await requestFor(f), await receipt("copy"));
  f.control.unknownStage = "generation";
  const job = {
    ...f.job,
    runId: a.run.id,
    inputRevision: a.run.inputRevision,
    activeVersionSequence: a.run.activeVersionSequence,
    stage: "generation" as const,
  };
  const before = f.calls.length;
  expect(
    await runWineStage(job, { store: f.store, ...f.handlers }),
  ).toMatchObject({ status: "blocked", code: "generation_outcome_unknown" });
  await runWineStage(job, { store: f.store, ...f.handlers });
  expect(f.calls.length - before).toBe(1);
  expect(
    await admin`select state,reserved_usd from ai_budget_reservations where pipeline_run_id=${a.run.id}`,
  ).toMatchObject([{ state: "unknown", reserved_usd: "1.277952" }]);
  expect(
    await admin`select * from search_budget_reservations where pipeline_run_id=${a.run.id}`,
  ).toHaveLength(0);
});

it("retained validated copy title survives partial research adoption but later manual title invalidates", async () => {
  const f = await setup(
    "research",
    false,
    undefined,
    undefined,
    false,
    undefined,
    "Producer: Fixture Estate\nProduct: Reserve Red\nVolume: 750 ml\nPack quantity: 1 bottles\nMarket: HK",
  );
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    await f.run(stage);
  await db.forWorkspace(f.workspaceId, (r) =>
    r.workspaces.updateProfile({
      name: "Synthetic",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      requiredFields: [],
      brandBackgroundColor: null,
      ...profile,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        allowedDomains: [],
        tavilyCreditCap: 0,
      }),
    }),
  );
  const input = await requestFor(f),
    copy = await accept(input, await receipt("copy"));
  const title = { en: "A bottle with 750 ml", "zh-Hant": "750 ml bottle B" };
  f.control.mutateCandidate = (v) => {
    v.content.title = title;
    v.content.sections[0]!.en = "The bottle contains 750 ml.";
    v.content.sections[0]!["zh-Hant"] = "750 ml bottle paragraph B";
    for (const annotation of v.annotations) {
      const lang = annotation.path.endsWith(".en") ? "en" : "zh-Hant";
      if (annotation.path.startsWith("title.")) annotation.span = title[lang];
      if (annotation.path.startsWith("sections.introduction."))
        annotation.span = v.content.sections[0]![lang];
    }
  };
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    expect(
      await runWineStage(
        {
          ...f.job,
          runId: copy.run.id,
          inputRevision: copy.run.inputRevision,
          activeVersionSequence: copy.run.activeVersionSequence,
          stage,
        },
        { store: f.store, ...f.handlers },
      ),
    ).toMatchObject({
      status: stage === "commit_candidate" ? "completed" : "advanced",
    });
  await db.forWorkspace(f.workspaceId, (r) =>
    adoptWineProposal(r, {
      workspaceId: f.workspaceId,
      listingId: input.listingId,
      runId: copy.run.id,
      actorId: "tester",
      expectedInputRevision: copy.run.inputRevision,
      baseVersionId: copy.run.baseVersionId!,
      operationKey: randomUUID(),
      selectedPaths: [
        "title.en",
        "title.zh-Hant",
        "seo.title.en",
        "seo.title.zh-Hant",
        "seo.description.en",
        "seo.description.zh-Hant",
        "sections.introduction",
      ],
    }),
  );
  const research = await webEvidenceReady(
    emptyWorkingListing(),
    undefined,
    undefined,
    0,
    false,
    {
      workspaceId: f.workspaceId,
      listingId: input.listingId,
      mode: "research",
    },
  );
  await db.forWorkspace(f.workspaceId, (r) =>
    r.searchBudgetReservations.reserve({
      pipelineRunId: research.run.id,
      reservedCredits: 5,
      workspaceCapCredits: 100,
      policyVersion: "wine-enrichment@1",
    }),
  );
  expect(await research.store.commitCandidate(research.context)).toMatchObject({
    outcome: "proposed",
  });
  const saved = await db.forWorkspace(f.workspaceId, (r) =>
    adoptWineProposal(r, {
      workspaceId: f.workspaceId,
      listingId: input.listingId,
      runId: research.run.id,
      actorId: "tester",
      expectedInputRevision: research.run.inputRevision,
      baseVersionId: research.run.baseVersionId!,
      operationKey: randomUUID(),
      selectedPaths: ["country"],
    }),
  );
  const adopted = await db.forWorkspace(f.workspaceId, (r) =>
    readAdoptedWineDependencies(r, {
      workspaceId: f.workspaceId,
      listingId: input.listingId,
      versionId: saved.versionId,
      inputRevision: research.run.inputRevision,
    }),
  );
  expect(adopted).toMatchObject({
    status: "available",
    refreshRequired: false,
  });
  if (adopted.status !== "available") throw Error(adopted.code);
  expect(adopted.adopted.title).toEqual(title);
  expect(
    adopted.supports.every((s) => s.valid && s.originRunId === f.job.runId),
  ).toBe(true);
  const nextCopy = await accept(await requestFor(f), await receipt("copy"));
  const copyRun = await db.forWorkspace(f.workspaceId, (r) =>
    r.pipelineRuns.getOperation(nextCopy.run.id),
  );
  expect(copyRun!.execution.wineCopy).toMatchObject({
    baseVersionId: saved.versionId,
  });
  await db.forWorkspace(f.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: input.listingId,
        actorId: "tester",
        expectedInputRevision: research.run.inputRevision,
        baseVersionId: saved.versionId,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [
          { field: "title.en", value: "Another product", state: "manual" },
        ],
      },
      {
        workspaceId: f.workspaceId,
        actorId: "tester",
        entityId: input.listingId,
      },
      r.audit,
    ),
  );
  await expect(
    accept(await requestFor(f), await receipt("copy")),
  ).rejects.toMatchObject({ code: "evidence_refresh_required" });
});

it("title-only validated copy adoption retains supported automatic prose", async () => {
  const f = await completedBase();
  const input = await requestFor(f),
    copy = await accept(input, await receipt("copy"));
  const before = await db.forWorkspace(f.workspaceId, (r) =>
    r.listings.getReviewSnapshot(input.listingId),
  );
  const title = { en: "A bottle with 750 ml", "zh-Hant": "750 ml bottle B" };
  f.control.mutateCandidate = (v, request) => {
    v.content = structuredClone(request.current!);
    v.content.title = title;
    const claim = request.claims.find((c) => c.field === "volumeMl")!;
    v.annotations = (["en", "zh-Hant"] as const).map((lang) => ({
      path: `title.${lang}`,
      span: title[lang],
      claimId: claim.id,
      value: claim.value,
      evidenceIds: claim.evidenceIds,
      premiseClaimIds: claim.premiseClaimIds,
    }));
  };
  for (const stage of [
    "generation",
    "quality_check",
    "commit_candidate",
  ] as const)
    expect(
      await runWineStage(
        {
          ...f.job,
          runId: copy.run.id,
          inputRevision: copy.run.inputRevision,
          activeVersionSequence: copy.run.activeVersionSequence,
          stage,
        },
        { store: f.store, ...f.handlers },
      ),
    ).toMatchObject({
      status: stage === "commit_candidate" ? "completed" : "advanced",
    });
  const saved = await db.forWorkspace(f.workspaceId, (r) =>
    adoptWineProposal(r, {
      workspaceId: f.workspaceId,
      listingId: input.listingId,
      runId: copy.run.id,
      actorId: "tester",
      expectedInputRevision: copy.run.inputRevision,
      baseVersionId: copy.run.baseVersionId!,
      operationKey: randomUUID(),
      selectedPaths: ["title.en", "title.zh-Hant"],
    }),
  );
  const adopted = await db.forWorkspace(f.workspaceId, (r) =>
    readAdoptedWineDependencies(r, {
      workspaceId: f.workspaceId,
      listingId: input.listingId,
      versionId: saved.versionId,
      inputRevision: copy.run.inputRevision,
    }),
  );
  expect(adopted).toMatchObject({
    status: "available",
    refreshRequired: false,
  });
  if (adopted.status !== "available") throw Error(adopted.code);
  expect(adopted.adopted.title).toEqual(title);
  expect(adopted.adopted.sections).toEqual(
    before!.activeVersion!.content.wineOwnership!.sections,
  );
  expect(
    adopted.supports.some(
      (s) =>
        s.path === "sections.introduction.en" &&
        s.valid &&
        s.originRunId === f.job.runId,
    ),
  ).toBe(true);
  await expect(
    accept(await requestFor(f), await receipt("copy")),
  ).resolves.toHaveProperty("run.id");
});
