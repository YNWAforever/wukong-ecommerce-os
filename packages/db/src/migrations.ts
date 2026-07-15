import { readdir, readFile } from "node:fs/promises";

export type SqlMigration = {
  name: string;
  sql: string;
};

export async function loadSqlMigrations(directory: URL): Promise<SqlMigration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, directory), "utf8"),
    })),
  );
}
