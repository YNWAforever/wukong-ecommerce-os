import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";
const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "";
const appUrl = process.env.TEST_DATABASE_URL ?? "";
function guard(url: string) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/opak_fixes_admin_20261001"
  )
    throw new Error("Dedicated loopback Opak admin test database required");
}
describe.skipIf(!enabled)(
  "Opak admin CAS and readiness with actual RLS",
  () => {
    let admin: ReturnType<typeof postgres>;
    let db: ReturnType<typeof createDatabase>;
    const own = `ws_admin_${randomUUID()}`,
      foreign = `ws_foreign_${randomUUID()}`;
    const user = `user_admin_${randomUUID()}`,
      other = `user_other_${randomUUID()}`;
    const profile = {
      name: "Synthetic admin fixture",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      tone: "Plain",
      claimPolicy: [],
      requiredFields: [],
    };
    beforeAll(async () => {
      guard(adminUrl);
      guard(appUrl);
      admin = postgres(adminUrl, {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      db = createDatabase(appUrl, { migrationUrl: adminUrl });
      await db.migrate();
      const [role] =
        await admin`select rolsuper,rolbypassrls from pg_roles where rolname='wukong_app'`;
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      await admin`insert into workspaces(id,name,profile) values (${own},'Synthetic own',${admin.json(profile)}),(${foreign},'Synthetic foreign',${admin.json(profile)})`;
      await admin`insert into users(id,email) values (${user},${user + "@local.invalid"}),(${other},${other + "@local.invalid"})`;
      await admin`insert into memberships(workspace_id,user_id,role) values (${own},${user},'admin'),(${foreign},${other},'reviewer')`;
    });
    afterAll(async () => {
      if (admin) {
        await admin`delete from workspaces where id in (${own},${foreign})`;
        await admin`delete from users where id in (${user},${other})`;
      }
      await db?.close();
      await admin?.end();
    });
    it("rejects a stale brand-color save after a different admin policy write", async () => {
      const original = await db.forWorkspace(own, (r) =>
        r.workspaces.requireProfile(),
      );
      const digest = createHash("sha256")
        .update(JSON.stringify(original))
        .digest("hex");
      await db.forWorkspace(own, (r) =>
        r.workspaces.updateSettings({ tone: "New admin tone" }, digest),
      );
      await expect(
        db.forWorkspace(own, (r) =>
          r.workspaces.updateSettings(
            { brandBackgroundColor: "#112233" },
            digest,
          ),
        ),
      ).rejects.toMatchObject({ code: "workspace_policy_conflict" });
      expect(
        await db.forWorkspace(own, (r) => r.workspaces.requireProfile()),
      ).toMatchObject({ tone: "New admin tone", brandBackgroundColor: null });
    });
    it("counts current reviewer-capable members without foreign workspace records", async () => {
      const ownResult = await db.forWorkspace(own, (r) =>
        r.workspaces.readinessObservations(),
      );
      expect(ownResult).toMatchObject({
        reviewerCount: 1,
        connectionPresent: false,
        latestAi: null,
        latestQueueStep: null,
      });
      await admin`delete from memberships where workspace_id=${own}`;
      expect(
        (
          await db.forWorkspace(own, (r) =>
            r.workspaces.readinessObservations(),
          )
        ).reviewerCount,
      ).toBe(0);
      expect(
        (
          await db.forWorkspace(foreign, (r) =>
            r.workspaces.readinessObservations(),
          )
        ).reviewerCount,
      ).toBe(1);
    });
  },
);
