import postgres from "postgres";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase } from "../index.js";
const adminUrl = process.env.TEST_MIGRATION_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_MIGRATION_DATABASE_URL;
// This destructive fresh-schema rehearsal has separate explicit service URLs.
if (!adminUrl || !appUrl) {
  it.skip("requires dedicated local migration-rehearsal URLs", () => {});
} else {
  if (
    !adminUrl ||
    !appUrl ||
    new URL(adminUrl).pathname !== "/task5_migration_review" ||
    new URL(appUrl).pathname !== "/task5_migration_review"
  )
    throw new Error("Explicit task5_migration_review test URLs required");
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  const app = postgres(appUrl, { max: 1 });
  const db = createDatabase(appUrl, { migrationUrl: adminUrl });
  const listing = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let receiptId: string;
  beforeAll(async () => {
    // This file is restricted above to the disposable migration-review database.
    // Start empty so every run proves initial application as well as replay.
    await admin.unsafe("DROP SCHEMA public CASCADE");
    await admin.unsafe("CREATE SCHEMA public");
    await admin.unsafe("GRANT USAGE ON SCHEMA public TO PUBLIC");
    await db.migrate();
    await admin`insert into workspaces(id,name,profile) values('migration_review','Migration review','{}') on conflict do nothing`;
    await admin`insert into listing_drafts(id,workspace_id) values(${listing},'migration_review') on conflict do nothing`;
    receiptId = (
      await db.forWorkspace("migration_review", (r) =>
        r.importResults.create({
          mode: "historical_manual",
          listingId: listing,
          exportAttemptId: null,
          idempotencyKey: "migration-review-receipt",
          outcome: "accepted",
          rejectReason: null,
          recordedBy: "synthetic",
        }),
      )
    ).id;
  });
  afterAll(async () => {
    await db.close();
    await app.end();
    await admin.end();
  });
  async function assertImmutable() {
    for (const mutation of [
      `UPDATE import_results SET recorded_by='changed' WHERE id='${receiptId}'`,
      `DELETE FROM import_results WHERE id='${receiptId}'`,
    ]) {
      await expect(
        app.begin(async (tx) => {
          await tx`select set_config('app.workspace_id','migration_review',true)`;
          await tx.unsafe(mutation);
          throw new Error("mutation unexpectedly allowed");
        }),
      ).rejects.toThrow(/permission denied|import results are append only/);
    }
    const rows = await db.forWorkspace("migration_review", (r) =>
      r.importResults.listForWorkspace(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(receiptId);
    expect(rows[0]?.recordedBy).toBe("synthetic");
  }
  it("preserves receipts and revoked UPDATE/DELETE after the initial and two repeated full migrations", async () => {
    await assertImmutable();
    for (let replay = 0; replay < 2; replay++) {
      await expect(db.migrate()).resolves.toBeUndefined();
      const [permissions] =
        await admin`select has_table_privilege('wukong_app','import_results','UPDATE') as update,has_table_privilege('wukong_app','import_results','DELETE') as delete`;
      expect(permissions).toEqual({ update: false, delete: false });
      await assertImmutable();
    }
  });
  it("keeps immutable receipts protected if an earlier migration regrants privileges before a later failure", async () => {
    try {
      await admin.unsafe(
        "GRANT UPDATE, DELETE ON import_results TO wukong_app",
      );
      await assertImmutable();
    } finally {
      await admin.unsafe(
        "REVOKE UPDATE, DELETE ON import_results FROM wukong_app",
      );
    }
  });
}
