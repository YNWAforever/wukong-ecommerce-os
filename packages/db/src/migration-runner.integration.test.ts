import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "./client.js";

const url = process.env.PRODREC_DATABASE_ADMIN_URL;
const enabled = Boolean(url) && process.env.PRODREC_DISPOSABLE === "yes";

if (enabled) {
  const target = new URL(url!);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/prod_recovery_test"
  ) {
    throw new Error("Refusing non-isolated production-recovery test target");
  }
}

const admin = enabled
  ? postgres(url!, { max: 2, onnotice: () => undefined, prepare: false })
  : null;

async function migrationDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wukong-migrations-"));
  for (const [name, sql] of Object.entries(files))
    await writeFile(join(dir, name), sql);
  return dir;
}

function loggedEvents(spies: ReturnType<typeof vi.spyOn>[]) {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

const describeIf = enabled ? describe : describe.skip;

describeIf("migration runner (disposable Postgres)", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("fails fast with 55P03 and logs the file when a lock is held", async () => {
    await admin!.unsafe(
      "DROP TABLE IF EXISTS lock_probe; CREATE TABLE lock_probe (id int)",
    );
    process.env.DATABASE_MIGRATIONS_DIR = await migrationDir({
      "9999_lock_probe.sql":
        "ALTER TABLE lock_probe ADD COLUMN IF NOT EXISTS x int;",
    });
    process.env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS = "200";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = admin!.begin(async (transaction) => {
      await transaction.unsafe(
        "LOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE",
      );
      locked();
      await held;
    });
    await lockTaken;

    const started = Date.now();
    const database = createDatabase(url!, { migrationUrl: url! });
    try {
      await expect(database.migrate()).rejects.toMatchObject({
        code: "55P03",
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      release();
      await holder;
      await database.close();
    }

    expect(loggedEvents([info, error])).toContainEqual({
      event: "migration_failed",
      name: "9999_lock_probe.sql",
      code: "55P03",
    });
  });

  it("logs started and applied for each file in order", async () => {
    await admin!.unsafe("DROP TABLE IF EXISTS order_probe");
    process.env.DATABASE_MIGRATIONS_DIR = await migrationDir({
      "9001_first.sql": "CREATE TABLE IF NOT EXISTS order_probe (id int);",
      "9002_second.sql":
        "ALTER TABLE order_probe ADD COLUMN IF NOT EXISTS y int;",
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const database = createDatabase(url!, { migrationUrl: url! });
    try {
      await database.migrate();
    } finally {
      await database.close();
    }

    const events = loggedEvents([info]).map(({ event, name }) => ({
      event,
      name,
    }));
    expect(events).toEqual([
      { event: "migration_started", name: "9001_first.sql" },
      { event: "migration_applied", name: "9001_first.sql" },
      { event: "migration_started", name: "9002_second.sql" },
      { event: "migration_applied", name: "9002_second.sql" },
    ]);
    const applied = loggedEvents([info]).filter(
      ({ event }) => event === "migration_applied",
    );
    for (const entry of applied) expect(Number.isInteger(entry.ms)).toBe(true);
  });
});
