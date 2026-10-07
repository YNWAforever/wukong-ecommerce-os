import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { loadSqlMigrations } from "./migrations.js";
import { inspectSchemaInventory, readOnly } from "./schema-inventory.js";

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
  ? postgres(url!, { max: 1, onnotice: () => undefined, prepare: false })
  : null;
const migrations = await loadSqlMigrations(
  new URL("../drizzle/", import.meta.url),
);
const UNAPPLIED = ["0046", "0049", "0050", "0051", "0052", "0053"];

async function reset(): Promise<void> {
  const [target] = await admin!`select current_database() as name`;
  expect(target?.name).toBe("prod_recovery_test");
  await admin!.unsafe(
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC",
  );
}

async function apply(include: (name: string) => boolean): Promise<void> {
  for (const migration of migrations.filter(({ name }) => include(name)))
    await admin!.begin((transaction) => transaction.unsafe(migration.sql));
}

function inventory() {
  return inspectSchemaInventory((sql) => admin!.unsafe(sql));
}

afterAll(async () => {
  await admin?.end();
});

describe.skipIf(!enabled)("schema inventory (disposable Postgres)", () => {
  it("reports nothing missing on a fully migrated database", async () => {
    await reset();
    await apply(() => true);
    const report = await inventory();
    expect(report.missing).toEqual([]);
    expect(report.wukongAppRole).toBe(true);
    expect(Object.values(report.appGrants).every(Boolean)).toBe(true);
  });

  it("names the migrations a production-like database lacks", async () => {
    await reset();
    await apply((name) => !UNAPPLIED.includes(name.slice(0, 4)));
    expect((await inventory()).missing).toEqual(UNAPPLIED);
  });

  it("counts listing rows for the before/after invariant", async () => {
    await reset();
    await apply(() => true);
    await admin!`insert into workspaces(id,name,profile) values('prodrec_ws','Prodrec','{}')`;
    await admin!`insert into listing_drafts(id,workspace_id) values('11111111-1111-4111-8111-111111111111','prodrec_ws'),('22222222-2222-4222-8222-222222222222','prodrec_ws')`;
    expect((await inventory()).counts.listing_drafts).toBe(2);
  });

  it("refuses writes inside the read-only wrapper", async () => {
    await expect(
      readOnly(admin!, (transaction) =>
        transaction.unsafe(
          "insert into workspaces(id,name,profile) values('prodrec_write','x','{}')",
        ),
      ),
    ).rejects.toMatchObject({ code: "25006" });
  });

  it("keeps the connection string out of CLI failure output", async () => {
    const cli = fileURLToPath(
      new URL("./cli/schema-inventory.ts", import.meta.url),
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", cli],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: "postgres://u:secretpw@127.0.0.1:1/x",
        },
      },
    ).then(
      () => ({ code: 0, output: "" }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? -1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );
    expect(result.code).toBe(1);
    expect(result.output).not.toContain("secretpw");
    expect(result.output).not.toContain("127.0.0.1:1");
  });
});
