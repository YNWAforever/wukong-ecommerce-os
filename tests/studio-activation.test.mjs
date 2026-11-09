import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  ActivationError,
  activationPlan,
  assertLiveTarget,
  parseActivationArgs,
} from "../scripts/studio-activation.mjs";

/**
 * Studio activation CLI: argument validation, dry-run planning and the guards
 * that keep a live production mutation explicit. Live DB writes are covered by
 * the local end-to-end verification in the runbook, not by unit tests.
 */

test("parses a dry-run request and lower-cases the email", () => {
  const args = parseActivationArgs([
    "--workspace-id",
    "ws_opf",
    "--owner-email",
    "Owner@Example.COM",
  ]);
  assert.equal(args.workspaceId, "ws_opf");
  assert.equal(args.ownerEmail, "owner@example.com");
  assert.equal(args.confirm, false);
  assert.equal(args.disable, false);
  assert.equal(activationPlan(args).action, "enable");
  assert.equal(activationPlan({ ...args, disable: true }).action, "disable");
});

test("rejects missing, malformed or unknown arguments", () => {
  for (const argv of [
    [],
    ["--workspace-id", "ws_opf"],
    ["--owner-email", "owner@example.com"],
    ["--workspace-id", "bad id!", "--owner-email", "owner@example.com"],
    ["--workspace-id", "ws_opf", "--owner-email", "not-an-email"],
    [
      "--workspace-id",
      "ws_opf",
      "--owner-email",
      "owner@example.com",
      "--nope",
    ],
    ["--workspace-id"],
  ])
    assert.throws(() => parseActivationArgs(argv), ActivationError);
});

test("refuses a live target without confirm or allow-remote", () => {
  const local = "postgres://user:secret@127.0.0.1:54329/wukong";
  const remote = "postgres://user:secret@db.example.com/wukong";
  assert.throws(
    () => assertLiveTarget(local, { confirm: false, allowRemote: true }),
    (error) => error.code === "confirm_required",
  );
  assert.throws(
    () => assertLiveTarget(remote, { confirm: true, allowRemote: false }),
    (error) => error.code === "remote_requires_allow_remote",
  );
  assert.deepEqual(
    assertLiveTarget(remote, { confirm: true, allowRemote: true }),
    { host: "db.example.com", database: "wukong", local: false },
  );
  assert.throws(
    () => assertLiveTarget("mysql://x/y", { confirm: true, allowRemote: true }),
    (error) => error.code === "invalid_database_url",
  );
});

test("dry run prints the plan JSON without touching a database", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/studio-activation.mjs",
      "--workspace-id",
      "ws_local",
      "--owner-email",
      "owner@example.com",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_ADMIN_URL: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout.trim());
  assert.equal(plan.event, "studio_activation_plan");
  assert.equal(plan.workspaceId, "ws_local");
  assert.equal(plan.action, "enable");
  assert.ok(plan.steps.length >= 4);
  assert.equal(result.stdout.includes("secret"), false);
});
