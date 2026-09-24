import { beforeAll, afterAll, it, expect, describe } from "vitest";
import postgres from "postgres";
import { loadSqlMigrations } from "./migrations.js";
const url = process.env.FRESH_EXPORT_REHEARSAL_DATABASE_ADMIN_URL;
const enabled =
  !!url && process.env.FRESH_EXPORT_REHEARSAL_DISPOSABLE === "yes";
// Destructive schema resets are opt-in and restricted to this explicitly named local rehearsal database.
if (enabled) {
  const target = new URL(url!);
  if (
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.pathname !== "/task8_migration" ||
    target.port !== "55445" ||
    url === process.env.TEST_DATABASE_ADMIN_URL
  )
    throw new Error("Refusing non-isolated rehearsal target");
}
const admin = enabled
  ? postgres(url!, { max: 1, onnotice: () => undefined, prepare: false })
  : null;
const migrations = await loadSqlMigrations(
  new URL("../drizzle/", import.meta.url),
);
const reset = async () => {
  const [target] = await admin!`select current_database() as name`;
  expect(target!.name).toBe("task8_migration");
  await admin!.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
};
const apply = async (list = migrations) => {
  for (const m of list)
    await admin!.begin(async (tx) => {
      await tx.unsafe(m.sql);
    });
};
afterAll(async () => {
  await admin?.end();
});
describe.skipIf(!enabled)("fresh export isolated migration rehearsal", () => {
  it("installs fresh and replays without backfilling trusted comparisons", async () => {
    await reset();
    await apply();
    expect(await admin!`select id from export_verifications`).toHaveLength(0);
    await apply();
    expect(await admin!`select id from export_verifications`).toHaveLength(0);
  });
  it("upgrades 0017 preserving legacy reports and creates no comparison receipts", async () => {
    await reset();
    await apply(migrations.filter((m) => m.name < "0017"));
    await admin!`insert into workspaces(id,name,profile) values('migration_synthetic','Synthetic','{}')`;
    await admin!`insert into listing_drafts(id,workspace_id) values('11111111-1111-4111-8111-111111111111','migration_synthetic')`;
    await admin!`insert into import_results(workspace_id,listing_id,outcome,recorded_by) values('migration_synthetic','11111111-1111-4111-8111-111111111111','accepted','synthetic')`;
    await apply(migrations.filter((m) => m.name >= "0017" && m.name < "0018"));
    const before = await admin!`select * from import_results`;
    await apply(migrations.filter((m) => m.name >= "0018"));
    expect(await admin!`select * from import_results`).toEqual(before);
    expect(before[0]!.mode).toBe("legacy_historical");
    expect(await admin!`select id from export_verifications`).toHaveLength(0);
    await apply();
    expect(await admin!`select * from import_results`).toEqual(before);
  });
});
