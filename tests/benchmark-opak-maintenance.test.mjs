import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = resolve(root, "scripts/benchmark-opak-maintenance.mjs");
const api = await import(
  new URL("../scripts/benchmark-opak-maintenance.mjs", import.meta.url)
).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const env = {
  TEST_DATABASE_ADMIN_URL:
    "postgres://fixture:private-admin-password@127.0.0.1:54399/opak_fixes_perf_test",
  TEST_DATABASE_URL:
    "postgres://wukong_app:private-app-password@127.0.0.1:54399/opak_fixes_perf_test",
};
const args = ["--dry-run", "--allow-local-db", "opak_fixes_perf_test"];
function refused(work) {
  assert.throws(work, /Benchmark refused:/);
}
let loadedRuntime;

test("the benchmark exposes a guarded plan without loading database runtime", () => {
  assert.equal(typeof api.planBenchmark, "function");
});

test("accepts only the explicitly named matching local admin and application database", () => {
  const plan = api.planBenchmark(args, env, root);
  assert.deepEqual(plan.sizes, [500]);
  assert.equal(plan.database.name, "opak_fixes_perf_test");
  assert.equal(plan.database.runtimeRole, "wukong_app");
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.concurrency, 1);
  assert.equal(JSON.stringify(plan).includes("private-app-password"), false);
});

test("rejects missing execution mode, URL, or explicit database allowlist", () => {
  refused(() => api.planBenchmark([], env, root));
  refused(() =>
    api.planBenchmark(
      ["--run", "--allow-local-db", "opak_fixes_perf_test"],
      {},
      root,
    ),
  );
  refused(() => api.planBenchmark(["--dry-run"], env, root));
});

test("refuses production and staging URLs even when their database name is allowlisted", () => {
  for (const host of [
    "production.example",
    "staging.example",
    "127.0.0.2",
    "0.0.0.0",
  ])
    refused(() =>
      api.planBenchmark(
        args,
        {
          ...env,
          TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace("127.0.0.1", host),
        },
        root,
      ),
    );
});

test("refuses a general local database, a different name or an admin/runtime identity mismatch", () => {
  refused(() =>
    api.planBenchmark(
      ["--run", "--allow-local-db", "wukong"],
      {
        TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace(
          "opak_fixes_perf_test",
          "wukong",
        ),
        TEST_DATABASE_ADMIN_URL: env.TEST_DATABASE_ADMIN_URL.replace(
          "opak_fixes_perf_test",
          "wukong",
        ),
      },
      root,
    ),
  );
  refused(() =>
    api.planBenchmark(
      ["--run", "--allow-local-db", "opak_fixes_other"],
      env,
      root,
    ),
  );
  refused(() =>
    api.planBenchmark(
      args,
      {
        ...env,
        TEST_DATABASE_ADMIN_URL: env.TEST_DATABASE_ADMIN_URL.replace(
          "54399",
          "54398",
        ),
      },
      root,
    ),
  );
  refused(() =>
    api.planBenchmark(
      args,
      {
        ...env,
        TEST_DATABASE_ADMIN_URL: env.TEST_DATABASE_ADMIN_URL.replace(
          "perf_test",
          "other",
        ),
      },
      root,
    ),
  );
});

test("rejects connection overrides and privileged runtime roles before any connection", () => {
  for (const suffix of [
    "?host=remote.example",
    "?hostaddr=10.0.0.1",
    "?options=-c%20role%3Dpostgres",
  ])
    refused(() =>
      api.planBenchmark(
        args,
        { ...env, TEST_DATABASE_URL: env.TEST_DATABASE_URL + suffix },
        root,
      ),
    );
  refused(() =>
    api.planBenchmark(
      args,
      {
        ...env,
        TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace(
          "wukong_app:",
          "postgres:",
        ),
      },
      root,
    ),
  );
  refused(() =>
    api.planBenchmark(
      args,
      {
        ...env,
        TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace("postgres:", "https:"),
      },
      root,
    ),
  );
});

test("bounds scale, samples, concurrency and all flags", () => {
  const plan = api.planBenchmark(
    [
      ...args,
      "--sizes",
      "500,5000,20000",
      "--samples",
      "20",
      "--concurrency",
      "2",
    ],
    env,
    root,
  );
  assert.deepEqual(plan.sizes, [500, 5000, 20000]);
  assert.equal(plan.samples, 20);
  for (const extra of [
    ["--sizes", "1000000"],
    ["--samples", "0"],
    ["--samples", "201"],
    ["--concurrency", "0"],
    ["--concurrency", "17"],
    ["--unknown"],
    ["--run"],
  ])
    refused(() => api.planBenchmark([...args, ...extra], env, root));
});

test("restricts result files to ignored private JSON evidence", () => {
  assert.equal(
    api.planBenchmark(
      [...args, "--output", "node_modules/.opak-evidence/t10-test.json"],
      env,
      root,
    ).output,
    resolve(root, "node_modules/.opak-evidence/t10-test.json"),
  );
  for (const output of [
    "docs/public.json",
    "node_modules/.opak-evidence/../../public.json",
    "node_modules/.opak-evidence/test.txt",
  ])
    refused(() => api.planBenchmark([...args, "--output", output], env, root));
});

test("CLI dry-run succeeds on an unused port without importing factories, seeding or exposing credentials", () => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.mode, "dry-run");
  assert.equal(body.seeded, false);
  assert.equal(body.networkProbes, 0);
  assert.equal(result.stdout.includes("private-app-password"), false);
  assert.equal(result.stdout.includes("private-admin-password"), false);
});

test("CLI rejection never echoes a malformed secret-bearing URL", () => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      TEST_DATABASE_URL: "invalid-private-app-password",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes("invalid-private-app-password"), false);
});

test("sample summaries keep errors separate and label query wait without inventing pure DB time", () => {
  const summary = api.summarizeSamples(
    [
      {
        latencyMs: 10,
        status: 200,
        responseBytes: 100,
        clientQueryWaitMs: 7,
        applicationQueryCount: 2,
        blockedRows: 0,
      },
      {
        latencyMs: 30,
        status: 500,
        responseBytes: 20,
        clientQueryWaitMs: 4,
        applicationQueryCount: 1,
        blockedRows: 0,
      },
      {
        latencyMs: 20,
        status: 200,
        responseBytes: 200,
        clientQueryWaitMs: 11,
        applicationQueryCount: 3,
        blockedRows: 1,
      },
    ],
    12,
  );
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.errorRate, 1 / 3);
  assert.equal(summary.latencyMs.p95, 30);
  assert.equal(summary.responseBytes.total, 320);
  assert.equal(summary.executedSqlCount, 12);
  assert.equal(summary.clientQueryWaitMs.total, 22);
  assert.equal(summary.pureDbTimeMs, null);
  assert.equal(summary.blockedRows, 1);
});

test("EXPLAIN output omits captured SQL, parameters, relation names and filter values", () => {
  const result = api.summarizeExplain([
    {
      "Planning Time": 0.5,
      "Execution Time": 2,
      Plan: {
        "Node Type": "Aggregate",
        "Plan Rows": 1,
        "Actual Rows": 1,
        "Shared Hit Blocks": 3,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "private_relation",
            Filter: "private customer text",
            "Actual Rows": 500,
            "Plan Rows": 510,
            "Shared Read Blocks": 4,
          },
        ],
      },
    },
  ]);
  assert.equal(result.executionTimeMs, 2);
  assert.equal(result.planningTimeMs, 0.5);
  assert.deepEqual(result.nodeTypes, ["Aggregate", "Seq Scan"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("loads current catalog/detail/quality factories as ESM without network or provider calls", async () => {
  assert.equal(typeof api.loadBenchmarkRuntime, "function");
  const before = { ...process.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("benchmark factory import unexpectedly used network");
  };
  try {
    const runtime = await api.loadBenchmarkRuntime(env);
    loadedRuntime = runtime;
    assert.equal(typeof runtime.catalog.createCatalogHandler, "function");
    assert.equal(typeof runtime.detail.createListingViewHandler, "function");
    assert.equal(typeof runtime.quality.createQualityHandler, "function");
    assert.equal(typeof runtime.qualityBackfill.runQualityBackfill, "function");
    assert.equal(process.env.AI_PROVIDER, "fake");
    assert.equal(process.env.SHOPLINE_PUBLISH_ENABLED, "false");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test("synthetic rows satisfy current working/facts schemas and the real imported header/digest contract", () => {
  assert.equal(typeof api.syntheticProduct, "function");
  const row = api.syntheticProduct(loadedRuntime, 1);
  assert.equal(
    loadedRuntime.core.workingListingSchema.safeParse(row.content).success,
    true,
  );
  assert.equal(
    loadedRuntime.core.listingFactsSchema.safeParse(row.facts).success,
    true,
  );
  assert.equal(row.facts.vintage, 2020);
  assert.equal(row.rawRow.sku, "T10-SKU-000001");
  assert.equal(row.rawRow.productId, "t10-product-1");
  assert.equal(row.rawRow.nameEn, "Synthetic T10 wine 000001");
  assert.deepEqual(row.content.tags, ["synthetic", "wine"]);
  assert.notEqual(api.syntheticProduct(loadedRuntime, 0).digest, row.digest);
});

test("an empty successful name search is recorded as a correctness finding instead of fast success", () => {
  assert.deepEqual(
    api.assessBody("search-name", { items: [], totalMatching: 0 }, 500),
    {
      returnedRows: 0,
      totalMatching: 0,
      expectationFailures: ["expected_synthetic_catalog_result"],
    },
  );
  assert.deepEqual(
    api.assessBody(
      "search-sku",
      { items: [{ id: "synthetic" }], totalMatching: 1 },
      500,
    ).expectationFailures,
    [],
  );
  assert.deepEqual(
    api.assessBody("quality", { totalListings: 0, totalAssessed: 0 }, 500)
      .expectationFailures,
    ["quality_fixture_cardinality_mismatch"],
  );
});

test("the run entry also refuses dry mode before loading environment or touching a database", async () => {
  const plan = api.planBenchmark(args, env, root);
  const inaccessible = new Proxy(
    {},
    {
      get() {
        throw new Error("environment touched before mode guard");
      },
    },
  );
  await assert.rejects(
    api.runBenchmark(plan, inaccessible),
    /Benchmark refused:/,
  );
});

const projectedQuality = (assessed, pending = 500 - assessed) => ({
  totalListings: 500,
  totalAssessed: assessed,
  totalCostUsd: 0,
  unknownCostRunCount: 0,
  projection: {
    state: pending ? "pending" : "ready",
    pendingCount: pending,
    failedCount: 0,
    stale: pending > 0,
    asOf: "2026-10-01T00:00:00.000Z",
  },
});

test("quality first-load measurements retain pending work while steady samples require completion and live cost equality", () => {
  const first = api.assessBody("quality", projectedQuality(25), 500, {
    qualityPhase: "pending-first-load",
  });
  assert.deepEqual(first.expectationFailures, []);
  assert.equal(first.totalAssessed, 25);
  assert.equal(first.pendingCount, 475);
  assert.equal(first.projectionState, "pending");
  assert.equal(first.totalCostUsd, 0);
  const unknown = api.assessBody(
    "quality",
    { ...projectedQuality(500), totalCostUsd: 3.25, unknownCostRunCount: 2 },
    500,
    {
      qualityPhase: "steady-state",
      expectedCost: { totalCostUsd: 3.25, unknownCostRunCount: 2 },
    },
  );
  assert.equal(unknown.totalCostUsd, 3.25);
  assert.equal(unknown.unknownCostRunCount, 2);
  assert.deepEqual(unknown.expectationFailures, []);
  assert.equal(
    api
      .assessBody("quality", projectedQuality(25), 500, {
        qualityPhase: "steady-state",
      })
      .expectationFailures.includes("quality_projection_not_ready"),
    true,
  );
  assert.deepEqual(
    api.assessBody("quality", projectedQuality(500), 500, {
      qualityPhase: "steady-state",
      expectedCost: { totalCostUsd: 0, unknownCostRunCount: 0 },
    }).expectationFailures,
    [],
  );
  assert.equal(
    api
      .assessBody(
        "quality",
        { ...projectedQuality(500), totalCostUsd: 1 },
        500,
        {
          qualityPhase: "steady-state",
          expectedCost: { totalCostUsd: 0, unknownCostRunCount: 0 },
        },
      )
      .expectationFailures.includes("quality_live_cost_changed"),
    true,
  );
});

test("missing or failed projection evidence cannot become successful pending quality work", () => {
  for (const body of [
    { totalListings: 500, totalAssessed: 25 },
    {
      ...projectedQuality(25),
      projection: { ...projectedQuality(25).projection, failedCount: 1 },
    },
    {
      ...projectedQuality(25),
      projection: { ...projectedQuality(25).projection, pendingCount: 0 },
    },
  ]) {
    assert.notDeepEqual(
      api.assessBody("quality", body, 500, {
        qualityPhase: "pending-first-load",
      }).expectationFailures,
      [],
    );
  }
});

test("bounded quality preparation resumes committed progress outside warm samples and retains SQL counts", async () => {
  assert.equal(typeof api.prepareQualityProjection, "function");
  let calls = 0;
  const result = await api.prepareQualityProjection(
    async () => {
      calls++;
      return {
        completed: calls === 2,
        deadlineExpired: calls === 1,
        batches: 1,
        elapsedMs: 100,
        executedSqlCount: 7,
        totalListings: 500,
        totalAssessed: calls === 1 ? 250 : 500,
        pendingCount: calls === 1 ? 250 : 0,
        failedCount: 0,
        state: calls === 1 ? "pending" : "ready",
        knownCostUsd: calls === 1 ? null : 0,
        unknownCostRunCount: calls === 1 ? null : 0,
      };
    },
    500,
    { maxCycles: 2 },
  );
  assert.equal(calls, 2);
  assert.equal(result.completed, true);
  assert.equal(result.resumes, 1);
  assert.equal(result.executedSqlCount, 14);
  assert.equal(result.batches, 2);
  assert.equal(result.cycles[0].deadlineExpired, true);
  assert.equal(result.totalAssessed, 500);
  assert.equal(result.pendingCount, 0);
  assert.equal(result.knownCostUsd, 0);
});

test("quality preparation stops at its finite resume budget and refuses incomplete or failed ready claims", async () => {
  assert.equal(typeof api.prepareQualityProjection, "function");
  let calls = 0;
  const pending = {
    completed: false,
    batches: 1,
    elapsedMs: 1,
    executedSqlCount: 4,
    totalListings: 500,
    totalAssessed: 25,
    pendingCount: 475,
    failedCount: 0,
    state: "pending",
  };
  const result = await api.prepareQualityProjection(
    async () => {
      calls++;
      return pending;
    },
    500,
    { maxCycles: 2 },
  );
  assert.equal(calls, 2);
  assert.equal(result.completed, false);
  assert.equal(result.reason, "resume_budget_exhausted");
  for (const bad of [
    { ...pending, completed: true, state: "ready" },
    {
      ...pending,
      completed: true,
      totalAssessed: 500,
      pendingCount: 0,
      failedCount: 1,
      state: "failed",
    },
  ]) {
    await assert.rejects(
      api.prepareQualityProjection(async () => bad, 500),
      /Benchmark refused:/,
    );
  }
});

test("preparation deadline terminates only its owned pool and retains committed progress; ordinary DB failure propagates", async () => {
  assert.equal(typeof api.qualityPreparationCycle, "function");
  let deadline,
    closed = 0,
    ended = 0,
    observedTimeout,
    cleared = 0;
  const ownedSql = {
    async end(options) {
      assert.deepEqual(options, { timeout: 0 });
      ended++;
    },
  };
  const runtime = {
    postgres(_url, options) {
      observedTimeout = options.connection.statement_timeout;
      return ownedSql;
    },
    createDatabase(url, options) {
      options.createClient(url, {});
      return {
        async close() {
          closed++;
        },
      };
    },
    qualityBackfill: {
      async runQualityBackfill(_database, options, clock) {
        assert.equal(options.maxBatches, 1000);
        assert.equal(options.timeBudgetMs, 60000);
        clock.onBatch(projectedQuality(25), 1);
        deadline();
        throw new Error("owned terminated query");
      },
    },
  };
  const clock = {
    now: () => 10,
    setDeadline(callback, ms) {
      assert.equal(ms, 60000);
      deadline = callback;
      return "owned-timer";
    },
    clearDeadline(timer) {
      assert.equal(timer, "owned-timer");
      cleared++;
    },
  };
  const result = await api.qualityPreparationCycle(
    runtime,
    env,
    { workspaceId: "synthetic" },
    clock,
  );
  assert.equal(result.deadlineExpired, true);
  assert.equal(result.completed, false);
  assert.equal(result.totalAssessed, 25);
  assert.equal(result.pendingCount, 475);
  assert.equal(result.batches, 1);
  assert.equal(result.knownCostUsd, null);
  assert.equal(result.executedSqlCount, 0);
  assert.equal(observedTimeout, 10000);
  assert.equal(ended, 1);
  assert.equal(closed, 1);
  assert.equal(cleared, 1);
  runtime.qualityBackfill.runQualityBackfill = async () => {
    throw new Error("global permission failure");
  };
  await assert.rejects(
    api.qualityPreparationCycle(
      runtime,
      env,
      { workspaceId: "synthetic" },
      clock,
    ),
    /global permission failure/,
  );
  assert.equal(ended, 1);
  assert.equal(closed, 2);
});

test("cursor deep-page preparation uses the actual server cursor and compares ordered source-qualified row IDs without reporting IDs", async () => {
  assert.equal(typeof api.prepareCursorDeep, "function");
  const calls = [];
  const items = Array.from({ length: 25 }, (_, index) => ({
    sourceType: index % 2 ? "draft" : "platform",
    id: `private-row-${index}`,
  }));
  const result = await api.prepareCursorDeep(async (query) => {
    calls.push(query);
    return { items, totalMatching: 500, nextCursor: "actual_server_token" };
  }, 500);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { page: 20, pageSize: 25 });
  assert.deepEqual(calls[1], { page: 19, pageSize: 25 });
  assert.deepEqual(calls[2], {
    page: 20,
    pageSize: 25,
    cursor: "actual_server_token",
  });
  assert.equal(result.query.cursor, "actual_server_token");
  assert.equal(result.comparison.equal, true);
  assert.equal(result.comparison.rowCount, 25);
  assert.equal(result.comparison.legacyDigest, result.comparison.cursorDigest);
  assert.equal(
    JSON.stringify(result.comparison).includes("private-row"),
    false,
  );
  assert.equal(
    JSON.stringify(result.comparison).includes("actual_server_token"),
    false,
  );
});

test("cursor deep comparison refuses a different row order, total, blocked row or missing server cursor", async () => {
  assert.equal(typeof api.prepareCursorDeep, "function");
  const items = Array.from({ length: 25 }, (_, index) => ({
    sourceType: "platform",
    id: `row-${index}`,
  }));
  for (const changed of [
    { items: [...items].reverse(), totalMatching: 500 },
    { items, totalMatching: 499 },
    {
      items: [{ ...items[0], readState: "blocked" }, ...items.slice(1)],
      totalMatching: 500,
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      api.prepareCursorDeep(async () => {
        calls++;
        return calls === 3
          ? changed
          : { items, totalMatching: 500, nextCursor: "actual_server_token" };
      }, 500),
      /Benchmark refused:/,
    );
  }
  await assert.rejects(
    api.prepareCursorDeep(async () => ({ items, totalMatching: 500 }), 500),
    /Benchmark refused:/,
  );
});
