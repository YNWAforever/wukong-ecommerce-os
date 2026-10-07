import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMigrationSet, verifyMigrationSet } from "./migration-set.js";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wukong-source-"));
  await writeFile(join(dir, "0045_a.sql"), "SELECT 45;\n");
  await writeFile(join(dir, "0046_b.sql"), "SELECT 46;\n");
  await writeFile(join(dir, "0049_c.sql"), "SELECT 49;\n");
  return dir;
}

const out = () => mkdtemp(join(tmpdir(), "wukong-set-"));

describe("buildMigrationSet", () => {
  it("copies exactly the named files with their source hashes in order", async () => {
    const sourceDir = await fixture();
    const outDir = await out();
    const manifest = await buildMigrationSet({
      sourceDir,
      include: ["0049", "0046"],
      outDir,
    });
    const hash = async (name: string) =>
      createHash("sha256")
        .update(await readFile(join(sourceDir, name)))
        .digest("hex");
    expect(manifest.files).toEqual([
      { name: "0046_b.sql", sha256: await hash("0046_b.sql") },
      { name: "0049_c.sql", sha256: await hash("0049_c.sql") },
    ]);
    expect(
      (await readdir(outDir)).filter((name) => name.endsWith(".sql")).sort(),
    ).toEqual(["0046_b.sql", "0049_c.sql"]);
  });

  it("rejects a prefix that names no migration", async () => {
    await expect(
      buildMigrationSet({
        sourceDir: await fixture(),
        include: ["0047"],
        outDir: await out(),
      }),
    ).rejects.toThrow(/unknown migration 0047/);
  });

  it("refuses a prefix shared by two migrations and accepts exact names", async () => {
    const sourceDir = await fixture();
    await writeFile(join(sourceDir, "0046_twin.sql"), "SELECT 460;\n");
    await expect(
      buildMigrationSet({ sourceDir, include: ["0046"], outDir: await out() }),
    ).rejects.toThrow(/ambiguous migration 0046/);
    const manifest = await buildMigrationSet({
      sourceDir,
      include: ["0046_b.sql", "0046_twin.sql"],
      outDir: await out(),
    });
    expect(manifest.files.map(({ name }) => name)).toEqual([
      "0046_b.sql",
      "0046_twin.sql",
    ]);
  });

  it("refuses an output directory that already holds files", async () => {
    const outDir = await out();
    await writeFile(join(outDir, "stray.sql"), "SELECT 1;\n");
    await expect(
      buildMigrationSet({
        sourceDir: await fixture(),
        include: ["0046"],
        outDir,
      }),
    ).rejects.toThrow(/output directory not empty/);
  });
});

describe("verifyMigrationSet", () => {
  async function built() {
    const outDir = await out();
    const manifest = await buildMigrationSet({
      sourceDir: await fixture(),
      include: ["0046", "0049"],
      outDir,
    });
    return { outDir, manifest };
  }

  it("accepts an untouched set", async () => {
    const { outDir, manifest } = await built();
    await expect(verifyMigrationSet(outDir, manifest)).resolves.toBeUndefined();
  });

  it("rejects a file changed after hashing", async () => {
    const { outDir, manifest } = await built();
    await appendFile(join(outDir, "0046_b.sql"), " ");
    await expect(verifyMigrationSet(outDir, manifest)).rejects.toThrow(
      /mismatch 0046_b\.sql/,
    );
  });

  it.each(["10001_extra.sql", "7_extra.sql", "notes.txt"])(
    "rejects %s, which the runner's loader would see or a reviewer would miss",
    async (name) => {
      const { outDir, manifest } = await built();
      await writeFile(join(outDir, name), "SELECT 1;\n");
      await expect(verifyMigrationSet(outDir, manifest)).rejects.toThrow(
        `mismatch ${name}`,
      );
    },
  );

  it("rejects an extra migration dropped into the set", async () => {
    const { outDir, manifest } = await built();
    await writeFile(join(outDir, "0050_extra.sql"), "SELECT 50;\n");
    await expect(verifyMigrationSet(outDir, manifest)).rejects.toThrow(
      /mismatch 0050_extra\.sql/,
    );
  });
});
