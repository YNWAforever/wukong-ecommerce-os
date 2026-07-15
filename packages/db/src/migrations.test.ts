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
