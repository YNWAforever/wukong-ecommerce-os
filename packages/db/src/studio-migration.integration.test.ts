import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { loadSqlMigrations } from "./migrations.js";

/**
 * Migration 0054 contract test.
 *
 * Destructive resets are opt-in and restricted to the explicitly named local
 * disposable database. The suite refuses any other target before connecting.
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

const migrations = await loadSqlMigrations(
  new URL("../drizzle/", import.meta.url),
);

const STUDIO_TABLES = [
  "studio_threads",
  "studio_messages",
  "studio_runs",
  "studio_run_events",
  "studio_outputs",
  "studio_output_versions",
  "studio_budget_reservations",
  "studio_workspace_settings",
  "studio_mcp_connections",
  "studio_mcp_calls",
  "studio_api_tokens",
] as const;

const APPEND_ONLY_TABLES = [
  "studio_messages",
  "studio_run_events",
  "studio_output_versions",
  "studio_mcp_calls",
] as const;

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const OUTPUT_ID = "33333333-3333-4333-8333-333333333333";
const OUTPUT_VERSION_ID = "44444444-4444-4444-8444-444444444444";

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

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe.skipIf(!enabled)("conversation studio migration 0054", () => {
  beforeAll(async () => {
    await reset();
    await applyAll();
  });

  it("declares every studio table with forced RLS and a workspace policy", async () => {
    const tables = await admin!`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name like 'studio\_%' escape '\'
      order by table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual(
      [...STUDIO_TABLES].sort(),
    );

    const rls = await admin!`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relname = any(${[...STUDIO_TABLES]}) and relkind = 'r'
      order by relname
    `;
    expect(rls).toHaveLength(STUDIO_TABLES.length);
    for (const table of rls) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }

    const policies = await admin!`
      select tablename, policyname, cmd, roles
      from pg_policies
      where schemaname = 'public' and tablename = any(${[...STUDIO_TABLES]})
    `;
    // One workspace policy per table. Migration 0055 deliberately adds exactly
    // one extra SELECT policy on studio_api_tokens for the dedicated
    // cross-workspace token-resolver role; nothing else may widen access.
    const workspacePolicies = policies.filter((policy) =>
      policy.policyname.endsWith("_workspace_policy"),
    );
    expect(workspacePolicies).toHaveLength(STUDIO_TABLES.length);
    for (const policy of workspacePolicies) {
      expect(policy.cmd, policy.tablename).toBe("ALL");
      expect(policy.roles, policy.tablename).toContain("wukong_app");
      expect(policy.policyname).toBe(`${policy.tablename}_workspace_policy`);
    }
    const extraPolicies = policies.filter(
      (policy) => !policy.policyname.endsWith("_workspace_policy"),
    );
    expect(extraPolicies).toHaveLength(1);
    expect(extraPolicies[0]).toMatchObject({
      tablename: "studio_api_tokens",
      policyname: "studio_api_tokens_mcp_lookup",
      cmd: "SELECT",
    });
    expect(extraPolicies[0]!.roles).toContain("wukong_mcp_token_lookup");
  });

  it("grants runtime privileges without weakening append-only tables", async () => {
    const grants = await admin!`
      select table_name,
        has_table_privilege('wukong_app', table_name, 'SELECT') as can_select,
        has_table_privilege('wukong_app', table_name, 'INSERT') as can_insert,
        has_table_privilege('wukong_app', table_name, 'UPDATE') as can_update,
        has_table_privilege('wukong_app', table_name, 'DELETE') as can_delete
      from information_schema.tables
      where table_schema = 'public' and table_name = any(${[...STUDIO_TABLES]})
      order by table_name
    `;
    expect(grants).toHaveLength(STUDIO_TABLES.length);
    for (const grant of grants) {
      expect(grant.can_select, grant.table_name).toBe(true);
      expect(grant.can_insert, grant.table_name).toBe(true);
      expect(grant.can_delete, grant.table_name).toBe(false);
      const appendOnly = APPEND_ONLY_TABLES.includes(
        grant.table_name as (typeof APPEND_ONLY_TABLES)[number],
      );
      expect(grant.can_update, grant.table_name).toBe(appendOnly ? false : true);
    }
  });

  it("enforces workspace isolation for the runtime role", async () => {
    await admin!`
      insert into workspaces(id, name, profile)
      values ('studio-ws-a', 'Studio A', '{}'), ('studio-ws-b', 'Studio B', '{}')
    `;
    await admin!`
      insert into studio_threads(id, workspace_id, created_by, title)
      values (${THREAD_ID}, 'studio-ws-b', 'actor-b', 'Other workspace thread')
    `;

    await app!.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', 'studio-ws-a', true)`;
      await tx`
        insert into studio_threads(id, workspace_id, created_by, title)
        values ('55555555-5555-4555-8555-555555555555', 'studio-ws-a', 'actor-a', 'Own thread')
      `;
      const visible = await tx`select id from studio_threads order by id`;
      expect(visible.map((row) => row.id)).toEqual([
        "55555555-5555-4555-8555-555555555555",
      ]);
    });

    // A failed statement aborts its transaction, so the rejection gets its own.
    await expect(
      app!.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', 'studio-ws-a', true)`;
        await tx`
          insert into studio_threads(id, workspace_id, created_by, title)
          values ('66666666-6666-4666-8666-666666666666', 'studio-ws-b', 'actor-a', 'Foreign thread')
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects updates and deletes on append-only rows", async () => {
    const immutableThreadId = "77777777-7777-4777-8777-777777777777";
    await admin!`
      insert into workspaces(id, name, profile)
      values ('studio-ws-c', 'Studio C', '{}')
    `;
    await admin!`
      insert into studio_threads(id, workspace_id, created_by, title)
      values (${immutableThreadId}, 'studio-ws-c', 'actor-c', 'Immutable thread')
    `;
    await admin!`
      insert into studio_messages(id, workspace_id, thread_id, sequence, role, content, created_by)
      values (${MESSAGE_ID}, 'studio-ws-c', ${immutableThreadId}, 1, 'operator', '{"text":"hi"}'::jsonb, 'actor-c')
    `;
    await expect(
      admin!`update studio_messages set content = '{"text":"changed"}'::jsonb where id = ${MESSAGE_ID}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      admin!`delete from studio_messages where id = ${MESSAGE_ID}`,
    ).rejects.toThrow(/immutable/);
  });

  it("enforces payload bounds and digest formats", async () => {
    await admin!`
      insert into studio_outputs(id, workspace_id, kind, title, created_by)
      values (${OUTPUT_ID}, 'studio-ws-c', 'gap_report', 'Bounds report', 'actor-c')
    `;
    await admin!`
      insert into studio_output_versions(
        id, workspace_id, output_id, revision, payload, content_digest, as_of, created_by
      ) values (
        ${OUTPUT_VERSION_ID}, 'studio-ws-c', ${OUTPUT_ID}, 1, '{"ok":true}'::jsonb,
        repeat('a', 64), now(), 'actor-c'
      )
    `;
    await expect(
      admin!`
        insert into studio_output_versions(
          id, workspace_id, output_id, revision, payload, content_digest, as_of, created_by
        ) values (
          gen_random_uuid(), 'studio-ws-c', ${OUTPUT_ID}, 2, '{"ok":true}'::jsonb,
          'not-a-digest', now(), 'actor-c'
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin!`
        insert into studio_output_versions(
          id, workspace_id, output_id, revision, payload, content_digest, as_of, created_by
        ) values (
          gen_random_uuid(), 'studio-ws-c', ${OUTPUT_ID}, 3, ${JSON.stringify({ blob: "a".repeat(300_000) })}::jsonb,
          repeat('b', 64), now(), 'actor-c'
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("replays the migration set without changing installed state", async () => {
    const before = await admin!`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name like 'studio\_%' escape '\'
    `;
    await applyAll();
    const after = await admin!`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name like 'studio\_%' escape '\'
    `;
    expect(after).toEqual(before);
    expect(after[0]!.count).toBe(STUDIO_TABLES.length);
  });
});
