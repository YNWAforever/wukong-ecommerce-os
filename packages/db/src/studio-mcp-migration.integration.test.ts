import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { createDatabase } from "./client.js";
import { loadSqlMigrations } from "./migrations.js";

/**
 * Migration 0055 contract: the hosted-MCP token resolver.
 *
 * The function is the only cross-workspace read of `studio_api_tokens`, and
 * that table is FORCE-RLS scoped, so two things must be proven against a real
 * database: the dedicated owner role can see exactly the one hashed row and
 * `wukong_app` cannot enumerate tokens directly.
 *
 * Destructive resets are opt-in and restricted to the explicitly named local
 * disposable database; any other target is refused before connecting.
 */
const url = process.env.STUDIO_TEST_DATABASE_ADMIN_URL;
const enabled = !!url && process.env.STUDIO_TEST_DISPOSABLE === "yes";

if (enabled) {
  const target = new URL(url!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/wukong_studio_test" ||
    url === process.env.TEST_DATABASE_ADMIN_URL
  )
    throw new Error("Refusing non-isolated studio migration target");
}

const admin = enabled
  ? postgres(url!, { max: 1, onnotice: () => undefined, prepare: false })
  : null;

/** Same disposable database, connected as the non-superuser runtime role. */
const appUrl = enabled
  ? (() => {
      const target = new URL(url!);
      target.username = "wukong_app";
      target.password = "wukong-app-local";
      return target.toString();
    })()
  : null;
const app = enabled
  ? postgres(appUrl!, { max: 1, onnotice: () => undefined, prepare: false })
  : null;
/** The real `Database` handle (as `wukong_app`) for the client-method test. */
const database = enabled ? createDatabase(appUrl!) : null;

const migrations = await loadSqlMigrations(
  new URL("../drizzle/", import.meta.url),
);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_REVOKED = "c".repeat(64);
const HASH_ABSENT = "d".repeat(64);

async function reset(): Promise<void> {
  const [target] = await admin!`select current_database() as name`;
  expect(target!.name).toBe("wukong_studio_test");
  await admin!.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
}

async function applyAll(): Promise<void> {
  for (const migration of migrations)
    await admin!.begin(async (tx) => {
      await tx.unsafe(migration.sql);
    });
}

async function resolutionRoleAttributes() {
  const [role] = await admin!`
    select rolname, rolsuper, rolbypassrls, rolcanlogin
    from pg_roles
    where rolname = 'wukong_mcp_token_lookup'
  `;
  return role as
    | {
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }
    | undefined;
}

afterAll(async () => {
  await database?.close();
  await app?.end();
  await admin?.end();
});

describe.skipIf(!enabled)("studio MCP token resolver migration 0055", () => {
  beforeAll(async () => {
    await reset();
    await applyAll();
    await admin!`
      insert into workspaces(id, name, profile)
      values ('mcp-ws-a', 'MCP A', '{}'), ('mcp-ws-b', 'MCP B', '{}')
    `;
    await admin!`
      insert into studio_api_tokens(
        workspace_id, label, token_hash, prefix, scopes, created_by
      ) values
        ('mcp-ws-a', 'A read token', ${HASH_A}, 'prefix-a', '{read}', 'actor-a'),
        ('mcp-ws-b', 'B propose token', ${HASH_B}, 'prefix-b', '{read,propose}', 'actor-b'),
        ('mcp-ws-a', 'A revoked token', ${HASH_REVOKED}, 'prefix-r', '{read}', 'actor-a')
    `;
    await admin!`
      update studio_api_tokens
      set revoked_at = now()
      where token_hash = ${HASH_REVOKED}
    `;
  });

  it("declares a SECURITY DEFINER resolver owned by a safe role", async () => {
    const [fn] = await admin!`
      select p.prosecdef, p.proisstrict, p.provolatile, pg_get_userbyid(p.proowner) as owner
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'studio_resolve_api_token'
    `;
    expect(fn).toBeDefined();
    expect(fn!.prosecdef).toBe(true);
    expect(fn!.provolatile).toBe("s");
    expect(fn!.owner).toBe("wukong_mcp_token_lookup");

    const role = await resolutionRoleAttributes();
    expect(role).toMatchObject({
      rolname: "wukong_mcp_token_lookup",
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
    });
  });

  it("grants EXECUTE to the runtime role and not to PUBLIC", async () => {
    const [privileges] = await admin!`
      select
        has_function_privilege('wukong_app', 'public.studio_resolve_api_token(text)', 'EXECUTE') as app_can_execute,
        has_function_privilege('wukong_mcp_token_lookup', 'public.studio_resolve_api_token(text)', 'EXECUTE') as owner_can_execute,
        (
          select count(*)::int
          from pg_proc p,
            lateral aclexplode(coalesce(p.proacl, '{}'::aclitem[])) acl
          where p.proname = 'studio_resolve_api_token'
            and acl.grantee = 0
        ) as public_grants
    `;
    expect(privileges!.app_can_execute).toBe(true);
    expect(privileges!.owner_can_execute).toBe(true);
    expect(privileges!.public_grants).toBe(0);
  });

  it("resolves the owning workspace across tenants without exposing others", async () => {
    const rows =
      await app!`select * from public.studio_resolve_api_token(${HASH_A})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: "mcp-ws-a",
      created_by: "actor-a",
      prefix: "prefix-a",
      revoked_at: null,
    });
    expect(rows[0]!.scopes).toEqual(["read"]);
    expect(rows[0]!.token_id).toEqual(expect.any(String));

    const other =
      await app!`select * from public.studio_resolve_api_token(${HASH_B})`;
    expect(other).toHaveLength(1);
    expect(other[0]!.workspace_id).toBe("mcp-ws-b");
    expect(other[0]!.scopes).toEqual(["read", "propose"]);

    // No cross-workspace leak: one hash resolves exactly one owner.
    const all = await app!`
      select workspace_id from public.studio_resolve_api_token(${HASH_B})
      union all
      select workspace_id from public.studio_resolve_api_token(${HASH_A})
    `;
    expect(all.map((row) => row.workspace_id).sort()).toEqual([
      "mcp-ws-a",
      "mcp-ws-b",
    ]);
  });

  it("keeps the token table itself invisible to the runtime role", async () => {
    const [direct] =
      await app!`select count(*)::int as count from studio_api_tokens`;
    expect(direct!.count).toBe(0);

    await expect(
      app!.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', 'mcp-ws-a', true)`;
        const rows = await tx`select workspace_id from studio_api_tokens`;
        expect(rows.map((row) => row.workspace_id)).toEqual([
          "mcp-ws-a",
          "mcp-ws-a",
        ]);
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves revoked tokens so the caller can reject them, and empty for unknown hashes", async () => {
    const revoked =
      await app!`select * from public.studio_resolve_api_token(${HASH_REVOKED})`;
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.workspace_id).toBe("mcp-ws-a");
    expect(revoked[0]!.revoked_at).not.toBeNull();

    const absent =
      await app!`select * from public.studio_resolve_api_token(${HASH_ABSENT})`;
    expect(absent).toHaveLength(0);

    const malformed =
      await app!`select * from public.studio_resolve_api_token('not-a-digest')`;
    expect(malformed).toHaveLength(0);
  });

  it("resolves tokens through the Database client method", async () => {
    const resolved = await database!.lookupStudioApiToken(HASH_B);
    expect(resolved).toMatchObject({
      workspaceId: "mcp-ws-b",
      createdBy: "actor-b",
      prefix: "prefix-b",
      revokedAt: null,
    });
    expect(resolved!.scopes).toEqual(["read", "propose"]);
    expect(resolved!.tokenId).toEqual(expect.any(String));

    const revoked = await database!.lookupStudioApiToken(HASH_REVOKED);
    expect(revoked?.workspaceId).toBe("mcp-ws-a");
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    expect(await database!.lookupStudioApiToken(HASH_ABSENT)).toBeNull();
    expect(await database!.lookupStudioApiToken("not-a-digest")).toBeNull();
  });

  it("replays the migration set without changing the resolver contract", async () => {
    await applyAll();
    const role = await resolutionRoleAttributes();
    expect(role?.rolbypassrls).toBe(false);

    const rows =
      await app!`select * from public.studio_resolve_api_token(${HASH_A})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspace_id).toBe("mcp-ws-a");

    const [privileges] = await admin!`
      select
        has_function_privilege('wukong_app', 'public.studio_resolve_api_token(text)', 'EXECUTE') as app_can_execute,
        (
          select count(*)::int
          from pg_proc p,
            lateral aclexplode(coalesce(p.proacl, '{}'::aclitem[])) acl
          where p.proname = 'studio_resolve_api_token'
            and acl.grantee = 0
        ) as public_grants
    `;
    expect(privileges!.app_can_execute).toBe(true);
    expect(privileges!.public_grants).toBe(0);
  });
});
