import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabase } from "@wukong/db";
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
import { wineEnrichmentPolicySchema } from "@wukong/core";
import { acceptListingOperation } from "../../../lib/listing-operation-service";
import { preflightWineCapability } from "../../../lib/wine-capability-client";
const postgres = createRequire(import.meta.resolve("@wukong/db"))("postgres");
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw Error("dedicated localhost fixture required");
const db = createDatabase(url),
  admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, { onnotice() {} });
afterAll(async () => {
  await db.close();
  await admin.end();
});
beforeEach(() => {
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("QUEUE_INGRESS_URL", "https://worker.test");
  vi.stubEnv("QUEUE_INGRESS_SECRET", "synthetic");
});
afterEach(() => vi.unstubAllEnvs());
async function receipt(now = Date.now(), mode: "full" | "research" = "full") {
  return preflightWineCapability({
    mode,
    now: () => now,
    fetch: async () =>
      Response.json({
        authenticated: true,
        wine: {
          schemaVersion: 1,
          execution: WINE_EXECUTION_SNAPSHOT,
          databaseSchemaVersion: "wine-enrichment-0042-v1",
          buildSha: "abcdef0",
          consumerSupported: true,
          goConfigured: true,
          tavilyConfigured: true,
          queueReady: true,
          databaseReady: true,
        },
      }),
  });
}
async function fixture(overrides = {}) {
  const workspaceId = `wine-admit-${randomUUID()}`;
  const input = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({
      target: "shopline",
      note: "Synthetic wine",
    });
    const profile = {
      name: "Synthetic",
      currency: "HKD" as const,
      locales: ["en", "zh-Hant"] as ["en", "zh-Hant"],
      tone: "neutral",
      claimPolicy: [],
      requiredFields: [],
      brandBackgroundColor: null,
    };
    await r.workspaces.updateProfile({
      ...profile,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        tavilyCreditCap: 5,
        allowedDomains: ["wine.test"],
        ...overrides,
      }),
    });
    const snapshot = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "tester" },
      { workspaceId, actorId: "tester", entityId: listing.id },
      r.audit,
    );
    return {
      workspaceId,
      listingId: listing.id,
      expectedInputRevision: snapshot.revision,
      baseVersionId: null,
      operationKey: randomUUID(),
      actorId: "tester",
    };
  });
  return input;
}
async function accept(
  input: Awaited<ReturnType<typeof fixture>>,
  capability?: Awaited<ReturnType<typeof receipt>>,
  wineMode?: string,
) {
  return db.forWorkspace(input.workspaceId, (r) =>
    acceptListingOperation(
      r,
      { ...input, ...(wineMode ? { wineMode } : {}) } as never,
      { wineCapability: capability } as never,
    ),
  );
}
it("atomically accepts complete full snapshot, both holds and first extraction outbox", async () => {
  const input = await fixture();
  const result = await accept(input, await receipt());
  const run = await db.forWorkspace(input.workspaceId, (r) =>
    r.pipelineRuns.getOperation(result.run.id),
  );
  expect(run?.execution).toMatchObject({
    schemaVersion: 1,
    flowVersion: "wine-enrichment-v1",
    wineMode: "full",
    wineGo: WINE_EXECUTION_SNAPSHOT,
    wineBudget: {
      goPhysicalCalls: 10,
      goReservedUsd: "3.194880",
      tavilyCredits: 5,
    },
    wineEnrichment: { enabled: true },
    wineCapability: { capability: { buildSha: "abcdef0" } },
  });
  expect(
    Date.parse((run!.execution.wineAcquisition as any).deadlineAt) -
      Date.parse(run!.acceptedAt),
  ).toBe(900000);
  expect(result.outbox[0]).toMatchObject({
    dedupeKey: `wine-run:${run!.id}:extraction`,
    payload: { flowVersion: "wine-enrichment-v1", stage: "extraction" },
  });
  const go =
    await admin`select reserved_usd,pricing_version from ai_budget_reservations where pipeline_run_id=${run!.id}`;
  const search =
    await admin`select reserved_credits from search_budget_reservations where pipeline_run_id=${run!.id}`;
  expect(go).toMatchObject([
    { reserved_usd: "3.194880", pricing_version: "wine-enrichment@1" },
  ]);
  expect(search[0].reserved_credits).toBe(5);
});
it.each(["missing", "forged", "stale"])(
  "rejects %s capability without accepting",
  async (kind) => {
    const input = await fixture();
    const cap =
      kind === "missing"
        ? undefined
        : kind === "forged"
          ? {}
          : await receipt(Date.now() - 31000);
    await expect(accept(input, cap as never)).rejects.toMatchObject({
      code:
        kind === "stale" ? "wine_capability_stale" : "wine_capability_required",
    });
    expect(
      await admin`select id from listing_pipeline_runs where workspace_id=${input.workspaceId}`,
    ).toHaveLength(0);
  },
);
it("rolls back Go hold and run when Tavily cap cannot fit", async () => {
  const input = await fixture({ tavilyCreditCap: 4 });
  await expect(accept(input, await receipt())).rejects.toMatchObject({
    code: "wine_search_budget_blocked",
  });
  expect(
    await admin`select id from listing_pipeline_runs where workspace_id=${input.workspaceId}`,
  ).toHaveLength(0);
  expect(
    await admin`select id from ai_budget_reservations where workspace_id=${input.workspaceId}`,
  ).toHaveLength(0);
});
it.each(["copy", "section"])(
  "rejects %s until adopted version dependencies exist",
  async (mode) => {
    const input = await fixture();
    await expect(accept(input, await receipt(), mode)).rejects.toMatchObject({
      code: "wine_dependencies_required",
    });
  },
);

import { createListingHandler } from "./route";
import { createProcessListingHandler } from "./[id]/process/route";
import { createListingInputsHandler } from "./[id]/inputs/route";
function routeDeps(workspaceId: string) {
  const transactionContext = new AsyncLocalStorage<boolean>();
  const database = {
    ...db,
    async forWorkspace<T>(
      ws: string,
      work: (r: any) => Promise<T>,
    ): Promise<T> {
      return db.forWorkspace(ws, (r) =>
        transactionContext.run(true, () => work(r)),
      );
    },
  };
  const preflight = vi.fn(
    async (options?: { mode?: "full" | "research" | "copy" | "section" }) => {
      expect(transactionContext.getStore()).not.toBe(true);
      return receipt(
        Date.now(),
        options?.mode === "research" ? "research" : "full",
      );
    },
  );
  return {
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "tester",
        role: "operator" as const,
      }),
    },
    getDatabase: () => database,
    getAssetStore: () => ({}) as never,
    publisher: { enqueue: vi.fn() } as any,
    preflightWineCapability: preflight,
  };
}
function request(body: object, method = "POST", key: string = randomUUID()) {
  return new Request("http://local/api/listings", {
    method,
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}
it.each(["create", "inputs", "process"])(
  "%s route obtains capability outside transactions and retains pending wine intent",
  async (kind) => {
    const input = await fixture();
    const deps = routeDeps(input.workspaceId);
    const response =
      kind === "create"
        ? await createListingHandler(deps as never)(
            request({
              sourceAssetIds: [],
              note: "New synthetic wine",
              wineMode: "research",
            }),
          )
        : kind === "inputs"
          ? await createListingInputsHandler(deps as never)(
              request(
                {
                  expectedInputRevision: 1,
                  baseVersionId: null,
                  note: "Updated wine",
                  action: "save_and_process",
                  wineMode: "research",
                },
                "PATCH",
              ),
              { params: Promise.resolve({ id: input.listingId }) },
            )
          : await createProcessListingHandler(deps as never)(
              request({ expectedInputRevision: 1, wineMode: "research" }),
              { params: Promise.resolve({ id: input.listingId }) },
            );
    expect(response.status).toBe(kind === "create" ? 201 : 202);
    const body = await response.json();
    expect(body.processing.runId).toBeTruthy();
    expect(deps.preflightWineCapability).toHaveBeenCalledTimes(1);
    expect(deps.publisher.enqueue).not.toHaveBeenCalled();
    const run = await db.forWorkspace(input.workspaceId, (r) =>
      r.pipelineRuns.getOperation(body.processing.runId),
    );
    expect(run?.execution.wineMode).toBe("research");
    const rows =
      await admin`select attempts from listing_dispatch_outbox where workspace_id=${input.workspaceId}`;
    expect(rows[0].attempts).toBe(0);
  },
);
it.each(["create", "inputs"])(
  "%s keeps saved note but rolls back all acceptance writes when search credit reservation fails",
  async (kind) => {
    const input = await fixture({ tavilyCreditCap: 4 });
    const deps = routeDeps(input.workspaceId);
    const response =
      kind === "create"
        ? await createListingHandler(deps as never)(
            request({ sourceAssetIds: [], note: "Preserve this note" }),
          )
        : await createListingInputsHandler(deps as never)(
            request(
              {
                expectedInputRevision: 1,
                baseVersionId: null,
                note: "Preserve this note",
                action: "save_and_process",
              },
              "PATCH",
            ),
            { params: Promise.resolve({ id: input.listingId }) },
          );
    expect(response.status).toBe(kind === "create" ? 201 : 200);
    const body = await response.json();
    expect(body.processing).toBeNull();
    expect(body.processingBlocked.code).toBe("wine_search_budget_blocked");
    const listingId = kind === "create" ? body.listing.id : input.listingId;
    const snapshot = await db.forWorkspace(input.workspaceId, (r) =>
      r.listingInputs.getCurrent(listingId),
    );
    expect(snapshot?.note).toBe("Preserve this note");
    expect(
      await admin`select id from listing_pipeline_runs where workspace_id=${input.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await admin`select id from ai_budget_reservations where workspace_id=${input.workspaceId}`,
    ).toHaveLength(0);
    expect(
      await admin`select id from listing_dispatch_outbox where workspace_id=${input.workspaceId}`,
    ).toHaveLength(0);
  },
);
async function anotherListing(input: Awaited<ReturnType<typeof fixture>>) {
  return db.forWorkspace(input.workspaceId, async (r) => {
    const listing = await r.listings.create({
      target: "shopline",
      note: "Another synthetic wine",
    });
    const snapshot = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "tester" },
      {
        workspaceId: input.workspaceId,
        actorId: "tester",
        entityId: listing.id,
      },
      r.audit,
    );
    return {
      ...input,
      listingId: listing.id,
      expectedInputRevision: snapshot.revision,
      operationKey: randomUUID(),
    };
  });
}
it("concurrent different listings compete atomically for the last five credits", async () => {
  const first = await fixture();
  const second = await anotherListing(first);
  const cap = await receipt();
  const results = await Promise.allSettled([
    accept(first, cap),
    accept(second, cap),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "wine_search_budget_blocked" },
  });
  for (const table of [
    "listing_pipeline_runs",
    "ai_budget_reservations",
    "search_budget_reservations",
    "listing_dispatch_outbox",
  ]) {
    const rows = await admin.unsafe(
      `select workspace_id from ${table} where workspace_id=$1`,
      [first.workspaceId],
    );
    expect(rows).toHaveLength(1);
  }
});
it("concurrent idempotent replay retains one operation and rejects changed mode or revision", async () => {
  const input = await fixture();
  const cap = await receipt();
  const [a, b] = await Promise.all([accept(input, cap), accept(input, cap)]);
  expect(a.run.id).toBe(b.run.id);
  expect(a.outbox.length + b.outbox.length).toBe(1);
  await expect(accept(input, cap, "research")).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
  await expect(
    accept({ ...input, expectedInputRevision: 2 }, cap),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  const replay = await accept(input);
  expect(replay.run.id).toBe(a.run.id);
  expect(replay.outbox).toEqual([]);
});
it.each(["held", "unknown", "anomalous-known"])(
  "retains shared Go USD10 charge from %s and rolls back unsatisfied admission",
  async (kind) => {
    const input = await fixture();
    await db.forWorkspace(input.workspaceId, async (r) => {
      const listing = await r.listings.create({ target: "shopline" });
      const run = await r.pipelineRuns.acceptOperation({
        listingId: listing.id,
        inputRevision: 1,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "synthetic old run",
        execution: {},
      });
      await r.aiBudgetReservations.reserve({
        pipelineRunId: run.id,
        reservedUsd: kind === "anomalous-known" ? "1" : "7",
        workspaceCapUsd: "10",
        pricingVersion: "prior-policy",
      });
      if (kind === "unknown")
        await r.aiBudgetReservations.settle({
          pipelineRunId: run.id,
          settledUsd: null,
          outcome: "unknown",
        });
      if (kind === "anomalous-known") {
        await r.aiRuns.beginInvocation({
          listingId: listing.id,
          pipelineRunId: run.id,
          task: "extract",
          stage: "extract",
          callOrdinal: 1,
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          promptVersion: "synthetic",
        });
        await r.aiRuns.finalizeInvocation({
          pipelineRunId: run.id,
          stage: "extract",
          callOrdinal: 1,
          status: "succeeded",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
          estimatedCostUsd: "9",
          usageCertainty: "measured",
        });
      }
    });
    await expect(accept(input, await receipt())).rejects.toMatchObject({
      code: "wine_go_budget_blocked",
    });
    expect(
      await admin`select id from listing_pipeline_runs where listing_id=${input.listingId}`,
    ).toHaveLength(0);
    expect(
      await admin`select workspace_id from search_budget_reservations where workspace_id=${input.workspaceId}`,
    ).toHaveLength(0);
    const holds =
      await admin`select reserved_usd,state from ai_budget_reservations where workspace_id=${input.workspaceId}`;
    expect(holds).toHaveLength(1);
    expect(holds[0].reserved_usd).toBe(
      kind === "anomalous-known" ? "1.000000" : "7.000000",
    );
    expect(holds[0].state).toBe(kind === "unknown" ? "unknown" : "held");
  },
);
it("accepted policy, input/source digest and deadline remain immutable when workspace policy changes", async () => {
  const input = await fixture();
  const a = await accept(input, await receipt());
  const before = await db.forWorkspace(input.workspaceId, (r) =>
    r.pipelineRuns.getOperation(a.run.id),
  );
  await db.forWorkspace(input.workspaceId, async (r) => {
    const p = await r.workspaces.requireProfile();
    await r.workspaces.updateProfile({
      ...p,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: false,
        policyVersion: "later",
        allowedDomains: ["other.test"],
        tavilyCreditCap: 500,
      }),
    });
  });
  const after = await db.forWorkspace(input.workspaceId, (r) =>
    r.pipelineRuns.getOperation(a.run.id),
  );
  expect(after?.execution).toEqual(before?.execution);
  expect(after?.execution.wineInputDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(after?.execution.wineSourceDigest).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    admin`update listing_pipeline_runs set execution=execution || '{"wineMode":"research"}'::jsonb where id=${a.run.id}`,
  ).rejects.toThrow();
});
it("checks capability freshness after a real workspace lock wait", async () => {
  const input = await fixture();
  const cap = await receipt();
  let locked!: () => void, release!: () => void;
  const isLocked = new Promise<void>((r) => {
    locked = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const holding = admin.begin(async (tx: any) => {
    await tx`select id from workspaces where id=${input.workspaceId} for update`;
    locked();
    await gate;
  });
  await isLocked;
  const result = accept(input, cap).then(
    () => ({ code: "accepted" }),
    (error) => error,
  );
  await admin`select pg_sleep(0.2)`;
  const waiting =
    await admin`select count(*)::int total from pg_stat_activity where datname='wukong_wine_sdd' and wait_event_type='Lock'`;
  expect(waiting[0].total).toBeGreaterThan(0);
  const time = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(time + 31000);
  try {
    release();
    await holding;
    expect(await result).toMatchObject({ code: "wine_capability_stale" });
  } finally {
    release();
    clock.mockRestore();
  }
  expect(
    await admin`select id from listing_pipeline_runs where workspace_id=${input.workspaceId}`,
  ).toHaveLength(0);
});
it("uses actual DB acceptance time after transaction delay for the sole 15 minute deadline", async () => {
  const input = await fixture();
  const cap = await receipt();
  const result = await db.forWorkspace(input.workspaceId, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return acceptListingOperation(r, input, { wineCapability: cap });
  });
  const run = await db.forWorkspace(input.workspaceId, (r) =>
    r.pipelineRuns.getOperation(result.run.id),
  );
  expect(
    Date.parse((run!.execution.wineAcquisition as any).deadlineAt) -
      Date.parse(run!.acceptedAt),
  ).toBe(900000);
});
it.each(["absent", "disabled", "flag-off"])(
  "preserves legacy route when wine policy is %s",
  async (kind) => {
    const input = await fixture();
    if (kind === "flag-off") vi.stubEnv("WINE_ENRICHMENT_ENABLED", "false");
    else
      await db.forWorkspace(input.workspaceId, async (r) => {
        const p = await r.workspaces.requireProfile();
        await r.workspaces.updateProfile({
          ...p,
          wineEnrichment:
            kind === "absent"
              ? undefined
              : wineEnrichmentPolicySchema.parse({}),
        });
      });
    const deps = routeDeps(input.workspaceId);
    const response = await createProcessListingHandler(deps)(request({}), {
      params: Promise.resolve({ id: input.listingId }),
    });
    expect(response.status).toBe(202);
    expect(deps.preflightWineCapability).not.toHaveBeenCalled();
    expect(deps.publisher.enqueue).toHaveBeenCalledTimes(1);
  },
);
it.each(["create", "inputs", "process"])(
  "%s rejects browser-supplied capability JSON",
  async (kind) => {
    const input = await fixture();
    const deps = routeDeps(input.workspaceId);
    const extra = { wineCapability: { consumerSupported: true } };
    const response =
      kind === "create"
        ? await createListingHandler(deps)(
            request({ sourceAssetIds: [], note: "Wine", ...extra }),
          )
        : kind === "inputs"
          ? await createListingInputsHandler(deps)(
              request(
                {
                  expectedInputRevision: 1,
                  baseVersionId: null,
                  action: "save_and_process",
                  ...extra,
                },
                "PATCH",
              ),
              { params: Promise.resolve({ id: input.listingId }) },
            )
          : await createProcessListingHandler(deps)(request(extra), {
              params: Promise.resolve({ id: input.listingId }),
            });
    expect(response.status).toBe(400);
    expect(deps.preflightWineCapability).not.toHaveBeenCalled();
  },
);
it("create with existing attached assets cannot invert process listing-first budget locks", async () => {
  const input = await fixture();
  const asset = await db.forWorkspace(input.workspaceId, async (r) => {
    const a = await r.sourceAssets.create({
      storageKey: `synthetic/${randomUUID()}`,
      kind: "image/jpeg",
      metadata: { sha256: "a".repeat(64), size: 10 },
    });
    await r.sourceAssets.attachToListing(input.listingId, [a.id]);
    return a;
  });
  let signalListing!: () => void, signalCreate!: () => void;
  const listingHeld = new Promise<void>((r) => {
    signalListing = r;
  });
  const createEntered = new Promise<void>((r) => {
    signalCreate = r;
  });
  const processDeps = routeDeps(input.workspaceId),
    createDeps = routeDeps(input.workspaceId);
  const processDb = {
    ...db,
    forWorkspace: <T>(ws: string, work: (r: any) => Promise<T>) =>
      db.forWorkspace(ws, (r) =>
        work({
          ...r,
          listings: {
            ...r.listings,
            lockReviewState: async (id: string) => {
              await r.listings.lockReviewState(id);
              signalListing();
              await createEntered;
            },
          },
        }),
      ),
  };
  const createDb = {
    ...db,
    forWorkspace: <T>(ws: string, work: (r: any) => Promise<T>) =>
      db.forWorkspace(ws, (r) =>
        work({
          ...r,
          listingInputs: {
            ...r.listingInputs,
            initialize: async (
              ...args: Parameters<typeof r.listingInputs.initialize>
            ) => {
              signalCreate();
              return r.listingInputs.initialize(...args);
            },
          },
        }),
      ),
  };
  const processing = createProcessListingHandler({
    ...processDeps,
    getDatabase: () => processDb,
  })(request({}), { params: Promise.resolve({ id: input.listingId }) });
  await listingHeld;
  const creating = createListingHandler({
    ...createDeps,
    getDatabase: () => createDb,
  } as never)(request({ sourceAssetIds: [asset.id], note: "Synthetic wine" }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const responses = await Promise.race([
      Promise.all([processing, creating]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("lock order timeout")), 5000);
      }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 409]);
  } finally {
    clearTimeout(timer);
    signalCreate();
  }
});
it.each(["outbox", "audit"])(
  "savepoint rolls back both holds, run and %s writes even when caller catches failure",
  async (failure) => {
    const input = await fixture();
    const cap = await receipt();
    await db.forWorkspace(input.workspaceId, async (r) => {
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
                  throw Error("synthetic write failure");
                },
              },
            }
          : {
              audit: {
                ...r.audit,
                write: async (...args: Parameters<typeof r.audit.write>) => {
                  await r.audit.write(...args);
                  throw Error("synthetic write failure");
                },
              },
            }),
      };
      await expect(
        acceptListingOperation(repositories, input, { wineCapability: cap }),
      ).rejects.toThrow("synthetic write failure");
      expect(
        await r.audit.countByActionSince(
          "listing.processing_accepted",
          new Date(0),
        ),
      ).toBe(0);
      expect((await r.listingInputs.getCurrent(input.listingId))?.note).toBe(
        "Synthetic wine",
      );
      expect(
        await r.pipelineRuns.getCurrentOperation(input.listingId),
      ).toBeNull();
    });
    for (const table of [
      "listing_pipeline_runs",
      "ai_budget_reservations",
      "search_budget_reservations",
      "listing_dispatch_outbox",
    ])
      expect(
        await admin.unsafe(
          `select workspace_id from ${table} where workspace_id=$1`,
          [input.workspaceId],
        ),
      ).toHaveLength(0);
  },
);
it.each(["full", "research"])(
  "%s rejects empty approved domains",
  async (mode) => {
    const input = await fixture({ allowedDomains: [] });
    await expect(accept(input, await receipt(), mode)).rejects.toMatchObject({
      code: "wine_policy_required",
    });
  },
);
it("concurrent same create key replays one saved response and changed note conflicts", async () => {
  const input = await fixture();
  const deps = routeDeps(input.workspaceId);
  const key = randomUUID();
  const body = { sourceAssetIds: [], note: "Exact saved note" };
  const handler = createListingHandler(deps);
  const responses = await Promise.all([
    handler(request(body, "POST", key)),
    handler(request(body, "POST", key)),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const [a, b] = await Promise.all(responses.map((r) => r.json()));
  expect(a.listing.id).toBe(b.listing.id);
  expect(a).not.toHaveProperty("processingBlocked");
  expect(b).not.toHaveProperty("processingBlocked");
  expect(a.processing.runId).toBe(b.processing.runId);
  expect(
    (await handler(request({ ...body, note: "Changed" }, "POST", key))).status,
  ).toBe(409);
});
it.each(["identical-no-key", "overlapping-keys"])(
  "serializes %s asset creates without 500 or lost note",
  async (kind) => {
    const input = await fixture();
    const assets = await db.forWorkspace(input.workspaceId, async (r) =>
      Promise.all(
        [1, 2, 3].map((n) =>
          r.sourceAssets.create({
            storageKey: `synthetic/${randomUUID()}`,
            kind: "image/jpeg",
            metadata: { sha256: String(n).repeat(64), size: 10 },
          }),
        ),
      ),
    );
    const firstDeps = routeDeps(input.workspaceId),
      secondDeps = routeDeps(input.workspaceId);
    let signalFirst!: () => void,
      release!: () => void,
      signalSecond!: () => void;
    const firstRead = new Promise<void>((r) => {
        signalFirst = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      }),
      secondRead = new Promise<void>((r) => {
        signalSecond = r;
      });
    let reads = 0;
    const firstDb = {
      ...db,
      forWorkspace: <T>(ws: string, work: (r: any) => Promise<T>) =>
        db.forWorkspace(ws, (r) =>
          work({
            ...r,
            sourceAssets: {
              ...r.sourceAssets,
              getByIds: async (ids: string[]) => {
                const rows = await r.sourceAssets.getByIds(ids);
                if (++reads === 1) {
                  signalFirst();
                  await gate;
                }
                return rows;
              },
            },
          }),
        ),
    };
    const secondDb = {
      ...db,
      forWorkspace: <T>(ws: string, work: (r: any) => Promise<T>) =>
        db.forWorkspace(ws, (r) =>
          work({
            ...r,
            sourceAssets: {
              ...r.sourceAssets,
              getByIds: async (ids: string[]) => {
                signalSecond();
                return r.sourceAssets.getByIds(ids);
              },
            },
          }),
        ),
    };
    function assetRequest(ids: string[], note: string) {
      const req = request({
        sourceAssetIds: ids,
        note,
        processingMode: "manual",
      });
      if (kind === "identical-no-key") req.headers.delete("Idempotency-Key");
      return req;
    }
    const first = createListingHandler({
      ...firstDeps,
      getDatabase: () => firstDb,
    } as never)(assetRequest([assets[0]!.id, assets[1]!.id], "first note"));
    await firstRead;
    const second = createListingHandler({
      ...secondDeps,
      getDatabase: () => secondDb,
    } as never)(
      assetRequest(
        kind === "identical-no-key"
          ? [assets[1]!.id, assets[0]!.id]
          : [assets[1]!.id, assets[2]!.id],
        kind === "identical-no-key" ? "first note" : "different note",
      ),
    );
    const waiting = async () => {
      for (let i = 0; i < 100; i++) {
        const rows =
          await admin`select count(*)::int total from pg_stat_activity where datname='wukong_wine_sdd' and wait_event='advisory'`;
        if (rows[0].total > 0) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("advisory lock timeout");
    };
    try {
      await Promise.race([secondRead, waiting()]);
    } finally {
      release();
    }
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status)).toEqual([
      201,
      kind === "identical-no-key" ? 201 : 409,
    ]);
    const firstBody = await responses[0].json();
    const snapshot = await db.forWorkspace(input.workspaceId, (r) =>
      r.listingInputs.getCurrent(firstBody.listing.id),
    );
    expect(snapshot?.note).toBe("first note");
    if (kind === "identical-no-key")
      expect((await responses[1].json()).listing.id).toBe(firstBody.listing.id);
  },
);
it.each([
  ["create", 10],
  ["inputs", 10],
  ["create", 5],
  ["inputs", 5],
] as const)(
  "FK-bearing concurrent %s transactions with cap%d serialize budget admission without losing saved inputs",
  async (kind, cap) => {
    const input = await fixture({ tavilyCreditCap: cap });
    const secondInput = await anotherListing(input);
    let arrived = 0,
      release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const database = {
      ...db,
      forWorkspace: <T>(ws: string, work: (r: any) => Promise<T>) =>
        db.forWorkspace(ws, (r) =>
          work({
            ...r,
            pipelineRuns: {
              ...r.pipelineRuns,
              lockAdmissionBudget: async () => {
                if (++arrived === 2) release();
                await gate;
                return r.pipelineRuns.lockAdmissionBudget();
              },
            },
          }),
        ),
    };
    const deps = {
      ...routeDeps(input.workspaceId),
      getDatabase: () => database,
    };
    const requests = [input, secondInput].map((current, i) =>
      kind === "create"
        ? createListingHandler(deps as never)(
            request({ sourceAssetIds: [], note: `Concurrent wine ${i}` }),
          )
        : createListingInputsHandler(deps)(
            request(
              {
                expectedInputRevision: current.expectedInputRevision,
                baseVersionId: null,
                action: "save_and_process",
                note: `Concurrent wine ${i}`,
              },
              "PATCH",
            ),
            { params: Promise.resolve({ id: current.listingId }) },
          ),
    );
    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(
      responses.map((r) => r.status).sort(),
      JSON.stringify(bodies),
    ).toEqual(
      kind === "create" ? [201, 201] : cap === 5 ? [200, 202] : [202, 202],
    );
    expect(
      bodies
        .filter((b) => b.processingBlocked)
        .map((b) => b.processingBlocked.code),
    ).toEqual(cap === 5 ? ["wine_search_budget_blocked"] : []);
    expect(bodies.filter((b) => !!b.processing?.runId)).toHaveLength(
      cap === 5 ? 1 : 2,
    );
    const holds =
      await admin`select pipeline_run_id from search_budget_reservations where workspace_id=${input.workspaceId}`;
    expect(holds).toHaveLength(cap === 5 ? 1 : 2);
    for (let i = 0; i < 2; i++) {
      const id =
        kind === "create"
          ? bodies[i].listing.id
          : [input, secondInput][i]!.listingId;
      const saved = await db.forWorkspace(input.workspaceId, (r) =>
        r.listingInputs.getCurrent(id),
      );
      expect(saved?.note).toBe(`Concurrent wine ${i}`);
    }
  },
);
it("mixed-case create request and asset UUIDs replay semantically identical inputs", async () => {
  const input = await fixture();
  const deps = routeDeps(input.workspaceId);
  const key = randomUUID();
  const asset = await db.forWorkspace(input.workspaceId, (r) =>
    r.sourceAssets.create({
      storageKey: `case/${randomUUID()}`,
      kind: "image/jpeg",
      metadata: { sha256: "a".repeat(64), size: 10 },
    }),
  );
  const handler = createListingHandler(deps);
  const first = await handler(
    request(
      {
        sourceAssetIds: [asset.id],
        note: "Case-safe wine",
        processingMode: "manual",
      },
      "POST",
      key,
    ),
  );
  const replay = await handler(
    request(
      {
        sourceAssetIds: [asset.id.toUpperCase()],
        note: "Case-safe wine",
        processingMode: "manual",
      },
      "POST",
      key.toUpperCase(),
    ),
  );
  expect(first.status).toBe(201);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(await first.json());
});
it.each(["request", "asset"])(
  "mixed-case %s UUIDs use the same transaction advisory lock",
  async (kind) => {
    const input = await fixture();
    const key = randomUUID(),
      asset = randomUUID();
    await db.forWorkspace(input.workspaceId, async (r) => {
      await r.pipelineRuns.lockCreateRequests(
        kind === "request" ? key : null,
        kind === "asset" ? [asset] : [],
      );
      const expected =
        await admin`select classid,objid from pg_locks where locktype='advisory' and granted`;
      await r.pipelineRuns.lockCreateRequests(
        kind === "request" ? key.toUpperCase() : null,
        kind === "asset" ? [asset.toUpperCase(), asset] : [],
      );
      const actual =
        await admin`select classid,objid from pg_locks where locktype='advisory' and granted`;
      expect(actual).toEqual(expected);
    });
  },
);
it("captures stale capability as the saved create result and replays that exact blocked result", async () => {
  const input = await fixture();
  const deps = routeDeps(input.workspaceId);
  deps.preflightWineCapability.mockImplementationOnce(() =>
    receipt(Date.now() - 31000),
  );
  const handler = createListingHandler(deps);
  const key = randomUUID();
  const body = { sourceAssetIds: [], note: "Receipt diagnostic wine" };
  const first = await handler(request(body, "POST", key));
  const original = await first.json();
  expect(first.status).toBe(201);
  expect(original).toMatchObject({
    processing: null,
    processingBlocked: { code: "wine_capability_stale" },
  });
  const replay = await handler(request(body, "POST", key));
  expect(await replay.json()).toEqual(original);
  expect(
    await admin`select id from listing_pipeline_runs where workspace_id=${input.workspaceId}`,
  ).toHaveLength(0);
});
it.each(["inputs", "process"])(
  "mixed-case %s operation UUID and listing coordinate replay the original run",
  async (kind) => {
    const input = await fixture();
    const deps = routeDeps(input.workspaceId);
    const key = randomUUID();
    const invoke = (id: string, operation: string) =>
      kind === "inputs"
        ? createListingInputsHandler(deps)(
            request(
              {
                expectedInputRevision: 1,
                baseVersionId: null,
                note: "UUID replay",
                action: "save_and_process",
              },
              "PATCH",
              operation,
            ),
            { params: Promise.resolve({ id }) },
          )
        : createProcessListingHandler(deps)(
            request({ expectedInputRevision: 1 }, "POST", operation),
            { params: Promise.resolve({ id }) },
          );
    const first = await invoke(input.listingId, key);
    const replay = await invoke(
      input.listingId.toUpperCase(),
      key.toUpperCase(),
    );
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect((await replay.json()).processing.runId).toBe(
      (await first.json()).processing.runId,
    );
  },
);
it("transaction-boundary harness allows independent request preflight but rejects same-context preflight", async () => {
  const input = await fixture();
  const deps = routeDeps(input.workspaceId);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const otherRequest = deps
    .getDatabase()
    .forWorkspace(input.workspaceId, async () => {
      started();
      await gate;
    });
  await entered;
  try {
    await expect(deps.preflightWineCapability()).resolves.toBeDefined();
  } finally {
    release();
    await otherRequest;
  }
  await deps.getDatabase().forWorkspace(input.workspaceId, async () => {
    await expect(deps.preflightWineCapability()).rejects.toThrow();
  });
});

it("rejects a full receipt for research before reservation and persists exact research receipt", async () => {
  const input = await fixture();
  await expect(
    accept(input, await receipt(), "research"),
  ).rejects.toMatchObject({ code: "wine_capability_required" });
  const result = await accept(
    input,
    await receipt(Date.now(), "research"),
    "research",
  );
  const persisted = await db.forWorkspace(input.workspaceId, (r) =>
    r.pipelineRuns.getOperation(result.run.id),
  );
  expect(persisted?.execution).toMatchObject({
    wineMode: "research",
    wineCapability: { mode: "research" },
  });
});
