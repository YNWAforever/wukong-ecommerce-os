import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase } from "../client.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!,
  appUrl = process.env.TEST_DATABASE_URL!;
if (
  !adminUrl ||
  !appUrl ||
  !adminUrl.endsWith("/task67_integration") ||
  !appUrl.endsWith("/task67_integration")
)
  throw new Error("Explicit task67_integration database required");
const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => {},
    prepare: false,
  }),
  db = createDatabase(appUrl);
const ws = "task7d-" + randomUUID(),
  foreign = "task7d-" + randomUUID(),
  empty = "task7d-" + randomUUID();
const listing = randomUUID(),
  other = randomUUID(),
  foreignListing = randomUUID();
const base = randomUUID(),
  version = randomUUID(),
  otherVersion = randomUUID(),
  foreignVersion = randomUUID();
const start = "2026-08-06T00:00:00Z",
  end = "2026-09-05T00:00:00Z";
const content = {
  title: { en: "protected", "zh-Hant": "甲" },
  description: { en: "a", "zh-Hant": "乙" },
  seo: {
    title: { en: "b", "zh-Hant": "丙" },
    description: { en: "c", "zh-Hant": "丁" },
  },
  tags: ["wine"],
};
describe("review metric retained evidence scope", () => {
  beforeAll(async () => {
    await admin`insert into workspaces(id,name,profile) values (${ws},'synthetic','{}'),(${foreign},'synthetic','{}'),(${empty},'synthetic','{}')`;
    await admin`insert into listing_drafts(id,workspace_id,target) values (${listing},${ws},'shopline'),(${other},${ws},'shopline'),(${foreignListing},${foreign},'shopline')`;
    await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by,created_at) values
  (${base},${ws},${listing},1,${admin.json(content)},'u','2026-07-01T00:00:00Z'),
  (${version},${ws},${listing},2,${admin.json({ ...content, title: { en: "protected", "zh-Hant": "甲改" } })},'u','2026-09-01T00:00:00Z'),
  (${otherVersion},${ws},${other},1,'{}','u','2026-09-01T00:00:00Z'),
  (${foreignVersion},${foreign},${foreignListing},1,'{}','u','2026-09-01T00:00:00Z')`;
    for (const [entity, reference, at] of [
      [listing, version, "2026-09-02T00:00:00Z"],
      [listing, version, "2026-09-03T00:00:00Z"],
      [listing, version, "2026-08-30T00:00:00Z"],
      [listing, foreignVersion, "2026-09-02T00:00:00Z"],
      [listing, otherVersion, "2026-09-02T00:00:00Z"],
      [listing, "malformed", "2026-09-02T00:00:00Z"],
      [other, otherVersion, "2026-09-06T00:00:00Z"],
    ]) {
      await admin`insert into audit_events(workspace_id,actor_id,entity_id,action,metadata,created_at) values (${ws},'u',${entity!},'listing.approved',${admin.json({ versionId: reference })},${at!})`;
    }
    await admin`insert into audit_events(workspace_id,actor_id,entity_id,action,metadata,created_at) values (${foreign},'u',${foreignListing},'listing.approved',${admin.json({ versionId: foreignVersion })},'2026-09-02T00:00:00Z')`;
    for (const reference of [base, foreignVersion, otherVersion])
      await admin`insert into review_events(workspace_id,listing_id,actor_id,action,metadata,created_at) values (${ws},${listing},'u','listing.edited',${admin.json({ baseVersionId: reference, versionId: version, changedFields: ["title"] })},'2026-09-02T00:00:00Z')`;
  });
  afterAll(async () => {
    await admin`delete from workspaces where id in (${ws},${foreign},${empty})`;
    await db.close();
    await admin.end();
  });
  it("aggregates full version cohort and collapses valid approval retries, excluding negative, malformed and foreign references", async () => {
    const result = await db.forWorkspace(ws, (r) =>
      r.reads.reviewQualityEvidence(start, end),
    );
    expect(result).toMatchObject({
      versions: 2,
      approved: 1,
      elapsedMs: 86400000,
      duplicateApprovals: 1,
      invalidApprovals: 4,
    });
    expect(result.edits).toHaveLength(3);
    const edits = result.edits as Array<{
      baseVersionId: string;
      baseContent: unknown;
      content: unknown;
    }>;
    expect(edits.find((e) => e.baseVersionId === base)?.baseContent).toEqual(
      content,
    );
    expect(
      edits.find((e) => e.baseVersionId === foreignVersion)?.baseContent,
    ).toBeNull();
    expect(
      edits.find((e) => e.baseVersionId === otherVersion)?.baseContent,
    ).toBeNull();
  });
  it("returns explicit zero cohort counts and no edit rows for another empty workspace", async () => {
    expect(
      await db.forWorkspace(empty, (r) =>
        r.reads.reviewQualityEvidence(start, end),
      ),
    ).toEqual({
      versions: 0,
      approved: 0,
      elapsedMs: 0,
      duplicateApprovals: 0,
      invalidApprovals: 0,
      edits: [],
    });
  });
  it("retains a 1001st sentinel without hydrating an unbounded edit history", async () => {
    await admin`insert into review_events(workspace_id,listing_id,actor_id,action,metadata,created_at) select ${ws},${listing},'u','listing.edited',${admin.json({ baseVersionId: base, versionId: version })},'2026-09-02T00:00:00Z' from generate_series(1,1002)`;
    const result = await db.forWorkspace(ws, (r) =>
      r.reads.reviewQualityEvidence(start, end),
    );
    expect(result.edits).toHaveLength(1001);
    expect(result.versions).toBe(2);
    expect(result.approved).toBe(1);
  });
});
