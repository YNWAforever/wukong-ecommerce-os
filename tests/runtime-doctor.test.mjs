import assert from "node:assert/strict";
import { test } from "node:test";

import {
  packageRunners,
  shouldTryNextRunner,
  resolveStatuses,
  formatReport,
  checkQueues,
  checkHyperdrive,
  expectedQueueNames,
  checkHealthGet,
  checkHealthSigned,
  signHealthProbe,
  vercelEnvCheck,
  parseWranglerTable,
} from "../scripts/runtime-doctor.mjs";
import { planQueueCreation } from "../scripts/provision-queues.mjs";

test("marks dependents of a failed check as blocked, not failed", () => {
  const resolved = resolveStatuses([
    {
      id: "queues",
      status: "failed",
      detail: "missing wukong-listing-production",
      fix: "pnpm runtime:provision production",
    },
    { id: "health-get", dependsOn: "queues" },
    { id: "health-signed", dependsOn: "health-get" },
  ]);

  assert.deepEqual(
    resolved.map((check) => [check.id, check.status]),
    [
      ["queues", "failed"],
      ["health-get", "blocked"],
      ["health-signed", "blocked"],
    ],
  );
});

test("blocked checks name what blocked them", () => {
  const [, blocked] = resolveStatuses([
    { id: "queues", status: "failed", detail: "missing", fix: "x" },
    { id: "health-get", dependsOn: "queues" },
  ]);

  assert.equal(blocked.detail, "blocked by queues");
});

test("an unknown check blocks dependents but is not a failure", () => {
  const resolved = resolveStatuses([
    {
      id: "wrangler-auth",
      status: "unknown",
      detail: "wrangler is not logged in",
      fix: "wrangler login",
    },
    { id: "queues", dependsOn: "wrangler-auth" },
  ]);

  assert.equal(resolved[0].status, "unknown");
  assert.equal(resolved[1].status, "blocked");
});

test("an unresolvable dependsOn is unknown, never silently ok", () => {
  const resolved = resolveStatuses([
    { id: "health-get", status: "ok", detail: "fine", dependsOn: "typo-id" },
  ]);

  assert.equal(resolved[0].status, "unknown");
  assert.match(resolved[0].detail, /typo-id/);
});

test("a dependsOn declared later in the array does not silently pass", () => {
  const resolved = resolveStatuses([
    { id: "health-get", status: "ok", detail: "fine", dependsOn: "queues" },
    { id: "queues", status: "failed", detail: "missing", fix: "x" },
  ]);

  assert.notEqual(resolved[0].status, "ok");
});

test("passing checks leave dependents to run", () => {
  const resolved = resolveStatuses([
    { id: "queues", status: "ok", detail: "4 queues present" },
    {
      id: "health-get",
      status: "ok",
      detail: "bindings resolved",
      dependsOn: "queues",
    },
  ]);

  assert.deepEqual(
    resolved.map((check) => check.status),
    ["ok", "ok"],
  );
});

test("the report prints a fix for every red check and never a secret value", () => {
  const report = formatReport([
    {
      id: "queues",
      status: "failed",
      detail: "missing wukong-listing-production",
      fix: "pnpm runtime:provision production",
    },
    { id: "worker-secrets", status: "ok", detail: "5 secrets set" },
  ]);

  assert.match(report, /FAIL {2}queues/);
  assert.match(report, /pnpm runtime:provision production/);
  assert.match(report, /OK {4}worker-secrets/);
});

test("expectedQueueNames reads the four queues from runtime config", () => {
  const names = expectedQueueNames(
    {
      environments: {
        production: {
          listingQueue: "wukong-listing-production",
          listingDlq: "wukong-listing-dlq-production",
          shoplineQueue: "wukong-shopline-production",
          shoplineDlq: "wukong-shopline-dlq-production",
        },
      },
    },
    "production",
  );

  assert.deepEqual(names, [
    "wukong-listing-production",
    "wukong-listing-dlq-production",
    "wukong-shopline-production",
    "wukong-shopline-dlq-production",
  ]);
});

test("checkQueues passes when every expected queue is in the table", () => {
  const check = checkQueues(
    ["wukong-listing-production", "wukong-listing-dlq-production"],
    QUEUES_TABLE,
    "production",
  );

  assert.equal(check.status, "ok");
});

test("checkQueues names a queue that is genuinely absent", () => {
  const check = checkQueues(
    ["wukong-listing-production", "wukong-shopline-production"],
    QUEUES_TABLE,
    "production",
  );

  assert.equal(check.status, "failed");
  assert.match(check.detail, /wukong-shopline-production/);
  assert.match(check.fix, /runtime:provision production/);
});

// An empty but well-formed table means the queues really are missing. Reporting
// that as `unknown` would make the check useless in the one case it exists for.
test("checkQueues treats a header-only table as genuinely missing", () => {
  const check = checkQueues(
    ["wukong-listing-production"],
    EMPTY_TABLE,
    "production",
  );

  assert.equal(check.status, "failed");
});

test("checkQueues reports unreadable output as unknown, not failed", () => {
  const check = checkQueues(["a"], "✘ [ERROR] Unknown argument", "production");

  assert.equal(check.status, "unknown");
  assert.match(check.detail, /could not read/i);
});

test("checkQueues reports a table without a name column as a format change", () => {
  const noName = [
    "┌──────────────────────────────────┐",
    "│ id                               │",
    "│ 00000000000000000000000000000001 │",
    "└──────────────────────────────────┘",
  ].join("\n");

  const check = checkQueues(["a"], noName, "production");

  assert.equal(check.status, "unknown");
  assert.match(check.detail, /format/i);
});

test("checkHyperdrive matches the configured id", () => {
  const listed = JSON.stringify([{ id: "abc123", name: "wukong" }]);

  assert.equal(checkHyperdrive(listed, "abc123").status, "ok");
  assert.equal(checkHyperdrive(listed, "def456").status, "failed");
  assert.equal(checkHyperdrive(listed, "").status, "failed");
  assert.equal(checkHyperdrive("not json", "abc123").status, "unknown");
});

test("checkHealthGet fails when a binding is unresolved", () => {
  const check = checkHealthGet({
    buildSha: "abc",
    adapterMode: "disabled",
    bindings: {
      hyperdrive: true,
      listingQueue: true,
      shoplineQueue: false,
      ingressSecret: true,
    },
  });

  assert.equal(check.status, "failed");
  assert.match(check.detail, /shoplineQueue/);
});

test("checkHealthGet passes when every binding resolves", () => {
  const check = checkHealthGet({
    buildSha: "abc",
    adapterMode: "disabled",
    bindings: {
      hyperdrive: true,
      listingQueue: true,
      shoplineQueue: true,
      ingressSecret: true,
    },
  });

  assert.equal(check.status, "ok");
});

test("checkHealthSigned treats 401 as a secret mismatch, the failure this tool exists for", () => {
  const check = checkHealthSigned({ status: 401 });

  assert.equal(check.status, "failed");
  assert.match(check.detail, /does not match/i);
  assert.match(check.fix, /QUEUE_INGRESS_SECRET/);
});

test("checkHealthSigned fails when the database is unreachable", () => {
  const check = checkHealthSigned({
    status: 200,
    body: { authenticated: true, checks: { hyperdriveConnects: false } },
  });

  assert.equal(check.status, "failed");
  assert.match(check.detail, /database/i);
});

test("checkHealthSigned passes when the secret agrees and the database answers", () => {
  const check = checkHealthSigned({
    status: 200,
    body: { authenticated: true, checks: { hyperdriveConnects: true } },
  });

  assert.equal(check.status, "ok");
});

test("checkHealthSigned reports an unreachable worker as unknown", () => {
  assert.equal(checkHealthSigned({ error: "ECONNREFUSED" }).status, "unknown");
});

// One half of a two-sided pin. packages/jobs/src/cloudflare-queue.test.ts
// asserts signQueueRequest produces this same signature, so changing the
// message format on either side turns one of the two tests red. This test
// alone cannot see a change made only in packages/jobs.
test("signHealthProbe matches the queue signing algorithm", () => {
  const signature = signHealthProbe({
    secret: "q".repeat(32),
    timestamp: 1_784_556_000,
    path: "/health",
    body: "{}",
  });

  assert.equal(signature, "6UdPcVDj1a7-vHLBVMYWhcENn3OQzYFUdJVk2GhFpkE");
});

test("vercelEnvCheck names the environment it was run for", () => {
  const check = vercelEnvCheck(undefined, undefined, "preview");

  assert.equal(check.status, "failed");
  assert.match(check.fix, /preview/);
  assert.doesNotMatch(check.fix, /production/);
});

test("planQueueCreation creates only the queues that are absent", () => {
  const plan = planQueueCreation(
    ["a", "b", "c"],
    JSON.stringify([{ queue_name: "b" }]),
  );

  assert.deepEqual(plan.create, ["a", "c"]);
  assert.deepEqual(plan.existing, ["b"]);
});

test("planQueueCreation never plans a deletion", () => {
  const plan = planQueueCreation(
    ["a"],
    JSON.stringify([{ queue_name: "zzz" }]),
  );

  assert.deepEqual(plan.create, ["a"]);
  assert.equal(plan.delete, undefined);
});

test("packageRunners falls back to pnpm when corepack is absent", () => {
  const runners = packageRunners("darwin");

  assert.deepEqual(
    runners.map((runner) => [runner.command, ...runner.lead]),
    [["corepack", "pnpm"], ["pnpm"]],
  );
});

test("packageRunners routes windows shims through the command interpreter", () => {
  // Node refuses to spawn a .cmd directly since the CVE-2024-27980 fix, so
  // naming corepack.cmd/pnpm.cmd as the executable fails with EINVAL.
  const runners = packageRunners("win32", { ComSpec: "C:\\Windows\\cmd.exe" });

  assert.deepEqual(
    runners.map((runner) => runner.command),
    ["C:\\Windows\\cmd.exe", "C:\\Windows\\cmd.exe"],
  );
  assert.deepEqual(runners[0].lead, ["/d", "/s", "/c", "corepack", "pnpm"]);
  assert.deepEqual(runners[1].lead, ["/d", "/s", "/c", "pnpm"]);
});

test("packageRunners falls back to cmd.exe when ComSpec is unset", () => {
  assert.deepEqual(
    packageRunners("win32", {}).map((runner) => runner.command),
    ["cmd.exe", "cmd.exe"],
  );
});

test("shouldTryNextRunner retries an absent runner but not a real error", () => {
  // EINVAL is what a .cmd spawn raises on Windows; without it the loop breaks
  // before ever reaching the pnpm fallback.
  assert.equal(shouldTryNextRunner({ code: "ENOENT" }), true);
  assert.equal(shouldTryNextRunner({ code: "EINVAL" }), true);
  assert.equal(shouldTryNextRunner({ code: "EACCES" }), false);
  assert.equal(shouldTryNextRunner(undefined), false);
});

// Captured from `wrangler queues list` (wrangler 4.112.0) on 2026-08-01, not
// written from documentation. The previous fixtures were inferred, and agreed
// with equally inferred code, which is how two broken checks passed their tests.
// Resource ids are placeholders; the structure is what matters here.
const QUEUES_TABLE = [
  " ⛅️ wrangler 4.112.0 (update available 4.118.0)",
  "───────────────────────────────────────────────",
  "┌──────────────────────────────────┬────────────────────────────────┬───────────┐",
  "│ id                               │ name                           │ producers │",
  "├──────────────────────────────────┼────────────────────────────────┼───────────┤",
  "│ 00000000000000000000000000000001 │ wukong-listing-production      │ 0         │",
  "├──────────────────────────────────┼────────────────────────────────┼───────────┤",
  "│ 00000000000000000000000000000002 │ wukong-listing-dlq-production  │ 0         │",
  "└──────────────────────────────────┴────────────────────────────────┴───────────┘",
].join("\n");

const EMPTY_TABLE = [
  "┌──────────────────────────────────┬────────────────────────────────┐",
  "│ id                               │ name                           │",
  "└──────────────────────────────────┴────────────────────────────────┘",
].join("\n");

test("parseWranglerTable reads rows keyed by the header row", () => {
  const table = parseWranglerTable(QUEUES_TABLE);

  assert.deepEqual(table.columns, ["id", "name", "producers"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].name, "wukong-listing-production");
  assert.equal(table.rows[1].name, "wukong-listing-dlq-production");
  assert.equal(table.rows[0].id, "00000000000000000000000000000001");
});

test("parseWranglerTable returns an empty row list for a header-only table", () => {
  const table = parseWranglerTable(EMPTY_TABLE);

  assert.deepEqual(table.columns, ["id", "name"]);
  assert.deepEqual(table.rows, []);
});

test("parseWranglerTable strips ANSI escapes", () => {
  const coloured = QUEUES_TABLE.replace(
    "wukong-listing-production",
    "[32mwukong-listing-production[0m",
  );

  assert.equal(
    parseWranglerTable(coloured).rows[0].name,
    "wukong-listing-production",
  );
});

test("parseWranglerTable returns null when there is no table", () => {
  assert.equal(parseWranglerTable("✘ [ERROR] Unknown argument: json"), null);
  assert.equal(parseWranglerTable(""), null);
});
