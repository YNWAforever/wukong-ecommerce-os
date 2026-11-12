#!/usr/bin/env node
/**
 * Studio activation CLI (A2 production activation helper).
 *
 * Enables or disables Conversation Studio for an existing workspace whose
 * owner/member already exists. It deliberately does **not** create users or
 * workspaces: production identities are an operator decision and inventing them
 * would be a security surprise. Migrations are run separately with the normal
 * `@wukong/db db:migrate` command, so this tool only flips the reviewed
 * `studio_workspace_settings` row.
 *
 * Usage:
 *   node scripts/studio-activation.mjs --workspace-id ws_opf --owner-email owner@example.com       # dry run
 *   node scripts/studio-activation.mjs --workspace-id ws_opf --owner-email owner@example.com --preflight --allow-remote
 *   node scripts/studio-activation.mjs --workspace-id ws_opf --owner-email owner@example.com --confirm
 *   node scripts/studio-activation.mjs --workspace-id ws_opf --owner-email owner@example.com --disable --confirm
 *
 * `--preflight` is read-only: it connects to `DATABASE_ADMIN_URL`, proves the
 * schema objects the Studio needs are present, and reports whether the target
 * user/workspace/membership/settings state is ready. It never writes, so it
 * needs `--allow-remote` for a remote target but not `--confirm`.
 *
 * `DATABASE_ADMIN_URL` is read from the environment only, so the credential
 * never appears in argv or shell history. A live run also requires
 * `--allow-remote` unless the database host is localhost; both flags are
 * required on purpose because this mutates production settings.
 *
 * Output is single-line JSON with ids/enabled only: never the URL or password.
 */

import { createRequire } from "node:module";

/** Resolve through apps/web, which owns the `postgres` dependency. */
const requireFromWeb = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);

export const ACTIVATION_USAGE =
  "node scripts/studio-activation.mjs --workspace-id <id> --owner-email <email> [--preflight] [--disable] [--confirm] [--allow-remote]";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Read-only readiness checks for a future activation. Each name is a schema
 * object an earlier release would lack, so a missing one means migrations are
 * behind even when replay-safe SQL would report no failure.
 */
const REQUIRED_TABLES = [
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
];
const REQUIRED_COLUMNS = {
  studio_workspace_settings: [
    "workspace_id",
    "enabled",
    "updated_by",
    "updated_at",
  ],
  studio_api_tokens: [
    "token_hash",
    "revoked_at",
    "rate_limit_per_minute",
    "monthly_call_quota",
  ],
  studio_mcp_calls: ["token_id"],
};
const REQUIRED_FUNCTIONS = [
  "studio_resolve_api_token",
  "studio_resolve_api_token_limits",
];
/**
 * Role posture is part of readiness: the web process must connect as the
 * non-superuser, RLS-respecting runtime role, and the two SECURITY DEFINER
 * lookup roles must never be login/superuser/BYPASSRLS/INHERIT. A production
 * dry run that skipped this could "succeed" while every request reads foreign
 * rows or fails closed.
 */
const RUNTIME_ROLE = "wukong_app";
const LOOKUP_ROLES = ["wukong_image_lookup", "wukong_mcp_token_lookup"];

export class ActivationError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = "ActivationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Parse argv (without node/script) into a validated activation request. */
export function parseActivationArgs(argv) {
  const args = {
    workspaceId: null,
    ownerEmail: null,
    confirm: false,
    allowRemote: false,
    disable: false,
    preflight: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value === "--confirm") {
      args.confirm = true;
    } else if (value === "--allow-remote") {
      args.allowRemote = true;
    } else if (value === "--disable") {
      args.disable = true;
    } else if (value === "--preflight") {
      args.preflight = true;
    } else if (value === "--workspace-id" || value === "--owner-email") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new ActivationError(
          "missing_value",
          `${value} requires a value.`,
        );
      index += 1;
      if (value === "--workspace-id") args.workspaceId = next.trim();
      else args.ownerEmail = next.trim().toLowerCase();
    } else {
      throw new ActivationError(
        "unknown_argument",
        `Unknown argument: ${value}`,
      );
    }
  }
  if (args.help) return args;
  if (!args.workspaceId || !WORKSPACE_ID_PATTERN.test(args.workspaceId))
    throw new ActivationError(
      "invalid_workspace",
      "--workspace-id must be 1..200 characters of letters, digits, '_' or '-'.",
    );
  if (!args.ownerEmail || !EMAIL_PATTERN.test(args.ownerEmail))
    throw new ActivationError(
      "invalid_email",
      "--owner-email must be a valid email address.",
    );
  if (args.preflight && args.confirm)
    throw new ActivationError(
      "conflicting_mode",
      "--preflight is read-only and cannot be combined with --confirm.",
    );
  if (args.preflight && args.disable)
    throw new ActivationError(
      "conflicting_mode",
      "--preflight checks activation readiness; it cannot be combined with --disable.",
    );
  return args;
}

/**
 * Refuse to point a live activation at anything that does not look like an
 * explicitly confirmed target. Returns a sanitised target description.
 */
export function assertLiveTarget(databaseUrl, { confirm, allowRemote }) {
  if (!databaseUrl)
    throw new ActivationError(
      "missing_database_url",
      "DATABASE_ADMIN_URL is required for a live activation.",
    );
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new ActivationError(
      "invalid_database_url",
      "DATABASE_ADMIN_URL is not a valid URL.",
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol))
    throw new ActivationError(
      "invalid_database_url",
      "DATABASE_ADMIN_URL must be a postgres URL.",
    );
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!local && !allowRemote)
    throw new ActivationError(
      "remote_requires_allow_remote",
      "Refusing a remote database without --allow-remote.",
    );
  if (!confirm)
    throw new ActivationError(
      "confirm_required",
      "Live activation requires --confirm (dry run until then).",
    );
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database)
    throw new ActivationError(
      "invalid_database_url",
      "DATABASE_ADMIN_URL must name a database.",
    );
  return { host: parsed.hostname, database, local };
}

/**
 * A preflight only reads. It still refuses an unconfirmed remote target so a
 * production check is always explicit, but it never asks for `--confirm`
 * because there is no mutation to confirm.
 */
export function assertPreflightTarget(databaseUrl, { allowRemote }) {
  if (!databaseUrl)
    throw new ActivationError(
      "missing_database_url",
      "DATABASE_ADMIN_URL is required for a preflight check.",
    );
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new ActivationError(
      "invalid_database_url",
      "DATABASE_ADMIN_URL is not a valid URL.",
    );
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol))
    throw new ActivationError(
      "invalid_database_url",
      "DATABASE_ADMIN_URL must be a postgres URL.",
    );
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (!local && !allowRemote)
    throw new ActivationError(
      "remote_requires_allow_remote",
      "Refusing a remote database without --allow-remote.",
    );
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database)
    throw new ActivationError(
      "invalid_database_url",
      "DATABASE_ADMIN_URL must name a database.",
    );
  return { host: parsed.hostname, database, local };
}

/**
 * The preflight report's shape, kept pure so tests can pin the honesty rule:
 * a check is only `true` when the query proved it; everything else is listed.
 */
export function preflightReport({
  target,
  workspaceId,
  tables,
  columns,
  functions,
  roles,
  userExists,
  workspaceExists,
  membershipRole,
  studioSettings,
  lastActivation = null,
}) {
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(
    ([table, required]) =>
      missingTables.includes(table)
        ? []
        : required
            .filter((column) => !(columns.get(table) ?? new Set()).has(column))
            .map((column) => `${table}.${column}`),
  );
  const missingFunctions = REQUIRED_FUNCTIONS.filter(
    (name) => !functions.has(name),
  );
  const runtime = roles.get(RUNTIME_ROLE) ?? null;
  const runtimeSafe =
    runtime !== null &&
    runtime.superuser === false &&
    runtime.bypassRls === false;
  const unsafeLookupRoles = [];
  const missingLookupRoles = [];
  for (const name of LOOKUP_ROLES) {
    const role = roles.get(name);
    if (role === undefined) {
      // A stale database that predates migration 0055 is `blocked` for schema
      // reasons; naming the role missing here keeps the operator from chasing a
      // role that simply was never created yet.
      missingLookupRoles.push(name);
    } else if (
      role.superuser !== false ||
      role.bypassRls !== false ||
      role.canLogin !== false ||
      role.inherit !== false
    ) {
      unsafeLookupRoles.push(name);
    }
  }
  const rolesSafe =
    runtimeSafe &&
    missingLookupRoles.length === 0 &&
    unsafeLookupRoles.length === 0;
  const schemaReady =
    missingTables.length === 0 &&
    missingColumns.length === 0 &&
    missingFunctions.length === 0 &&
    rolesSafe;
  const readyToActivate =
    schemaReady &&
    userExists &&
    workspaceExists &&
    membershipRole !== null &&
    studioSettings !== null;
  return {
    event: "studio_activation_preflight",
    outcome: readyToActivate ? "ready" : "blocked",
    host: target.host,
    database: target.database,
    workspaceId,
    checks: {
      schema: {
        ok: schemaReady,
        missingTables,
        missingColumns,
        missingFunctions,
      },
      roles: {
        ok: rolesSafe,
        runtimeRole: {
          present: runtime !== null,
          safe: runtimeSafe,
          superuser: runtime?.superuser ?? null,
          bypassRls: runtime?.bypassRls ?? null,
        },
        missingLookupRoles,
        unsafeLookupRoles,
      },
      userExists,
      workspaceExists,
      membershipRole,
      studioSettings,
      lastActivation,
    },
    readyToActivate,
  };
}

/** Content-free summary of the last Studio activation audit row. */
export function summarizeLastActivation(row) {
  if (!row) return null;
  const metadata =
    row.metadata && typeof row.metadata === "object" ? row.metadata : null;
  const after =
    metadata?.after && typeof metadata.after === "object"
      ? metadata.after
      : null;
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : typeof row.created_at === "string"
        ? row.created_at
        : null;
  return {
    at: createdAt,
    enabled: typeof after?.enabled === "boolean" ? after.enabled : null,
    source: typeof metadata?.source === "string" ? metadata.source : null,
  };
}

async function runPreflight(args, databaseUrl, target) {
  const postgresModule = requireFromWeb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const tableRows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
    const tables = new Set(tableRows.map((row) => row.table_name));
    const columnRows = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `;
    const columns = new Map();
    for (const row of columnRows) {
      if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
      columns.get(row.table_name).add(row.column_name);
    }
    const functionRows = await sql`
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
    `;
    const functions = new Set(functionRows.map((row) => row.proname));
    const roleRows = await sql`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
      FROM pg_roles
    `;
    const roles = new Map(
      roleRows.map((row) => [
        row.rolname,
        {
          superuser: row.rolsuper === true,
          bypassRls: row.rolbypassrls === true,
          canLogin: row.rolcanlogin === true,
          inherit: row.rolinherit === true,
        },
      ]),
    );

    let userExists = false;
    let workspaceExists = false;
    let membershipRole = null;
    let studioSettings = null;
    // Never query a table the check above just proved missing.
    if (tables.has("users")) {
      const users = await sql`
        SELECT id FROM users WHERE lower(email) = ${args.ownerEmail} LIMIT 1
      `;
      userExists = users.length === 1;
    }
    if (tables.has("workspaces")) {
      const workspaces = await sql`
        SELECT id FROM workspaces WHERE id = ${args.workspaceId} LIMIT 1
      `;
      workspaceExists = workspaces.length === 1;
    }
    if (userExists && workspaceExists && tables.has("memberships")) {
      const memberships = await sql`
        SELECT role FROM memberships
        WHERE workspace_id = ${args.workspaceId}
          AND user_id = (SELECT id FROM users WHERE lower(email) = ${args.ownerEmail} LIMIT 1)
        LIMIT 1
      `;
      membershipRole = memberships[0]?.role ?? null;
    }
    if (
      workspaceExists &&
      tables.has("studio_workspace_settings") &&
      columns.get("studio_workspace_settings")?.has("enabled")
    ) {
      const settings = await sql`
        SELECT enabled, updated_at FROM studio_workspace_settings
        WHERE workspace_id = ${args.workspaceId} LIMIT 1
      `;
      studioSettings = settings[0]
        ? { exists: true, enabled: settings[0].enabled === true }
        : { exists: false, enabled: false };
    }
    let lastActivation = null;
    const auditColumns = columns.get("audit_events");
    // The activation CLI and the admin settings API both write this action, so
    // the report shows the operator the posture the window starts from.
    if (
      workspaceExists &&
      tables.has("audit_events") &&
      auditColumns?.has("metadata") &&
      auditColumns.has("created_at")
    ) {
      const audits = await sql`
        SELECT metadata, created_at FROM audit_events
        WHERE workspace_id = ${args.workspaceId}
          AND action = 'studio.settings.updated'
        ORDER BY created_at DESC LIMIT 1
      `;
      lastActivation = summarizeLastActivation(audits[0]);
    }
    return preflightReport({
      target,
      workspaceId: args.workspaceId,
      tables,
      columns,
      functions,
      roles,
      userExists,
      workspaceExists,
      membershipRole,
      studioSettings,
      lastActivation,
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The deterministic plan printed by a dry run (also used by tests). */
export function activationPlan(args) {
  return {
    event: "studio_activation_plan",
    workspaceId: args.workspaceId,
    ownerEmail: args.ownerEmail,
    action: args.disable ? "disable" : "enable",
    steps: [
      "verify the user exists (users.email)",
      "verify the workspace exists (workspaces.id)",
      "verify the user is a member of the workspace (memberships)",
      args.disable
        ? "update studio_workspace_settings.enabled = false"
        : "upsert studio_workspace_settings.enabled = true, updated_by = user",
      "read back studio_workspace_settings.enabled",
      "record a content-free studio.settings.updated audit event",
    ],
    notes: [
      "run `pnpm --filter @wukong/db db:migrate` against the same database first",
      "run with --preflight first for a read-only schema/identity readiness report",
      "this tool never creates users, workspaces or memberships",
      "feature flags are deployment environment variables, not workspace settings",
    ],
  };
}

/**
 * Content-free audit metadata for the guarded activation write.
 *
 * The admin API is unavailable until Studio is enabled, so this bootstrap path
 * writes the same `studio.settings.updated` action as the admin settings API,
 * with a distinguishable `source` and only the before/after `enabled` value.
 */
export function activationAuditMetadata({ enabled, previousEnabled }) {
  return {
    source: "studio-activation-cli",
    before: { enabled: previousEnabled },
    after: { enabled },
  };
}

async function runLive(args, databaseUrl) {
  const postgresModule = requireFromWeb("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [user] = await sql`
      SELECT id FROM users WHERE lower(email) = ${args.ownerEmail} LIMIT 1
    `;
    if (!user)
      throw new ActivationError(
        "user_not_found",
        "No user with that email exists. Invite/sign up the owner first.",
      );
    const [workspace] = await sql`
      SELECT id FROM workspaces WHERE id = ${args.workspaceId} LIMIT 1
    `;
    if (!workspace)
      throw new ActivationError(
        "workspace_not_found",
        "No workspace with that id exists.",
      );
    const [membership] = await sql`
      SELECT role FROM memberships
      WHERE workspace_id = ${args.workspaceId} AND user_id = ${user.id} LIMIT 1
    `;
    if (!membership)
      throw new ActivationError(
        "membership_not_found",
        "That user is not a member of the workspace.",
      );
    const enabled = !args.disable;
    await sql.begin(async (transaction) => {
      const [before] = await transaction`
        SELECT enabled FROM studio_workspace_settings
        WHERE workspace_id = ${args.workspaceId} LIMIT 1
      `;
      await transaction`
        INSERT INTO studio_workspace_settings (workspace_id, enabled, updated_by)
        VALUES (${args.workspaceId}, ${enabled}, ${user.id})
        ON CONFLICT (workspace_id) DO UPDATE SET
          enabled = excluded.enabled,
          updated_by = excluded.updated_by,
          updated_at = now()
      `;
      const [settings] = await transaction`
        SELECT enabled FROM studio_workspace_settings
        WHERE workspace_id = ${args.workspaceId}
      `;
      if (settings?.enabled !== enabled)
        throw new ActivationError(
          "readback_mismatch",
          "The settings readback did not match the requested state.",
          1,
        );
      await transaction`
        INSERT INTO audit_events (workspace_id, actor_id, entity_id, action, metadata)
        VALUES (
          ${args.workspaceId},
          ${user.id},
          ${args.workspaceId},
          ${"studio.settings.updated"},
          ${transaction.json(
            activationAuditMetadata({
              enabled,
              previousEnabled: before?.enabled ?? null,
            }),
          )}
        )
      `;
    });
    return {
      event: "studio_activation",
      outcome: "ok",
      workspaceId: args.workspaceId,
      userId: user.id,
      role: membership.role,
      enabled,
      audited: true,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function emitActivationError(error) {
  const activationError =
    error instanceof ActivationError
      ? error
      : new ActivationError(
          "activation_failed",
          "Activation failed; see server logs for the error name.",
          1,
        );
  if (!(error instanceof ActivationError))
    console.error(
      JSON.stringify({
        event: "studio_activation",
        outcome: "error",
        code: activationError.code,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  else
    console.error(
      JSON.stringify({
        event: "studio_activation",
        outcome: "error",
        code: activationError.code,
        message: activationError.message,
      }),
    );
  return activationError.exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseActivationArgs(argv);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "studio_activation",
        outcome: "error",
        code: error.code ?? "invalid_arguments",
        message: error.message,
      }),
    );
    return error.exitCode ?? 2;
  }
  if (args.help) {
    console.log(ACTIVATION_USAGE);
    return 0;
  }
  if (args.preflight) {
    try {
      const target = assertPreflightTarget(
        process.env.DATABASE_ADMIN_URL,
        args,
      );
      const report = await runPreflight(
        args,
        process.env.DATABASE_ADMIN_URL,
        target,
      );
      console.log(JSON.stringify(report));
      return report.readyToActivate ? 0 : 2;
    } catch (error) {
      return emitActivationError(error);
    }
  }
  if (!args.confirm) {
    console.log(JSON.stringify(activationPlan(args)));
    return 0;
  }
  try {
    const target = assertLiveTarget(process.env.DATABASE_ADMIN_URL, args);
    const result = await runLive(args, process.env.DATABASE_ADMIN_URL);
    console.log(
      JSON.stringify({
        ...result,
        host: target.host,
        database: target.database,
      }),
    );
    return 0;
  } catch (error) {
    return emitActivationError(error);
  }
}

if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
)
  process.exitCode = await main();
