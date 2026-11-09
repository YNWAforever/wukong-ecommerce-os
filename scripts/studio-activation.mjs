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
 *   node scripts/studio-activation.mjs --workspace-id ws_opf --owner-email owner@example.com --confirm
 *   node scripts/studio-activation.mjs --workspace-id ws_opf --owner-email owner@example.com --disable --confirm
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
  "node scripts/studio-activation.mjs --workspace-id <id> --owner-email <email> [--disable] [--confirm] [--allow-remote]";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

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
    ],
    notes: [
      "run `pnpm --filter @wukong/db db:migrate` against the same database first",
      "this tool never creates users, workspaces or memberships",
      "feature flags are deployment environment variables, not workspace settings",
    ],
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
    await sql`
      INSERT INTO studio_workspace_settings (workspace_id, enabled, updated_by)
      VALUES (${args.workspaceId}, ${enabled}, ${user.id})
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
    const [settings] = await sql`
      SELECT enabled FROM studio_workspace_settings
      WHERE workspace_id = ${args.workspaceId}
    `;
    if (settings?.enabled !== enabled)
      throw new ActivationError(
        "readback_mismatch",
        "The settings readback did not match the requested state.",
        1,
      );
    return {
      event: "studio_activation",
      outcome: "ok",
      workspaceId: args.workspaceId,
      userId: user.id,
      role: membership.role,
      enabled,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
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
}

if (
  process.argv[1] &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
)
  process.exitCode = await main();
