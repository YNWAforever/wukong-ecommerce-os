import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  createWineBudgetSnapshot,
  wineEnrichmentPolicySchema,
  type WineMode,
} from "@wukong/core";
import { createDatabase } from "../index.js";
import { createWineGoStore } from "./wine-go-invocations.js";
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw new Error("dedicated local fixture required");
const db = createDatabase(url);
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
const store = createWineGoStore(db);
afterAll(async () => {
  await db.close();
  await admin.end();
});
const prompts = {
  extract: "wine-extract@1.0.0",
  verify: "wine-verify@1.0.0",
  generate: "wine-generate@1.0.0",
  check: "wine-check@1.0.0",
};
async function fixture(
  mode: WineMode = "full",
  mutate: (e: any) => void = () => {},
  reserve = true,
) {
  const workspaceId = `go-${randomUUID()}`;
  const execution: any = {
    schemaVersion: 1,
    flowVersion: "wine-enrichment-v1",
    wineMode: mode,
    wineBudget: createWineBudgetSnapshot(mode),
    wineEnrichment: wineEnrichmentPolicySchema.parse({
      enabled: true,
      allowedDomains: ["wine.test"],
      tavilyCreditCap: 5,
    }),
    wineGo: {
      schemaVersion: 1,
      flowVersion: "wine-enrichment-v1",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      contractVersion: "wine-contract@1",
      rulesVersion: "wine-grounding@1",
      maxOutputTokens: 4096,
      promptVersions: prompts,
    },
    wineAcquisition: {
      schemaVersion: 1,
      deadlineAt: new Date(Date.now() + 840000).toISOString(),
      policyVersion: "wine-enrichment@1",
      rulesVersion: "wine-grounding@1",
      allowedDomains: ["wine.test"],
    },
  };
  mutate(execution);
  const run = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution,
    });
    if (reserve)
      await r.aiBudgetReservations.reserve({
        pipelineRunId: run.id,
        reservedUsd: createWineBudgetSnapshot(mode).goReservedUsd,
        workspaceCapUsd: "10",
        pricingVersion: "wine-enrichment@1",
      });
    return run;
  });
  return { workspaceId, runId: run.id, inputRevision: 0 };
}
const call = {
  stage: "extraction" as const,
  callOrdinal: 1 as const,
  promptVersion: prompts.extract,
};
const completion = {
  ...call,
  status: "failed" as const,
  failureCategory: "invalid_output",
  inputTokens: 10,
  outputTokens: 4,
  estimatedCostUsd: "0.000008",
  usageCertainty: "estimated" as const,
  latencyMs: 5,
};
it("commits one physical slot and blocks concurrent/replayed and pending work", async () => {
  const input = await fixture();
  const admitted = await Promise.all([
    store.admit(input, call),
    store.admit(input, call),
  ]);
  expect(admitted.filter((x) => x.claimed)).toHaveLength(1);
  const rows =
    await admin`select status, input from ai_runs where pipeline_run_id=${input.runId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "started",
    input: { promptVersion: prompts.extract },
  });
  expect(
    await store.admit(input, {
      stage: "verification",
      callOrdinal: 1,
      promptVersion: prompts.verify,
    }),
  ).toEqual({ claimed: false });
});
it("records distinct five stages and repairs without legacy four-call ceiling", async () => {
  const input = await fixture();
  for (const [stage, promptVersion] of Object.entries({
    extraction: prompts.extract,
    verification: prompts.verify,
    verification_deep: prompts.verify,
    generation: prompts.generate,
    quality_check: prompts.check,
  })) {
    for (const callOrdinal of [1, 2] as const) {
      const c = {
        stage: stage as typeof call.stage,
        callOrdinal,
        promptVersion,
      };
      expect(await store.admit(input, c)).toEqual({ claimed: true });
      expect(
        await store.finish(input, {
          ...completion,
          ...c,
          httpStatus: 200,
          schemaRepairEligible: callOrdinal === 1,
        }),
      ).toBe(true);
      expect(await store.admit(input, c)).toEqual({ claimed: false });
    }
  }
  const rows =
    await admin`select * from ai_runs where pipeline_run_id=${input.runId}`;
  expect(rows).toHaveLength(10);
});
it.each(["copy", "section"] as const)(
  "%s only admits generation and quality slots",
  async (mode) => {
    const input = await fixture(mode);
    expect(await store.admit(input, call)).toEqual({ claimed: false });
    expect(
      await store.admit(input, {
        stage: "generation",
        callOrdinal: 1,
        promptVersion: prompts.generate,
      }),
    ).toEqual({ claimed: true });
  },
);
it.each(["succeeded", "refusal", "unknown"])(
  "does not repair %s",
  async (kind) => {
    const input = await fixture();
    expect(await store.admit(input, { ...call, callOrdinal: 2 })).toEqual({
      claimed: false,
    });
    await store.admit(input, call);
    await store.finish(input, {
      ...completion,
      status: kind === "succeeded" ? "succeeded" : "failed",
      failureCategory: kind === "refusal" ? "refusal" : "invalid_output",
      ...(kind === "unknown"
        ? {
            inputTokens: null,
            outputTokens: null,
            estimatedCostUsd: null,
            usageCertainty: "unknown" as const,
          }
        : {}),
    });
    expect(await store.admit(input, { ...call, callOrdinal: 2 })).toEqual({
      claimed: false,
    });
  },
);
it.each([
  "budget",
  "mode",
  "disabled",
  "rules",
  "domains",
  "model",
  "deadline",
  "long-deadline",
])("fails closed on stored %s mismatch", async (kind) => {
  const input = await fixture("full", (e) => {
    if (kind === "budget")
      e.wineBudget = { ...e.wineBudget, goPhysicalCalls: 20 };
    if (kind === "mode") e.wineMode = "copy";
    if (kind === "disabled")
      e.wineEnrichment = { ...e.wineEnrichment, enabled: false };
    if (kind === "rules") e.wineAcquisition.rulesVersion = "other";
    if (kind === "domains") e.wineAcquisition.allowedDomains = ["other.test"];
    if (kind === "model") e.wineGo.model = "other";
    if (kind === "deadline")
      e.wineAcquisition.deadlineAt = new Date(Date.now() - 1000).toISOString();
    if (kind === "long-deadline")
      e.wineAcquisition.deadlineAt = new Date(
        Date.now() + 1800000,
      ).toISOString();
  });
  expect(await store.admit(input, call)).toEqual({ claimed: false });
});
it("requires a held exact reservation and matching prompt, ordinal and tenant", async () => {
  const input = await fixture("full", () => {}, false);
  expect(await store.admit(input, call)).toEqual({ claimed: false });
  const other = await fixture();
  expect(
    await store.admit({ ...other, workspaceId: input.workspaceId }, call),
  ).toEqual({ claimed: false });
  expect(await store.admit(other, { ...call, promptVersion: "other" })).toEqual(
    { claimed: false },
  );
  expect(
    await store.admit(other, { ...call, callOrdinal: 3 } as never),
  ).toEqual({ claimed: false });
  await admin`update ai_budget_reservations set reserved_usd=1 where pipeline_run_id=${other.runId}`;
  expect(await store.admit(other, call)).toEqual({ claimed: false });
});
it.each(["cancelled", "revision", "current-run", "deadline"])(
  "fences %s but preserves terminal usage",
  async (kind) => {
    const input = await fixture("full", (e) => {
      if (kind === "deadline")
        e.wineAcquisition.deadlineAt = new Date(Date.now() + 500).toISOString();
    });
    await store.admit(input, call);
    if (kind === "cancelled")
      await db.forWorkspace(input.workspaceId, (r) =>
        r.pipelineRuns.setOperationState(input.runId, "cancelled"),
      );
    if (kind === "revision")
      await admin`update listing_drafts set input_revision=1 where current_run_id=${input.runId}`;
    if (kind === "current-run")
      await admin`update listing_drafts set current_run_id=null where current_run_id=${input.runId}`;
    if (kind === "deadline") await admin`select pg_sleep(0.6)`;
    expect(await store.finish(input, completion)).toBe(true);
    expect(await store.finish(input, completion)).toBe(false);
    expect(await store.admit(input, { ...call, callOrdinal: 2 })).toEqual({
      claimed: false,
    });
    const rows =
      await admin`select estimated_cost_usd from ai_runs where pipeline_run_id=${input.runId}`;
    expect(Number(rows[0]!.estimated_cost_usd)).toBe(0.000008);
  },
);

it("does not repair terminal invalid output without explicit schema eligibility", async () => {
  const input = await fixture();
  await store.admit(input, call);
  await store.finish(input, completion);
  expect(await store.admit(input, { ...call, callOrdinal: 2 })).toEqual({
    claimed: false,
  });
});
it("rechecks time after the reservation lock wait", async () => {
  const input = await fixture("full", (e) => {
    e.wineAcquisition.deadlineAt = new Date(Date.now() + 350).toISOString();
  });
  let acquired!: () => void;
  const locked = new Promise<void>((r) => {
    acquired = r;
  });
  const blocker = admin.begin(async (tx) => {
    await tx`select pipeline_run_id from ai_budget_reservations where pipeline_run_id=${input.runId} for update`;
    acquired();
    await tx`select pg_sleep(0.45)`;
  });
  await locked;
  expect(await store.admit(input, call)).toEqual({ claimed: false });
  await blocker;
});
it("unknown usage retains the financial hold and blocks every later logical stage", async () => {
  const input = await fixture();
  await store.admit(input, call);
  expect(
    await store.finish(input, {
      ...completion,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      usageCertainty: "unknown",
    }),
  ).toBe(true);
  expect(
    await store.admit(input, {
      stage: "verification",
      callOrdinal: 1,
      promptVersion: prompts.verify,
    }),
  ).toEqual({ claimed: false });
  const rows =
    await admin`select state,reserved_usd,settled_usd from ai_budget_reservations where pipeline_run_id=${input.runId}`;
  expect(rows[0]).toMatchObject({ state: "unknown", settled_usd: null });
  expect(Number(rows[0]!.reserved_usd)).toBe(3.19488);
});
it("rejects forged terminal binding and malformed measured usage without losing the started hold", async () => {
  const input = await fixture();
  await store.admit(input, call);
  expect(await store.finish({ ...input, inputRevision: 1 }, completion)).toBe(
    false,
  );
  expect(
    await store.finish(input, { ...completion, promptVersion: "wrong" }),
  ).toBe(false);
  await expect(
    store.finish(input, { ...completion, estimatedCostUsd: "-1" }),
  ).rejects.toThrow("invalid wine Go usage");
  const rows =
    await admin`select status from ai_runs where pipeline_run_id=${input.runId}`;
  expect(rows[0]?.status).toBe("started");
});
it("rejects schema repair eligibility on refusal, success, unknown usage or ordinal 2", async () => {
  for (const change of [
    { failureCategory: "refusal" },
    { status: "succeeded" as const },
    { usageCertainty: "unknown" as const, estimatedCostUsd: null },
    { callOrdinal: 2 as const },
  ]) {
    const input = await fixture();
    await store.admit(input, call);
    await expect(
      store.finish(input, {
        ...completion,
        httpStatus: 200,
        ...change,
        schemaRepairEligible: true,
      } as never),
    ).rejects.toThrow("invalid wine Go repair eligibility");
  }
});
