import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { loadSqlMigrations } from "./migrations.js";

it("loads SQL migrations in filename order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wukong-migrations-"));
  await writeFile(join(dir, "0001_second.sql"), "select 2;");
  await writeFile(join(dir, "0000_first.sql"), "select 1;");
  await writeFile(join(dir, "README.md"), "ignored");

  await expect(loadSqlMigrations(pathToFileURL(`${dir}/`))).resolves.toEqual([
    { name: "0000_first.sql", sql: "select 1;" },
    { name: "0001_second.sql", sql: "select 2;" },
  ]);
});

it("adds RLS-safe Better Auth enrollment functions for the runtime role", async () => {
  const migrations = await loadSqlMigrations(
    new URL("../drizzle/", import.meta.url),
  );
  const migration = migrations.find(
    ({ name }) => name === "0002_auth_access_rls.sql",
  );

  expect(migration).toBeDefined();
  expect(migration?.sql).toContain("SECURITY DEFINER");
  expect(migration?.sql).toContain("auth_get_eligible_user");
  expect(migration?.sql).toContain("auth_is_enrollment_complete");
  expect(migration?.sql).toContain("auth_complete_enrollment");
  expect(migration?.sql).toContain("GRANT EXECUTE");
  expect(migration?.sql).toContain("TO wukong_app");
});

it("adds durable publish-job lease columns and the tenant lease index", async () => {
  const migrations = await loadSqlMigrations(
    new URL("../drizzle/", import.meta.url),
  );
  const migration = migrations.find(
    ({ name }) => name === "0003_publish_job_leases.sql",
  );

  expect(migration).toBeDefined();
  expect(migration?.sql).toContain("lease_token uuid");
  expect(migration?.sql).toContain("lease_expires_at timestamptz");
  expect(migration?.sql).toContain("attempt_count integer not null default 0");
  expect(migration?.sql).toContain("publish_jobs_workspace_lease_idx");
  expect(migration?.sql).toContain("workspace_id, status, lease_expires_at");
  expect(migration?.sql).toContain("pending_enqueue");
});
