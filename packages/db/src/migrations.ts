import { readdir, readFile } from "node:fs/promises";

export type SqlMigration = {
  name: string;
  sql: string;
};

/** The one definition of a migration file name, shared with migration sets. */
export const MIGRATION_FILE_PATTERN = /^\d+_.+\.sql$/u;

export async function loadSqlMigrations(
  directory: URL,
): Promise<SqlMigration[]> {
  const names = (await readdir(directory))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(new URL(name, directory), "utf8"),
    })),
  );
}
