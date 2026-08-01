import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStatuses, formatReport } from "../scripts/runtime-doctor.mjs";

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
