import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  ActivationError,
  activationPlan,
  assertLiveTarget,
  assertPreflightTarget,
  parseActivationArgs,
  preflightReport,
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

test("parses the read-only preflight mode and refuses conflicting modes", () => {
  const args = parseActivationArgs([
    "--workspace-id",
    "ws_opf",
    "--owner-email",
    "owner@example.com",
    "--preflight",
  ]);
  assert.equal(args.preflight, true);
  assert.equal(args.confirm, false);
  for (const argv of [
    [
      "--workspace-id",
      "ws_opf",
      "--owner-email",
      "owner@example.com",
      "--preflight",
      "--confirm",
    ],
    [
      "--workspace-id",
      "ws_opf",
      "--owner-email",
      "owner@example.com",
      "--preflight",
      "--disable",
    ],
  ])
    assert.throws(
      () => parseActivationArgs(argv),
      (error) => error.code === "conflicting_mode",
    );
});

test("preflight target guards match the live target guards minus confirm", () => {
  const local = "postgres://user:secret@127.0.0.1:54329/wukong";
  const remote = "postgres://user:secret@db.example.com/wukong";
  assert.deepEqual(assertPreflightTarget(local, { allowRemote: false }), {
    host: "127.0.0.1",
    database: "wukong",
    local: true,
  });
  assert.throws(
    () => assertPreflightTarget(remote, { allowRemote: false }),
    (error) => error.code === "remote_requires_allow_remote",
  );
  assert.throws(
    () => assertPreflightTarget("", { allowRemote: true }),
    (error) => error.code === "missing_database_url",
  );
});

test("preflight report never claims readiness a check did not prove", () => {
  const target = { host: "db.example.com", database: "wukong" };
  const emptyTables = new Set();
  const blocked = preflightReport({
    target,
    workspaceId: "ws_opf",
    tables: emptyTables,
    columns: new Map(),
    functions: new Set(),
    userExists: false,
    workspaceExists: false,
    membershipRole: null,
    studioSettings: null,
  });
  assert.equal(blocked.event, "studio_activation_preflight");
  assert.equal(blocked.outcome, "blocked");
  assert.equal(blocked.readyToActivate, false);
  assert.ok(blocked.checks.schema.missingTables.includes("studio_threads"));
  assert.ok(
    blocked.checks.schema.missingFunctions.includes(
      "studio_resolve_api_token_limits",
    ),
  );
  assert.equal(blocked.checks.userExists, false);

  const readyTables = new Set([
    "users",
    "workspaces",
    "memberships",
    "audit_events",
    "studio_workspace_settings",
    "studio_threads",
    "studio_messages",
    "studio_runs",
    "studio_run_events",
    "studio_outputs",
    "studio_output_versions",
    "studio_budget_reservations",
    "studio_mcp_connections",
    "studio_mcp_calls",
    "studio_api_tokens",
  ]);
  const readyColumns = new Map([
    [
      "studio_workspace_settings",
      new Set(["workspace_id", "enabled", "updated_by", "updated_at"]),
    ],
    [
      "studio_api_tokens",
      new Set([
        "token_hash",
        "revoked_at",
        "rate_limit_per_minute",
        "monthly_call_quota",
      ]),
    ],
    ["studio_mcp_calls", new Set(["token_id"])],
  ]);
  const ready = preflightReport({
    target,
    workspaceId: "ws_opf",
    tables: readyTables,
    columns: readyColumns,
    functions: new Set([
      "studio_resolve_api_token",
      "studio_resolve_api_token_limits",
    ]),
    userExists: true,
    workspaceExists: true,
    membershipRole: "owner",
    studioSettings: { exists: true, enabled: false },
  });
  assert.equal(ready.outcome, "ready");
  assert.equal(ready.readyToActivate, true);
  assert.deepEqual(ready.checks.schema.missingTables, []);
  assert.deepEqual(ready.checks.schema.missingColumns, []);
  assert.deepEqual(ready.checks.studioSettings, {
    exists: true,
    enabled: false,
  });
});

test("preflight without DATABASE_ADMIN_URL exits 2 with a sanitised error", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/studio-activation.mjs",
      "--workspace-id",
      "ws_local",
      "--owner-email",
      "owner@example.com",
      "--preflight",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_ADMIN_URL: "" },
    },
  );
  assert.equal(result.status, 2, result.stderr);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.event, "studio_activation");
  assert.equal(error.outcome, "error");
  assert.equal(error.code, "missing_database_url");
  assert.equal(result.stderr.includes("secret"), false);
});

test("preflight refuses a remote database without --allow-remote", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/studio-activation.mjs",
      "--workspace-id",
      "ws_local",
      "--owner-email",
      "owner@example.com",
      "--preflight",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: "postgres://user:secret@db.example.com/wukong",
      },
    },
  );
  assert.equal(result.status, 2, result.stderr);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.code, "remote_requires_allow_remote");
  assert.equal(result.stderr.includes("secret"), false);
});
