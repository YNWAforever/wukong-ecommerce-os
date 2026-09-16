import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");
import { createDatabase } from "@wukong/db";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  wineIdentity,
} from "@wukong/core";
import { WINE_EXECUTION_SNAPSHOT } from "@wukong/ai";
import { operationAIForFlow } from "./operation-ai.js";
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw Error("dedicated localhost fixture required");
const db = createDatabase(url),
  admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
    onnotice: () => {},
  });
afterAll(async () => {
  await db.close();
  await admin.end();
});
const candidate = () => ({
  schemaVersion: 1 as const,
  content: {
    title: { en: "", "zh-Hant": "" },
    sections: [],
    seo: {
      title: { en: "", "zh-Hant": "" },
      description: { en: "", "zh-Hant": "" },
    },
    tags: [],
  },
  annotations: [],
});
function response(value: unknown, overrides = {}) {
  return Response.json({
    model: "deepseek-v4.1-flash",
    usage: { prompt_tokens: 100, completion_tokens: 50 },
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(value) },
      },
    ],
    ...overrides,
  });
}
async function fixture(duration = 800000) {
  const workspaceId = `wine-runtime-${randomUUID()}`;
  const run = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
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
          deadlineAt: new Date(Date.now() + duration).toISOString(),
          policyVersion: "wine-enrichment@1",
          rulesVersion: "wine-grounding@1",
          allowedDomains: ["wine.test"],
        },
      },
    });
    await r.aiBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedUsd: "3.194880",
      workspaceCapUsd: "10",
      pricingVersion: "wine-enrichment@1",
    });
    return run;
  });
  const request = {
    schemaVersion: 1 as const,
    binding: { workspaceId, operationId: run.id, inputRevision: 0 },
    claims: [],
    current: null,
    lockedPaths: [],
    tone: "neutral",
    claimPolicy: [],
    section: null,
  };
  function factory(fetch: typeof globalThis.fetch) {
    const selected = operationAIForFlow(
      db,
      {
        OPENCODE_GO_API_KEY: "synthetic",
        AI_PROVIDER: "fake",
        LISTING_PAID_OPERATIONS_ENABLED: "false",
      } as never,
      workspaceId,
      run,
      { fetch },
    );
    if (selected.flowVersion !== "wine-enrichment-v1")
      throw Error("wine expected");
    return selected.provider;
  }
  return { workspaceId, run, request, factory };
}
it("actual factory commits each repair before HTTP, pins session, and refuses terminal replay", async () => {
  const f = await fixture();
  let count = 0;
  const fetch = vi.fn(async (input: any, init: any) => {
    count++;
    const request = new Request(input, init);
    expect(request.headers.get("x-opencode-session")).toBe(f.run.id);
    expect(await request.json()).toMatchObject({
      model: "deepseek-v4.1-flash",
      max_tokens: 4096,
    });
    const rows =
      await admin`select status,call_ordinal,output from ai_runs where pipeline_run_id=${f.run.id} order by call_ordinal`;
    expect(rows).toHaveLength(count);
    expect(rows.at(-1)?.status).toBe("started");
    if (count === 2)
      expect(rows[0]!.output).toMatchObject({
        wineInvocation: { schemaRepairEligible: true },
      });
    return response(count === 1 ? {} : candidate());
  });
  await f.factory(fetch).generate(f.request);
  expect(count).toBe(2);
  await expect(f.factory(fetch).generate(f.request)).rejects.toThrow(
    /admission/,
  );
  expect(count).toBe(2);
  const rows =
    await admin`select status,estimated_cost_usd from ai_runs where pipeline_run_id=${f.run.id} order by call_ordinal`;
  expect(rows.map((r: any) => r.status)).toEqual(["failed", "succeeded"]);
  expect(rows.every((r: any) => Number(r.estimated_cost_usd) === 0.00009)).toBe(
    true,
  );
});
it.each(["cancelled", "revision", "deadline"])(
  "preserves actual usage after %s and prohibits the next HTTP",
  async (kind) => {
    const f = await fixture(kind === "deadline" ? 400 : 800000);
    let count = 0;
    const provider = f.factory(async () => {
      count++;
      if (kind === "cancelled")
        await db.forWorkspace(f.workspaceId, (r) =>
          r.pipelineRuns.setOperationState(f.run.id, "cancelled"),
        );
      if (kind === "revision")
        await admin`update listing_drafts set input_revision=1 where current_run_id=${f.run.id}`;
      if (kind === "deadline") await admin`select pg_sleep(0.5)`;
      return response(candidate());
    });
    await provider.generate(f.request);
    const rows =
      await admin`select status,input_tokens,output_tokens,estimated_cost_usd from ai_runs where pipeline_run_id=${f.run.id}`;
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(Number(rows[0]!.estimated_cost_usd)).toBe(0.00009);
    await expect(
      provider.check({ request: f.request, candidate: candidate() }),
    ).rejects.toThrow(/admission/);
    expect(count).toBe(1);
  },
);
it("deadline expires during reservation lock wait and prevents HTTP", async () => {
  const f = await fixture(400);
  const fetch = vi.fn(async () => response(candidate()));
  let acquired!: () => void;
  const gate = new Promise<void>((r) => (acquired = r));
  const held = admin.begin(async (tx: any) => {
    await tx`select pipeline_run_id from ai_budget_reservations where pipeline_run_id=${f.run.id} for update`;
    acquired();
    await tx`select pg_sleep(0.5)`;
  });
  await gate;
  await expect(f.factory(fetch).generate(f.request)).rejects.toThrow(
    /admission/,
  );
  await held;
  expect(fetch).not.toHaveBeenCalled();
});
it("unknown usage retains the complete financial hold and forbids another stage", async () => {
  const f = await fixture();
  const fetch = vi.fn(async () => response(candidate(), { usage: undefined }));
  const p = f.factory(fetch);
  await expect(p.generate(f.request)).rejects.toThrow(/usage/);
  const rows =
    await admin`select state,reserved_usd,settled_usd from ai_budget_reservations where pipeline_run_id=${f.run.id}`;
  expect(rows[0]).toMatchObject({ state: "unknown", settled_usd: null });
  expect(Number(rows[0]!.reserved_usd)).toBe(3.19488);
  await expect(
    p.check({ request: f.request, candidate: candidate() }),
  ).rejects.toThrow(/admission/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("five real logical stages retain separate verification coordinates", async () => {
  const f = await fixture();
  const identity = wineIdentity({ producer: null, productName: null });
  const outputs = [
    { schemaVersion: 1, identity, evidence: [] },
    {
      schemaVersion: 1,
      candidates: [],
      claims: [],
      supportProposals: [],
      needsDeepSearch: false,
      issues: [],
    },
    {
      schemaVersion: 1,
      candidates: [],
      claims: [],
      supportProposals: [],
      needsDeepSearch: false,
      issues: [],
    },
    candidate(),
    { schemaVersion: 1, issues: [] },
  ];
  const p = f.factory(async () => response(outputs.shift()));
  await p.extract({ assets: [], note: "" });
  const context = {
    schemaVersion: 1 as const,
    binding: f.request.binding,
    identity,
    sources: [],
    supports: [],
    authorities: [],
    reliableSourceIds: [],
    trustedObservationSourceIds: [],
    acceptedPremises: [],
    verifiedAliases: [],
    lockedFields: [],
    now: new Date().toISOString(),
  };
  await p.verify({ stage: "verification", context });
  await p.verify({ stage: "verification_deep", context });
  await p.generate(f.request);
  await p.check({ request: f.request, candidate: candidate() });
  const rows =
    await admin`select stage,status from ai_runs where pipeline_run_id=${f.run.id}`;
  expect(rows.map((r: any) => r.stage).sort()).toEqual([
    "extraction",
    "generation",
    "quality_check",
    "verification",
    "verification_deep",
  ]);
  expect(rows.every((r: any) => r.status === "succeeded")).toBe(true);
});

it.each(["refusal", "incomplete", "grounding", "second_schema_failure"])(
  "stores nonrepairable %s as terminal without authorizing another physical call",
  async (kind) => {
    const f = await fixture();
    let count = 0;
    const fetch = vi.fn(async () => {
      count++;
      if (kind === "refusal")
        return response(candidate(), {
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "", refusal: "no" },
            },
          ],
        });
      if (kind === "incomplete")
        return response(candidate(), {
          choices: [
            {
              finish_reason: "length",
              message: { role: "assistant", content: "{" },
            },
          ],
        });
      if (kind === "second_schema_failure") return response({});
      const invalid = candidate();
      invalid.content.title.en = "unsupported text";
      return response(invalid);
    });
    const p = f.factory(fetch);
    await expect(p.generate(f.request)).rejects.toThrow();
    expect(count).toBe(kind === "second_schema_failure" ? 2 : 1);
    const rows =
      await admin`select output from ai_runs where pipeline_run_id=${f.run.id} order by call_ordinal`;
    expect(rows.at(-1)?.output.wineInvocation.schemaRepairEligible).toBe(false);
    await expect(f.factory(fetch).generate(f.request)).rejects.toThrow(
      /admission/,
    );
    expect(count).toBe(kind === "second_schema_failure" ? 2 : 1);
  },
);
