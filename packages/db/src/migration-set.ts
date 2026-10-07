import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type MigrationSetManifest = {
  files: { name: string; sha256: string }[];
};

const MIGRATION_FILE = /^\d{4}_.+\.sql$/u;

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function listMigrations(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => MIGRATION_FILE.test(name));
}

/**
 * Copies only the named migrations, byte for byte, into an empty directory
 * that `DATABASE_MIGRATIONS_DIR` can point at, and records each file's hash so
 * the production run can prove it executes exactly what was rehearsed.
 */
export async function buildMigrationSet(input: {
  sourceDir: string;
  include: string[];
  outDir: string;
}): Promise<MigrationSetManifest> {
  const available = await listMigrations(input.sourceDir);
  const names = [...new Set(input.include)].map((prefix) => {
    const matches = available.filter((name) => name.startsWith(`${prefix}_`));
    if (matches.length !== 1) throw new Error(`unknown migration ${prefix}`);
    return matches[0]!;
  });
  await mkdir(input.outDir, { recursive: true });
  if ((await readdir(input.outDir)).length > 0)
    throw new Error("output directory not empty");

  const files = [];
  for (const name of names.sort()) {
    await copyFile(join(input.sourceDir, name), join(input.outDir, name));
    files.push({ name, sha256: await sha256(join(input.outDir, name)) });
  }
  const manifest: MigrationSetManifest = { files };
  await writeFile(
    join(input.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** Fails on any missing, extra or changed migration in the set. */
export async function verifyMigrationSet(
  outDir: string,
  expected: MigrationSetManifest,
): Promise<void> {
  const present = (await listMigrations(outDir)).sort();
  const wanted = new Map(
    expected.files.map((file) => [file.name, file.sha256]),
  );
  for (const name of present)
    if (!wanted.has(name)) throw new Error(`migration set mismatch ${name}`);
  for (const [name, hash] of wanted) {
    if (!present.includes(name) || (await sha256(join(outDir, name))) !== hash)
      throw new Error(`migration set mismatch ${name}`);
  }
}
