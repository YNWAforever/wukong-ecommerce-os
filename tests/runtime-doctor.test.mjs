import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveStatuses,
  formatReport,
  checkQueues,
  checkHyperdrive,
  expectedQueueNames,
  checkHealthGet,
  checkHealthSigned,
  signHealthProbe,
} from "../scripts/runtime-doctor.mjs";

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

test("checkQueues names every missing queue", () => {
  const check = checkQueues(
    ["wukong-listing-production", "wukong-listing-dlq-production"],
    JSON.stringify([
      { queue_name: "wukong-listing-production" },
      { queue_name: "unrelated" },
    ]),
    "production",
  );

  assert.equal(check.status, "failed");
  assert.match(check.detail, /wukong-listing-dlq-production/);
  assert.match(check.fix, /runtime:provision production/);
});

test("checkQueues passes when every expected queue exists", () => {
  const check = checkQueues(
    ["a", "b"],
    JSON.stringify([
      { queue_name: "a" },
      { queue_name: "b" },
      { queue_name: "c" },
    ]),
    "production",
  );

  assert.equal(check.status, "ok");
});

test("checkQueues reports unparsable output as unknown, not failed", () => {
  const check = checkQueues(["a"], "not json", "production");

  assert.equal(check.status, "unknown");
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

// Pins the duplicated HMAC against packages/jobs/src/cloudflare-queue.ts. If
// signQueueRequest's message format ever changes, this vector fails and the
// doctor stops silently signing requests the Worker will reject.
test("signHealthProbe matches the queue signing algorithm", () => {
  const signature = signHealthProbe({
    secret: "q".repeat(32),
    timestamp: 1_784_556_000,
    path: "/health",
    body: "{}",
  });

  assert.equal(signature, "6UdPcVDj1a7-vHLBVMYWhcENn3OQzYFUdJVk2GhFpkE");
});
