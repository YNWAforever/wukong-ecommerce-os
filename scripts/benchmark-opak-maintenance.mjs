/** Synthetic, loopback-only route-factory baseline. No HTTP server or provider calls. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  createRequire,
  registerHooks,
  stripTypeScriptTypes,
} from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REFUSE = "Benchmark refused: ";
const refuse = (reason) => {
  throw new Error(REFUSE + reason);
};
const number = (value, min, max) => {
  if (!/^\d+$/.test(value) || +value < min || +value > max)
    refuse("numeric option outside bounds");
  return +value;
};
function privatePath(value, root) {
  const directory = resolve(root, "node_modules/.opak-evidence");
  const path = resolve(root, value);
  const part = relative(directory, path);
  if (
    !part ||
    part.startsWith(`..${sep}`) ||
    part === ".." ||
    isAbsolute(part) ||
    !path.endsWith(".json")
  )
    refuse("output must be a private .opak-evidence JSON file");
  return path;
}
function databaseIdentity(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    refuse("invalid database URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    refuse("database connection overrides are forbidden");
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    refuse("only loopback databases are authorized");
  const name = url.pathname.slice(1);
  if (!/^opak_fixes_[a-z0-9_]+$/.test(name))
    refuse("database must have a dedicated opak_fixes_ name");
  return {
    host,
    port: url.port || "5432",
    name,
    role: decodeURIComponent(url.username),
  };
}
export function planBenchmark(argv, env = process.env, root = ROOT) {
  const values = {};
  const flags = new Set(["--run", "--dry-run"]);
  const options = new Set([
    "--allow-local-db",
    "--sizes",
    "--samples",
    "--concurrency",
    "--output",
    "--reuse",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key in values || (!flags.has(key) && !options.has(key)))
      refuse("unknown or repeated option");
    if (flags.has(key)) values[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) refuse("option requires a value");
      values[key] = value;
    }
  }
  if (Boolean(values["--run"]) === Boolean(values["--dry-run"]))
    refuse("choose --run or --dry-run explicitly");
  if (!env.TEST_DATABASE_URL || !env.TEST_DATABASE_ADMIN_URL)
    refuse("explicit test database URLs are required");
  const app = databaseIdentity(env.TEST_DATABASE_URL);
  const admin = databaseIdentity(env.TEST_DATABASE_ADMIN_URL);
  if (app.name !== values["--allow-local-db"])
    refuse("exact local database allowlist is required");
  if (
    app.host !== admin.host ||
    app.port !== admin.port ||
    app.name !== admin.name
  )
    refuse("admin and runtime database identities differ");
  if (app.role !== "wukong_app" || !admin.role || admin.role === "wukong_app")
    refuse("application and provisioning roles must be distinct");
  const sizes = (values["--sizes"] ?? "500")
    .split(",")
    .map((value) => number(value, 500, 20000));
  if (
    sizes.some((size) => ![500, 5000, 20000].includes(size)) ||
    new Set(sizes).size !== sizes.length
  )
    refuse("supported fixture scales are 500,5000,20000");
  return {
    mode: values["--run"] ? "run" : "dry-run",
    database: {
      host: app.host,
      port: app.port,
      name: app.name,
      runtimeRole: app.role,
    },
    sizes,
    samples: number(values["--samples"] ?? "10", 3, 200),
    concurrency: number(values["--concurrency"] ?? "1", 1, 16),
    output: privatePath(
      values["--output"] ??
        `node_modules/.opak-evidence/t10-${Date.now()}.json`,
      root,
    ),
    reuse: values["--reuse"] ? privatePath(values["--reuse"], root) : null,
  };
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {
    min: sorted[0] ?? null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
    total: values.reduce((sum, value) => sum + value, 0),
  };
}
export function summarizeSamples(samples, executedSqlCount) {
  const errorCount = samples.filter(
    (sample) => sample.status < 200 || sample.status >= 300,
  ).length;
  return {
    sampleCount: samples.length,
    errorCount,
    errorRate: samples.length ? errorCount / samples.length : null,
    latencyMs: distribution(samples.map((sample) => sample.latencyMs)),
    responseBytes: distribution(samples.map((sample) => sample.responseBytes)),
    executedSqlCount,
    applicationQueryCount: distribution(
      samples.map((sample) => sample.applicationQueryCount),
    ),
    clientQueryWaitMs: distribution(
      samples.map((sample) => sample.clientQueryWaitMs),
    ),
    clientQueryWaitMeaning:
      "Sum of awaited application SQL client durations, including queue/network/decoding; overlapping waits may exceed route wall time. Transaction controls are excluded here.",
    pureDbTimeMs: null,
    pureDbTimeReason:
      "Driver wait is not server execution time. Server execution is measured separately by sampled EXPLAIN ANALYZE.",
    blockedRows: samples.reduce((sum, sample) => sum + sample.blockedRows, 0),
    expectationFailureCount: samples.filter(
      (sample) => sample.expectationFailures?.length,
    ).length,
  };
}
export function assessBody(name, body, count, options = {}) {
  const expectationFailures = [];
  if (name !== "quality" && name !== "detail") {
    const returnedRows = body.items?.length ?? 0;
    if (!returnedRows)
      expectationFailures.push("expected_synthetic_catalog_result");
    return {
      returnedRows,
      totalMatching: body.totalMatching ?? null,
      expectationFailures,
    };
  }
  const allowPending = options.qualityPhase === "pending-first-load";
  if (
    name === "quality" &&
    (body.totalListings !== count ||
      (!allowPending && body.totalAssessed !== count) ||
      (allowPending &&
        (!Number.isInteger(body.totalAssessed) ||
          body.totalAssessed < 0 ||
          body.totalAssessed > count)))
  )
    expectationFailures.push("quality_fixture_cardinality_mismatch");
  if (name === "quality" && options.qualityPhase) {
    const projection = body.projection;
    if (
      !projection ||
      !Number.isInteger(projection.pendingCount) ||
      projection.pendingCount < 0 ||
      projection.failedCount !== 0 ||
      body.totalAssessed + projection.pendingCount !== count ||
      projection.state !== (projection.pendingCount ? "pending" : "ready") ||
      projection.stale !== projection.pendingCount > 0
    )
      expectationFailures.push("quality_projection_evidence_invalid");
    if (
      !allowPending &&
      (projection?.state !== "ready" ||
        projection?.pendingCount !== 0 ||
        projection?.failedCount !== 0 ||
        projection?.stale !== false)
    )
      expectationFailures.push("quality_projection_not_ready");
    if (
      !Number.isFinite(body.totalCostUsd) ||
      body.totalCostUsd < 0 ||
      !Number.isInteger(body.unknownCostRunCount) ||
      body.unknownCostRunCount < 0
    )
      expectationFailures.push("quality_live_cost_evidence_invalid");
    if (
      options.expectedCost &&
      (body.totalCostUsd !== options.expectedCost.totalCostUsd ||
        body.unknownCostRunCount !== options.expectedCost.unknownCostRunCount)
    )
      expectationFailures.push("quality_live_cost_changed");
  }
  return {
    totalListings: body.totalListings ?? null,
    totalAssessed: body.totalAssessed ?? null,
    unknownCostRunCount: body.unknownCostRunCount ?? null,
    ...(name === "quality" && options.qualityPhase
      ? {
          totalCostUsd: body.totalCostUsd ?? null,
          projectionState: body.projection?.state ?? null,
          pendingCount: body.projection?.pendingCount ?? null,
          failedCount: body.projection?.failedCount ?? null,
          projectionStale: body.projection?.stale ?? null,
          projectionAsOf: body.projection?.asOf ?? null,
          costScope: body.costScope ?? null,
          qualityPhase: options.qualityPhase,
        }
      : {}),
    expectationFailures,
  };
}

export async function prepareQualityProjection(
  runCycle,
  count,
  { maxCycles = 20 } = {},
) {
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 20)
    refuse("quality resume budget outside bounds");
  const started = performance.now(),
    cycles = [];
  for (let index = 0; index < maxCycles; index++) {
    const observed = await runCycle(index);
    const cycle = Object.fromEntries(
      [
        "completed",
        "deadlineExpired",
        "batches",
        "elapsedMs",
        "executedSqlCount",
        "totalListings",
        "totalAssessed",
        "pendingCount",
        "failedCount",
        "state",
        "asOf",
        "knownCostUsd",
        "unknownCostRunCount",
        "costAsOf",
        "progress",
      ].map((key) => [key, observed[key] ?? null]),
    );
    if (
      !Number.isInteger(cycle.batches) ||
      cycle.batches < 0 ||
      cycle.batches > 1000 ||
      !Number.isInteger(cycle.executedSqlCount) ||
      cycle.executedSqlCount < 0 ||
      !Number.isFinite(cycle.elapsedMs) ||
      cycle.elapsedMs < 0
    )
      refuse("quality preparation measurement invalid");
    const noCommittedBatch =
      cycle.batches === 0 && cycle.deadlineExpired === true;
    if (
      !noCommittedBatch &&
      (cycle.totalListings !== count ||
        !Number.isInteger(cycle.totalAssessed) ||
        cycle.totalAssessed < 0 ||
        !Number.isInteger(cycle.pendingCount) ||
        cycle.pendingCount < 0 ||
        cycle.failedCount !== 0 ||
        cycle.totalAssessed + cycle.pendingCount !== count ||
        cycle.state !== (cycle.pendingCount ? "pending" : "ready"))
    )
      refuse(
        "quality preparation progress does not match the synthetic fixture",
      );
    if (
      cycle.completed &&
      (noCommittedBatch ||
        cycle.pendingCount !== 0 ||
        cycle.totalAssessed !== count ||
        cycle.state !== "ready" ||
        !Number.isFinite(cycle.knownCostUsd) ||
        cycle.knownCostUsd < 0 ||
        !Number.isInteger(cycle.unknownCostRunCount) ||
        cycle.unknownCostRunCount < 0)
    )
      refuse(
        "quality preparation claimed completion without current projection and live cost evidence",
      );
    cycles.push(cycle);
    if (cycle.completed) break;
  }
  const last = cycles.at(-1);
  return {
    meaning:
      "Explicit bounded quality backfill outside all cold/warm route sample timings; committed progress resumes in a fresh owned pool after a deadline.",
    maxCycles,
    maxBatchesPerCycle: 1000,
    timeBudgetMsPerCycle: 60000,
    completed: last.completed === true,
    reason: last.completed ? null : "resume_budget_exhausted",
    elapsedMs: performance.now() - started,
    executedSqlCount: cycles.reduce(
      (sum, cycle) => sum + cycle.executedSqlCount,
      0,
    ),
    batches: cycles.reduce((sum, cycle) => sum + cycle.batches, 0),
    resumes: cycles.length - 1,
    totalListings: last.totalListings,
    totalAssessed: last.totalAssessed,
    pendingCount: last.pendingCount,
    failedCount: last.failedCount,
    state: last.state,
    knownCostUsd: last.knownCostUsd,
    unknownCostRunCount: last.unknownCostRunCount,
    cycles,
  };
}

export async function prepareCursorDeep(readPage, count) {
  const page = Math.ceil(count / 25),
    started = performance.now();
  if (!Number.isInteger(count) || count < 500 || count > 20000)
    refuse("cursor comparison fixture outside bounds");
  const legacy = await readPage({ page, pageSize: 25 });
  const anchor = await readPage({ page: page - 1, pageSize: 25 });
  const token = anchor.nextCursor;
  if (typeof token !== "string" || !/^[a-zA-Z0-9_-]{1,1024}$/.test(token))
    refuse("deep cursor requires an actual bounded server nextCursor");
  const query = { page, pageSize: 25, cursor: token };
  const cursor = await readPage(query);
  const identities = (body) => {
    if (
      body.totalMatching !== count ||
      !Array.isArray(body.items) ||
      body.items.length !== count - (page - 1) * 25 ||
      body.items.some(
        (row) =>
          typeof row.id !== "string" ||
          !row.id ||
          !["draft", "platform", "website", "workbook"].includes(
            row.sourceType,
          ) ||
          row.readState === "blocked",
      )
    )
      refuse("deep cursor comparison response is incomplete or blocked");
    return body.items.map((row) => [row.sourceType, row.id]);
  };
  const legacyRows = identities(legacy),
    cursorRows = identities(cursor);
  if (JSON.stringify(legacyRows) !== JSON.stringify(cursorRows))
    refuse("cursor deep row order differs from the legacy deep page");
  const digest = (rows) =>
    createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return {
    query,
    comparison: {
      method:
        "Exact ordered sourceType/id tuple equality; row IDs and server token remain in memory only.",
      equal: true,
      rowCount: legacyRows.length,
      totalMatching: count,
      legacyDigest: digest(legacyRows),
      cursorDigest: digest(cursorRows),
      setupRequestCount: 3,
      setupWallMs: performance.now() - started,
    },
  };
}
export function summarizeExplain(rows) {
  const result = rows[0];
  const nodeTypes = new Set();
  let nodeCount = 0;
  function visit(node) {
    if (!node) return;
    nodeCount++;
    nodeTypes.add(node["Node Type"]);
    for (const child of node.Plans ?? []) visit(child);
  }
  visit(result.Plan);
  return {
    planningTimeMs: result["Planning Time"] ?? null,
    executionTimeMs: result["Execution Time"] ?? null,
    actualRows: result.Plan?.["Actual Rows"] ?? null,
    estimatedRows: result.Plan?.["Plan Rows"] ?? null,
    sharedHitBlocks: result.Plan?.["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: result.Plan?.["Shared Read Blocks"] ?? 0,
    nodeCount,
    nodeTypes: [...nodeTypes],
  };
}

export async function loadBenchmarkRuntime(env) {
  // Set fail-closed process flags before factory module imports, not only on injected deps.
  Object.assign(process.env, {
    DATABASE_URL: env.TEST_DATABASE_URL,
    AI_PROVIDER: "fake",
    SHOPLINE_ADAPTER: "mock",
    SHOPLINE_PUBLISH_ENABLED: "false",
    LISTING_PAID_OPERATIONS_ENABLED: "false",
    WINE_ENRICHMENT_ENABLED: "false",
  });
  delete process.env.DATABASE_MIGRATIONS_DIR;
  const require = createRequire(
    new URL("../packages/db/package.json", import.meta.url),
  );
  const { register } = await import(
    pathToFileURL(require.resolve("tsx/esm/api")).href
  );
  register({ tsconfig: resolve(ROOT, "apps/web/tsconfig.json") });
  // Web has no package type=module. Its current source factories must remain ESM
  // instead of requiring their already imported ESM dependencies through CJS.
  const webRoot = pathToFileURL(resolve(ROOT, "apps/web") + sep).href;
  registerHooks({
    load(url, context, next) {
      if (url.startsWith(webRoot) && url.endsWith(".ts"))
        return {
          format: "module",
          shortCircuit: true,
          source: stripTypeScriptTypes(
            readFileSync(fileURLToPath(url), "utf8"),
            { mode: "transform" },
          ),
        };
      return next(url, context);
    },
  });
  const { default: postgres } = await import(
    pathToFileURL(require.resolve("postgres")).href
  );
  const [
    { createDatabase },
    core,
    shopline,
    catalog,
    detail,
    quality,
    qualityBackfill,
  ] = await Promise.all([
    import(pathToFileURL(resolve(ROOT, "packages/db/src/client.ts")).href),
    import(pathToFileURL(resolve(ROOT, "packages/core/src/index.ts")).href),
    import(pathToFileURL(resolve(ROOT, "packages/shopline/src/index.ts")).href),
    import(
      pathToFileURL(resolve(ROOT, "apps/web/app/api/catalog/route.ts")).href
    ),
    import(
      pathToFileURL(resolve(ROOT, "apps/web/app/api/listings/[id]/route.ts"))
        .href
    ),
    import(
      pathToFileURL(resolve(ROOT, "apps/web/app/api/quality/route.ts")).href
    ),
    import(
      pathToFileURL(resolve(ROOT, "packages/db/src/cli/quality-backfill.ts"))
        .href
    ),
  ]);
  return {
    postgres,
    createDatabase,
    core,
    shopline,
    catalog,
    detail,
    quality,
    qualityBackfill,
  };
}

async function atBenchmarkStage(stage, work) {
  try {
    return await work();
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error("benchmark_stage_failed"),
      { benchmarkStage: stage },
    );
  }
}

function instrumentClient(postgres, state, clientOptions = {}) {
  const scopes = new AsyncLocalStorage();
  state.scopes = scopes;
  const wrap = (sql) =>
    new Proxy(sql, {
      get(target, key) {
        if (key === "begin" || key === "savepoint")
          return (...args) => {
            const callback = args.at(-1);
            if (typeof callback !== "function") return target[key](...args);
            return target[key](...args.slice(0, -1), (transaction) =>
              callback(wrap(transaction)),
            );
          };
        if (key === "unsafe")
          return (text, params, options) => {
            const query = target.unsafe(text, params, options);
            const sample = scopes.getStore();
            if (!sample) return query;
            const then = query.then.bind(query);
            let promise;
            query.then = (onOk, onFail) => {
              if (!promise) {
                const start = performance.now();
                sample.applicationQueryCount++;
                promise = then(
                  (value) => {
                    sample.clientQueryWaitMs += performance.now() - start;
                    return value;
                  },
                  (error) => {
                    sample.clientQueryWaitMs += performance.now() - start;
                    throw error;
                  },
                );
              }
              return promise.then(onOk, onFail);
            };
            return query;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return (url, options) => {
    const sql = postgres(url, {
      ...options,
      ...clientOptions,
      debug(_connection, text, params) {
        // Actual driver statement count includes transaction controls. SQL/params remain in memory only.
        if (state.group) {
          state.group.executedSqlCount++;
          if (
            /^\s*(select|with)\b/i.test(text) &&
            !/select\s+set_config\(/i.test(text)
          ) {
            const fingerprint = createHash("sha256").update(text).digest("hex");
            if (
              state.group.queries.size < 12 &&
              !state.group.queries.has(fingerprint)
            )
              state.group.queries.set(fingerprint, {
                text,
                params: [...params],
              });
          }
        }
      },
    });
    state.sql = sql;
    return wrap(sql);
  };
}

async function assertDatabase(sql, plan, application) {
  const [row] =
    await sql`select current_database() as name,current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  if (
    !row ||
    row.name !== plan.database.name ||
    (application &&
      (row.role !== "wukong_app" || row.rolsuper || row.rolbypassrls))
  )
    refuse(
      "connected database/role identity does not match the authorized fixture",
    );
}

export function syntheticProduct(runtime, i) {
  const sku = `T10-SKU-${String(i).padStart(6, "0")}`;
  const title = `Synthetic T10 wine ${String(i).padStart(6, "0")}`;
  const facts = runtime.core.listingFactsSchema.parse({
    ...runtime.core.emptyWorkingListing(),
    sku,
    producer: "Synthetic winery",
    productType: "wine",
    country: "France",
    region: "Synthetic region",
    vintage: 2020,
    volumeMl: 750,
    abvPercent: 13,
    packQuantity: 1,
    priceHkd: 100,
    stockQuantity: 10,
  });
  const content = runtime.core.workingListingSchema.parse({
    ...runtime.core.emptyWorkingListing(),
    ...facts,
    title: { en: title, "zh-Hant": i % 3 === 0 ? "" : `合成酒款 ${i}` },
    description: {
      en: "Synthetic description for controlled performance testing.",
      "zh-Hant": "僅供合成效能測試的描述。",
    },
    seo: {
      title: { en: title, "zh-Hant": "合成測試標題" },
      description: {
        en: "Synthetic SEO description.",
        "zh-Hant": "合成測試摘要。",
      },
    },
    tags: ["synthetic", "wine"],
  });
  const rawRow = {
    productId: `t10-product-${i}`,
    sku,
    nameEn: title,
    nameZh: content.title["zh-Hant"],
    summaryEn: content.description.en,
    summaryZh: content.description["zh-Hant"],
    seoTitleEn: content.seo.title.en,
    seoTitleZh: content.seo.title["zh-Hant"],
    seoDescriptionEn: content.seo.description.en,
    seoDescriptionZh: content.seo.description["zh-Hant"],
    seoKeywords: "synthetic,wine",
  };
  return {
    sku,
    facts,
    content,
    rawRow,
    digest: runtime.shopline.hashBulkFormRow(rawRow),
  };
}

async function seedFixture(admin, runtime, count) {
  const suffix = randomUUID();
  const workspaceId = `ws_t10_${suffix.replaceAll("-", "")}`;
  const actorId = `user_t10_${suffix}`;
  const connectionId = randomUUID();
  const importId = randomUUID();
  const profile = runtime.core.workspaceProfileSchema.parse({
    name: "Synthetic T10 baseline",
    currency: "HKD",
    locales: ["en", "zh-Hant"],
    tone: "Plain synthetic facts",
    claimPolicy: [],
    requiredFields: [],
  });
  return admin.begin(async (sql) => {
    await sql`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic T10 baseline',${sql.json(profile)})`;
    await sql`insert into users(id,email) values (${actorId},${actorId + "@local.invalid"})`;
    await sql`insert into memberships(workspace_id,user_id,role) values (${workspaceId},${actorId},'admin')`;
    await sql`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connectionId},${workspaceId},'t10-synthetic.invalid','synthetic-disabled-not-a-token')`;
    await sql`insert into source_imports(id,workspace_id,connection_id,filename,workbook_sha256,header_contract_sha256,sheet_name,row_count,merchant_attested_export_at,importer_id,spec_version) values (${importId},${workspaceId},${connectionId},'synthetic-t10.xlsx',${createHash("sha256").update(suffix).digest("hex")},${runtime.shopline.hashBulkFormHeaderContract()},'Synthetic',${count},now(),${actorId},${runtime.shopline.SHOPLINE_BULK_FORM_SPEC_VERSION})`;
    let firstListingId;
    for (let offset = 0; offset < count; offset += 500) {
      const drafts = [],
        products = [],
        inputs = [];
      for (let i = offset; i < Math.min(offset + 500, count); i++) {
        const listingId = randomUUID();
        firstListingId ??= listingId;
        const { sku, facts, content, rawRow, digest } = syntheticProduct(
          runtime,
          i,
        );
        drafts.push({
          id: listingId,
          workspace_id: workspaceId,
          target: "shopline",
          note: "Synthetic T10 fixture",
          input_revision: 1,
        });
        products.push({
          id: randomUUID(),
          workspace_id: workspaceId,
          connection_id: connectionId,
          remote_product_id: `t10-product-${i}`,
          origin: "import",
          sku,
          listing_id: listingId,
          spec_version: runtime.shopline.SHOPLINE_BULK_FORM_SPEC_VERSION,
          raw_row: rawRow,
          facts_prefill: facts,
          content_digest: digest,
          source_import_id: importId,
        });
        inputs.push({
          workspace_id: workspaceId,
          listing_id: listingId,
          revision: 1,
          sources: [],
          working_content: content,
          field_states: {},
          input_digest: createHash("sha256")
            .update(JSON.stringify(content))
            .digest("hex"),
          actor_id: actorId,
        });
      }
      await sql`insert into listing_drafts ${sql(drafts)}`;
      await sql`insert into platform_products ${sql(products)}`;
      await sql`insert into listing_input_revisions ${sql(inputs)}`;
      if (offset + 500 >= count)
        return {
          workspaceId,
          actorId,
          connectionId,
          importId,
          firstListingId,
          count,
        };
    }
  });
}

async function explainCaptured(sql, workspaceId, queries) {
  const results = [];
  for (const [fingerprint, query] of queries) {
    try {
      const result = await sql.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${workspaceId},true)`;
        await tx`set local statement_timeout='15s'`;
        return tx.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
          query.params,
        );
      });
      results.push({
        fingerprint,
        ...summarizeExplain(result[0]["QUERY PLAN"]),
      });
    } catch {
      results.push({ fingerprint, unavailable: true });
    }
  }
  return results;
}

async function sampleGroup(
  state,
  operation,
  count,
  concurrency,
  name,
  fixtureCount,
  assessmentOptions = {},
) {
  const samples = [];
  state.group = { executedSqlCount: 0, queries: new Map() };
  const started = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next++ < count) {
        const sample = {
          clientQueryWaitMs: 0,
          applicationQueryCount: 0,
          blockedRows: 0,
        };
        const start = performance.now();
        await state.scopes.run(sample, async () => {
          try {
            const response = await operation();
            const text = await response.text();
            sample.status = response.status;
            sample.responseBytes = Buffer.byteLength(text);
            if (response.ok) {
              const body = JSON.parse(text);
              Object.assign(
                sample,
                assessBody(name, body, fixtureCount, assessmentOptions),
              );
              sample.blockedRows =
                (body.items ?? []).filter(
                  (item) => item.readState === "blocked",
                ).length + (body.readState === "blocked" ? 1 : 0);
            }
          } catch {
            sample.status = 599;
            sample.responseBytes = 0;
          }
        });
        sample.latencyMs = performance.now() - start;
        samples.push(sample);
      }
    }),
  );
  const group = state.group;
  state.group = null;
  return {
    samples,
    queries: group.queries,
    summary: {
      ...summarizeSamples(samples, group.executedSqlCount),
      groupWallMs: performance.now() - started,
      concurrency,
    },
  };
}

export async function qualityPreparationCycle(
  runtime,
  env,
  fixture,
  clock = {
    now: () => performance.now(),
    setDeadline: setTimeout,
    clearDeadline: clearTimeout,
  },
) {
  const state = { group: { executedSqlCount: 0, queries: new Map() } };
  const database = runtime.createDatabase(env.TEST_DATABASE_URL, {
    maxConnections: 1,
    createClient: instrumentClient(runtime.postgres, state, {
      connection: { statement_timeout: 10000 },
    }),
  });
  let deadlineExpired = false,
    lastCommitted = null;
  const progress = [],
    started = clock.now();
  const timer = clock.setDeadline(() => {
    deadlineExpired = true;
    // This is the dedicated preparation pool only; never terminates another session.
    void state.sql.end({ timeout: 0 }).catch(() => undefined);
  }, 60000);
  try {
    let result;
    try {
      result = await runtime.qualityBackfill.runQualityBackfill(
        database,
        {
          workspaceId: fixture.workspaceId,
          maxBatches: 1000,
          timeBudgetMs: 60000,
        },
        {
          now: clock.now,
          onBatch(summary, batches) {
            lastCommitted = {
              batches,
              totalListings: summary.totalListings,
              totalAssessed: summary.totalAssessed,
              state: summary.projection.state,
              asOf: summary.projection.asOf,
              pendingCount: summary.projection.pendingCount,
              failedCount: summary.projection.failedCount,
            };
            progress.push({
              ...lastCommitted,
              elapsedMs: clock.now() - started,
            });
          },
        },
      );
    } catch (error) {
      if (!deadlineExpired) throw error;
      result = {
        completed: false,
        batches: 0,
        ...lastCommitted,
        knownCostUsd: null,
        unknownCostRunCount: null,
      };
    }
    return {
      ...result,
      progress,
      deadlineExpired,
      elapsedMs: clock.now() - started,
      executedSqlCount: state.group.executedSqlCount,
    };
  } finally {
    clock.clearDeadline(timer);
    await database.close();
    state.group = null;
  }
}

async function cursorPreparation(runtime, env, fixture, sessionContext) {
  const state = { group: { executedSqlCount: 0, queries: new Map() } };
  const database = runtime.createDatabase(env.TEST_DATABASE_URL, {
    maxConnections: 1,
    createClient: instrumentClient(runtime.postgres, state),
  });
  try {
    const handler = runtime.catalog.createCatalogHandler({
      sessionContext,
      getDatabase: () => database,
    });
    const prepared = await prepareCursorDeep(async (query) => {
      const response = await handler(
        new Request(
          "http://benchmark.local/api/catalog?" + new URLSearchParams(query),
        ),
      );
      if (!response.ok) refuse("cursor preparation HTTP request failed");
      return response.json();
    }, fixture.count);
    prepared.comparison.setupExecutedSqlCount = state.group.executedSqlCount;
    return prepared;
  } finally {
    await database.close();
    state.group = null;
  }
}

async function verifyPrivateOutput(plan) {
  await mkdir(dirname(plan.output), { recursive: true });
  const actual = await realpath(dirname(plan.output));
  const expected = await realpath(resolve(ROOT, "node_modules/.opak-evidence"));
  const part = relative(expected, actual);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
    refuse("private output directory escapes the workspace");
  try {
    await lstat(plan.output);
    refuse("output already exists; choose a new private evidence file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (plan.reuse) {
    const input = relative(expected, await realpath(plan.reuse));
    if (input === ".." || input.startsWith(`..${sep}`) || isAbsolute(input))
      refuse("reuse evidence escapes the private directory");
  }
}

export async function runBenchmark(plan, env = process.env) {
  if (plan?.mode !== "run") refuse("run entry requires explicit run mode");
  // The callable entry has the same URL/output/load bounds as the CLI.
  plan = planBenchmark(
    [
      "--run",
      "--allow-local-db",
      plan.database?.name,
      "--sizes",
      plan.sizes?.join(","),
      "--samples",
      String(plan.samples),
      "--concurrency",
      String(plan.concurrency),
      "--output",
      plan.output,
      ...(plan.reuse ? ["--reuse", plan.reuse] : []),
    ],
    env,
  );
  await verifyPrivateOutput(plan);
  const runtime = await atBenchmarkStage("runtime_load", () =>
    loadBenchmarkRuntime(env),
  );
  const admin = runtime.postgres(env.TEST_DATABASE_ADMIN_URL, {
    max: 1,
    prepare: false,
    onnotice() {},
  });
  const probe = runtime.postgres(env.TEST_DATABASE_URL, {
    max: 1,
    prepare: false,
    onnotice() {},
  });
  const report = {
    schema: "opak-t10-baseline-v1",
    capturedAt: new Date().toISOString(),
    database: plan.database,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpuCount: cpus().length,
      hostMemoryBytes: totalmem(),
      provider: "fake",
      shopline: "mock",
      publishing: false,
      transport:
        "actual route factories and actual RLS repositories; in-process, no HTTP transport",
      maxConnections: plan.concurrency,
      warmSamples: plan.samples,
      coldSamples: 1,
      concurrency: plan.concurrency,
    },
    coldMeaning:
      "Fresh application DB pool per route group. PostgreSQL/OS shared caches are not flushed; seed and schema checks may already warm them.",
    responseBytesMeaning:
      "UTF-8 JSON body before HTTP compression and without header bytes.",
    qualityColdMeaning:
      "The first observed projection response after a fresh route pool is sampled exactly as returned, including pending work. It is not equivalent to a full-population clean assessment; persisted progress may exist on repeat reuse runs.",
    findings: [],
    datasets: [],
  };
  let reused;
  try {
    await atBenchmarkStage("admin_identity", () =>
      assertDatabase(admin, plan, false),
    );
    await atBenchmarkStage("runtime_identity", () =>
      assertDatabase(probe, plan, true),
    );
    const [databaseConfig] =
      await probe`select current_setting('server_version') version,current_setting('shared_buffers') shared_buffers,current_setting('max_connections') max_connections,current_setting('jit') jit`;
    report.environment.postgres = {
      ...databaseConfig,
      runtimeRole: "wukong_app",
      superuser: false,
      bypassRls: false,
    };
    const migration = runtime.createDatabase(env.TEST_DATABASE_URL, {
      migrationUrl: env.TEST_DATABASE_ADMIN_URL,
    });
    try {
      await atBenchmarkStage("dedicated_schema", () => migration.migrate());
    } finally {
      await migration.close();
    }
    if (plan.reuse) {
      reused = JSON.parse(await readFile(plan.reuse, "utf8"));
      if (
        reused.schema !== report.schema ||
        JSON.stringify(reused.database) !== JSON.stringify(plan.database)
      )
        refuse("reuse evidence database does not match");
    }
    for (const size of plan.sizes) {
      const existing = reused?.datasets.find(
        (dataset) => dataset.fixture.count === size,
      )?.fixture;
      if (reused && !existing)
        refuse(
          "reuse evidence lacks a requested scale; implicit reseeding is forbidden",
        );
      const fixture =
        existing ??
        (await atBenchmarkStage("synthetic_seed", () =>
          seedFixture(admin, runtime, size),
        ));
      if (
        !/^ws_t10_[a-f0-9]{32}$/.test(fixture.workspaceId) ||
        !/^user_t10_[a-f0-9-]{36}$/.test(fixture.actorId)
      )
        refuse("reuse fixture is not a synthetic T10 identity");
      const [counts] =
        await admin`select (select count(*)::int from platform_products where workspace_id=${fixture.workspaceId}) products,(select count(*)::int from listing_drafts where workspace_id=${fixture.workspaceId}) drafts`;
      if (counts.products !== size || counts.drafts !== size)
        refuse("synthetic fixture cardinality differs");
      const dataset = { fixture, operations: [] };
      report.datasets.push(dataset);
      const sessionContext = {
        async resolve() {
          return {
            workspaceId: fixture.workspaceId,
            actorId: fixture.actorId,
            role: "admin",
          };
        },
      };
      for (const name of [
        "catalog-1",
        "catalog-25",
        "catalog-deep-25",
        "search-sku",
        "search-name",
        "detail",
        "quality",
        "catalog-cursor-deep-25",
      ]) {
        const cursorPrepared =
          name === "catalog-cursor-deep-25"
            ? await atBenchmarkStage("cursor_deep_comparison", () =>
                cursorPreparation(runtime, env, fixture, sessionContext),
              )
            : null;
        const state = { group: null };
        const database = runtime.createDatabase(env.TEST_DATABASE_URL, {
          maxConnections: plan.concurrency,
          createClient: instrumentClient(runtime.postgres, state),
        });
        try {
          const deps = { sessionContext, getDatabase: () => database };
          const catalog = runtime.catalog.createCatalogHandler(deps);
          const detail = runtime.detail.createListingViewHandler({
            ...deps,
            getAssetStore: () => ({
              async createReadUrl() {
                throw new Error("unexpected synthetic asset");
              },
            }),
          });
          const quality = runtime.quality.createQualityHandler(deps);
          const query =
            name === "catalog-1"
              ? "pageSize=1"
              : cursorPrepared
                ? new URLSearchParams(cursorPrepared.query).toString()
                : name === "catalog-deep-25"
                  ? `page=${Math.ceil(size / 25)}&pageSize=25`
                  : name === "search-sku"
                    ? "q=T10-SKU-000001&pageSize=25"
                    : name === "search-name"
                      ? "q=Synthetic%20T10%20wine&pageSize=25"
                      : "pageSize=25";
          const operation =
            name === "detail"
              ? () =>
                  detail(
                    new Request(
                      "http://benchmark.local/api/listings/" +
                        fixture.firstListingId,
                    ),
                    { params: Promise.resolve({ id: fixture.firstListingId }) },
                  )
              : name === "quality"
                ? () => quality()
                : () =>
                    catalog(
                      new Request(
                        "http://benchmark.local/api/catalog?" + query,
                      ),
                    );
          const cold = await sampleGroup(
            state,
            operation,
            1,
            1,
            name,
            size,
            name === "quality" ? { qualityPhase: "pending-first-load" } : {},
          );
          const qualityPreparation =
            name === "quality"
              ? await atBenchmarkStage("quality_projection_preparation", () =>
                  prepareQualityProjection(
                    () => qualityPreparationCycle(runtime, env, fixture),
                    size,
                  ),
                )
              : null;
          const expectedCost =
            name === "quality"
              ? {
                  totalCostUsd: cold.samples[0].totalCostUsd,
                  unknownCostRunCount: cold.samples[0].unknownCostRunCount,
                }
              : null;
          const warmSkipped =
            qualityPreparation && !qualityPreparation.completed;
          const warm = await sampleGroup(
            state,
            operation,
            warmSkipped ? 0 : plan.samples,
            plan.concurrency,
            name,
            size,
            name === "quality"
              ? { qualityPhase: "steady-state", expectedCost }
              : {},
          );
          const explain = await explainCaptured(
            state.sql,
            fixture.workspaceId,
            warm.queries,
          );
          const target =
            name === "detail"
              ? 1500
              : name.startsWith("catalog-")
                ? 800
                : name.startsWith("search-")
                  ? 1000
                  : null;
          dataset.operations.push({
            name,
            baselineComparable: name !== "catalog-cursor-deep-25",
            ...(cursorPrepared
              ? { cursorComparison: cursorPrepared.comparison }
              : {}),
            ...(qualityPreparation
              ? {
                  preparation: qualityPreparation,
                  warmSkippedReason: warmSkipped
                    ? "quality_projection_preparation_incomplete"
                    : null,
                }
              : {}),
            cold: cold.summary,
            warm: warm.summary,
            samples: { cold: cold.samples, warm: warm.samples },
            explain,
            targetP95Ms: target,
            targetMet:
              target === null
                ? null
                : warm.summary.errorCount === 0 &&
                  warm.summary.blockedRows === 0 &&
                  warm.summary.expectationFailureCount === 0 &&
                  warm.summary.latencyMs.p95 < target,
          });
          if (warmSkipped)
            report.findings.push({
              size,
              operation: name,
              reason:
                "quality preparation exhausted its finite resume budget; steady-state samples were not taken",
              preparationIncomplete: true,
              pendingCount: qualityPreparation.pendingCount,
            });
          if (
            name === "quality" &&
            qualityPreparation.completed &&
            (qualityPreparation.knownCostUsd !== expectedCost.totalCostUsd ||
              qualityPreparation.unknownCostRunCount !==
                expectedCost.unknownCostRunCount)
          )
            report.findings.push({
              size,
              operation: name,
              reason:
                "quality backfill live cost differs from the first observed route live cost",
              expectationFailure: true,
            });
          if (
            cold.summary.errorCount ||
            cold.summary.blockedRows ||
            cold.summary.expectationFailureCount
          )
            report.findings.push({
              size,
              operation: name,
              phase: "cold",
              reason: "cold response failed HTTP/row/cardinality correctness",
              errorCount: cold.summary.errorCount,
              blockedRows: cold.summary.blockedRows,
              expectationFailureCount: cold.summary.expectationFailureCount,
            });
          if (warm.summary.errorCount || warm.summary.blockedRows)
            report.findings.push({
              size,
              operation: name,
              reason: "HTTP errors or blocked rows observed",
              errorCount: warm.summary.errorCount,
              blockedRows: warm.summary.blockedRows,
            });
          if (warm.summary.expectationFailureCount)
            report.findings.push({
              size,
              operation: name,
              reason:
                "synthetic response cardinality expectation failed; latency is not successful work",
              failures: [
                ...new Set(
                  warm.samples.flatMap(
                    (sample) => sample.expectationFailures ?? [],
                  ),
                ),
              ],
            });
          if (target !== null && warm.summary.latencyMs.p95 >= target)
            report.findings.push({
              size,
              operation: name,
              reason: "warm p95 target unmet",
              p95Ms: warm.summary.latencyMs.p95,
              targetMs: target,
            });
        } finally {
          await database.close();
        }
      }
    }
    await writeFile(plan.output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return report;
  } finally {
    await probe.end();
    await admin.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const plan = planBenchmark(process.argv.slice(2));
    if (plan.mode === "dry-run")
      console.info(
        JSON.stringify({ ...plan, seeded: false, networkProbes: 0 }),
      );
    else {
      const report = await runBenchmark(plan);
      console.info(
        JSON.stringify({
          event: "opak_t10_baseline_complete",
          output: plan.output,
          scales: plan.sizes,
          findings: report.findings,
        }),
      );
      if (
        report.findings.some(
          (finding) =>
            finding.errorCount ||
            finding.blockedRows ||
            finding.expectationFailureCount ||
            finding.expectationFailure ||
            finding.preparationIncomplete ||
            finding.failures?.length,
        )
      )
        process.exitCode = 1;
    }
  } catch (error) {
    // Driver errors can contain SQL parameters/credentials: never echo them.
    console.error(
      JSON.stringify({
        event: "opak_t10_baseline_failed",
        stage: error?.benchmarkStage ?? "configuration_or_measurement",
        errorType: ["Error", "ZodError", "TypeError", "PostgresError"].includes(
          error?.name,
        )
          ? error.name
          : "Error",
        invalidFields:
          error?.name === "ZodError"
            ? error.issues.map((issue) => issue.path.join("."))
            : undefined,
        reason:
          error instanceof Error && error.message.startsWith(REFUSE)
            ? error.message
            : "Benchmark failed; no raw database/provider error is printed.",
      }),
    );
    process.exitCode = 1;
  }
}
