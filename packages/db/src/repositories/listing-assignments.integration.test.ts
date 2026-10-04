import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";

const optedIn = process.env.WUKONG_OPAK_INTEGRATION === "1";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "";
const appUrl = process.env.TEST_DATABASE_URL ?? "";
if (optedIn)
  for (const raw of [adminUrl, appUrl]) {
    const url = new URL(raw);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/opak_fixes_assignment_20261001"
    )
      throw new Error(
        "T08 requires its dedicated loopback assignment database",
      );
  }
describe.skipIf(!optedIn)("assignment CAS, membership and actual RLS", () => {
  const ws = "assignment-" + randomUUID(),
    foreignWs = "assignment-" + randomUUID();
  const actors = Array.from({ length: 5 }, () => randomUUID());
  const [adminId, reviewerId, opA, opB, viewerId] = actors as [
    string,
    string,
    string,
    string,
    string,
  ];
  const foreignUser = randomUUID();
  const listings = Array.from({ length: 10 }, () => randomUUID());
  const foreignListing = randomUUID();
  const admin = postgres(adminUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  const rawApp = postgres(appUrl, { max: 1, prepare: false });
  const db = createDatabase(appUrl, { migrationUrl: adminUrl });
  const apply = (
    index: number,
    actorId: string,
    assigneeUserId: string | null,
    action: "assign" | "claim" | "handoff",
    revision = 0,
    key = randomUUID(),
  ) =>
    db.forWorkspace(ws, (r) =>
      r.assignments.apply({
        listingId: listings[index]!,
        actorId,
        assigneeUserId,
        action,
        expectedRevision: revision,
        idempotencyKey: key,
      }),
    );
  beforeAll(async () => {
    const roles =
      await rawApp`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(roles[0]).toMatchObject({
      name: "wukong_app",
      rolsuper: false,
      rolbypassrls: false,
    });
    await db.migrate();
    await admin`insert into workspaces(id,name,profile) values (${ws},'Synthetic assignment workspace','{}'),(${foreignWs},'Synthetic foreign workspace','{}')`;
    for (const [index, id] of [...actors, foreignUser].entries())
      await admin`insert into users(id,email,auth_email_verified) values (${id},${"assignment-" + id + "@local.invalid"},true)`;
    for (const [index, id] of actors.entries())
      await admin`insert into memberships(workspace_id,user_id,role) values (${ws},${id},${["admin", "reviewer", "operator", "operator", "viewer"][index]!})`;
    await admin`insert into memberships(workspace_id,user_id,role) values (${foreignWs},${foreignUser},'reviewer')`;
    for (const id of listings)
      await admin`insert into listing_drafts(id,workspace_id,target,status,note) values (${id},${ws},'shopline','received','Synthetic responsibility test')`;
    await admin`insert into listing_drafts(id,workspace_id,target,note) values (${foreignListing},${foreignWs},'shopline','Synthetic foreign')`;
  }, 120000);
  afterAll(async () => {
    await admin`delete from workspaces where id in (${ws},${foreignWs})`;
    await admin`delete from users where id in ${admin([...actors, foreignUser])}`;
    await Promise.all([db.close(), admin.end(), rawApp.end()]);
  });
  it("reviewer assignment increments responsibility without touching workflow or approval", async () => {
    expect(await apply(0, reviewerId, opA, "assign")).toMatchObject({
      outcome: "assigned",
      assignmentRevision: 1,
      assigneeUserId: opA,
    });
    const rows =
      await admin`select status,active_version_id from listing_drafts where id=${listings[0]!}`;
    expect(rows[0]).toMatchObject({
      status: "received",
      active_version_id: null,
    });
  });
  it("a repeated item key writes one audit and a changed replay payload conflicts", async () => {
    const key = randomUUID();
    await apply(1, adminId, opA, "assign", 0, key);
    expect(await apply(1, adminId, opA, "assign", 0, key)).toMatchObject({
      outcome: "assigned",
      replayed: true,
      assignmentRevision: 1,
    });
    expect(await apply(1, adminId, opB, "assign", 0, key)).toMatchObject({
      outcome: "idempotency_conflict",
    });
    const rows =
      await admin`select count(*)::int as count from audit_events where workspace_id=${ws} and entity_id=${listings[1]!} and action='listing.assigned'`;
    expect(rows[0]?.count).toBe(1);
  });
  it("two concurrent claims have one winner and one revision conflict", async () => {
    const results = await Promise.all([
      apply(2, opA, opA, "claim"),
      apply(2, opB, opB, "claim"),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "assigned",
      "revision_conflict",
    ]);
    expect(results.every((r) => r.assignmentRevision === 1)).toBe(true);
    const rows =
      await admin`select count(*)::int as count from audit_events where workspace_id=${ws} and entity_id=${listings[2]!} and action='listing.assigned'`;
    expect(rows[0]?.count).toBe(1);
  });
  it("operator cannot reassign another operator's work even with its current revision", async () => {
    await apply(3, opA, opA, "claim");
    expect(await apply(3, opB, opB, "claim", 1)).toMatchObject({
      outcome: "assignment_owned",
    });
    expect(await apply(3, opB, reviewerId, "handoff", 1)).toMatchObject({
      outcome: "assignment_owned",
    });
    expect(await apply(3, opB, opA, "assign", 1)).toMatchObject({
      outcome: "insufficient_role",
    });
  });
  it("operator hands only their own work to a current reviewer", async () => {
    await apply(4, opA, opA, "claim");
    expect(await apply(4, opA, opB, "handoff", 1)).toMatchObject({
      outcome: "target_not_active",
    });
    expect(await apply(4, opA, reviewerId, "handoff", 1)).toMatchObject({
      outcome: "assigned",
      assignmentRevision: 2,
    });
  });
  it("denies foreign listing, foreign target and viewer target", async () => {
    const item = {
      actorId: adminId,
      listingId: foreignListing,
      assigneeUserId: opA,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      action: "assign" as const,
    };
    expect(
      await db.forWorkspace(ws, (r) => r.assignments.apply(item)),
    ).toMatchObject({ outcome: "listing_not_found" });
    expect(await apply(5, adminId, foreignUser, "assign")).toMatchObject({
      outcome: "target_not_active",
    });
    expect(await apply(5, adminId, viewerId, "assign")).toMatchObject({
      outcome: "target_not_active",
    });
    const rows = await db.forWorkspace(ws, (r) =>
      r.assignments.getMany([foreignListing, listings[5]!]),
    );
    expect(rows.map((r) => r.listingId)).toEqual([listings[5]]);
  });
  it("rechecks removed members and demoted actor roles under the transaction lock", async () => {
    await admin`update memberships set role='viewer' where workspace_id=${ws} and user_id=${opB}`;
    expect(await apply(6, opB, opB, "claim")).toMatchObject({
      outcome: "insufficient_role",
    });
    expect(await apply(6, adminId, opB, "assign")).toMatchObject({
      outcome: "target_not_active",
    });
    await admin`delete from memberships where workspace_id=${ws} and user_id=${opB}`;
    expect(await apply(6, opB, reviewerId, "handoff")).toMatchObject({
      outcome: "insufficient_role",
    });
    await admin`insert into memberships(workspace_id,user_id,role) values (${ws},${opB},'operator')`;
  });
  it("RLS hides assignments and receipts outside the configured workspace", async () => {
    await rawApp.begin(async (tx) => {
      await tx`select set_config('app.workspace_id',${foreignWs},true)`;
      expect(
        await tx`select * from listing_assignments where workspace_id=${ws}`,
      ).toHaveLength(0);
      expect(
        await tx`select * from listing_assignment_requests where workspace_id=${ws}`,
      ).toHaveLength(0);
    });
  });
  it("RLS rejects foreign writes even when direct SQL supplies workspace IDs", async () => {
    await expect(
      rawApp.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${foreignWs},true)`;
        await tx`insert into listing_assignments(workspace_id,listing_id,assignee_user_id,assignment_revision) values (${ws},${listings[7]!},${opA},1)`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("admin can unassign at the current revision and no-op retry doesn't add audit", async () => {
    await apply(8, adminId, opA, "assign");
    expect(await apply(8, adminId, null, "assign", 1)).toMatchObject({
      outcome: "assigned",
      assigneeUserId: null,
      assignmentRevision: 2,
    });
    expect(await apply(8, adminId, null, "assign", 2)).toMatchObject({
      outcome: "assigned",
      assignmentRevision: 2,
    });
    const rows =
      await admin`select count(*)::int as count from audit_events where workspace_id=${ws} and entity_id=${listings[8]!} and action='listing.assigned'`;
    expect(rows[0]?.count).toBe(2);
  });
  it("allows an operator to reclaim an inactive assignee at the current revision", async () => {
    await apply(9, adminId, opB, "assign");
    await admin`update memberships set role='viewer' where workspace_id=${ws} and user_id=${opB}`;
    try {
      const snapshot = await db.forWorkspace(ws, (r) =>
        r.assignments.getMany([listings[9]!]),
      );
      expect(snapshot[0]?.assigneeActive).toBe(false);
      expect(await apply(9, opA, opA, "claim", 1)).toMatchObject({
        outcome: "assigned",
        assigneeUserId: opA,
        assignmentRevision: 2,
      });
    } finally {
      await admin`update memberships set role='operator' where workspace_id=${ws} and user_id=${opB}`;
    }
  });
});
