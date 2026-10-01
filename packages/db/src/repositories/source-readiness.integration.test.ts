import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";

const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
const appUrl = process.env.TEST_DATABASE_URL!;
if (enabled)
  for (const value of [adminUrl, appUrl]) {
    const url = new URL(value);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/opak_fixes_")
    )
      throw new Error(
        "readiness tests require an explicit dedicated loopback DB",
      );
  }
describe.skipIf(!enabled)("set-based source readiness with real RLS", () => {
  const workspace = "ws_e_reads_" + randomUUID(),
    foreign = "ws_e_foreign_" + randomUUID();
  const ids = Array.from({ length: 100 }, () => randomUUID()),
    foreignId = randomUUID(),
    badId = randomUUID();
  const connection = randomUUID(),
    latest = randomUUID(),
    earlier = randomUUID();
  let admin: ReturnType<typeof postgres>, db: ReturnType<typeof createDatabase>;
  let statements = 0;
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, prepare: false, onnotice() {} });
    db = createDatabase(appUrl, {
      migrationUrl: adminUrl,
      createClient(url, options) {
        return postgres(url, {
          ...options,
          debug() {
            statements++;
          },
        });
      },
    });
    await db.migrate();
    await admin`insert into workspaces(id,name,profile) values (${workspace},'Synthetic readiness','{}'),(${foreign},'Synthetic foreign','{}')`;
    await admin`insert into listing_drafts(id,workspace_id,target,status) select id,${workspace},'shopline','needs_info' from unnest(${ids}::uuid[]) id`;
    await admin`insert into listing_drafts(id,workspace_id,target,status) values (${foreignId},${foreign},'shopline','needs_info'),(${badId},${workspace},'shopline','in_review')`;
    const version = randomUUID();
    await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${version},${workspace},${badId},1,'{"title":null}', 'synthetic')`;
    await admin`update listing_drafts set active_version_id=${version} where workspace_id=${workspace} and id=${badId}`;
    await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connection},${workspace},'synthetic.invalid','disabled')`;
    await admin`insert into platform_products(id,workspace_id,connection_id,remote_product_id,origin,listing_id,updated_at) values (${latest},${workspace},${connection},'synthetic-latest','created',${ids[0]!},'2026-01-02'),(${earlier},${workspace},${connection},'synthetic-earlier','created',${ids[0]!},'2026-01-01')`;
  });
  afterAll(async () => {
    await admin`delete from workspaces where id in (${workspace},${foreign})`;
    await db.close();
    await admin.end();
  });
  it("has exactly one application SELECT for 1, 25 and 100 IDs, plus fixed workspace transaction controls", async () => {
    await db.forWorkspace(workspace, async () => {}); // Establish role once, outside sample counts.
    const counts: number[] = [];
    for (const size of [1, 25, 100]) {
      statements = 0;
      await db.forWorkspace(workspace, async (r) => {
        const result = await r.reads.sourceReadinessBatch(ids.slice(0, size));
        expect(result.listings).toHaveLength(size);
      });
      counts.push(statements);
    }
    expect(counts).toEqual([4, 4, 4]); // BEGIN + scoped set_config + one SELECT + COMMIT.
  });
  it("excludes foreign IDs and follows the scalar authoritative latest-link ordering", async () => {
    await db.forWorkspace(workspace, async (r) => {
      const bundle = await r.reads.sourceReadinessBatch([ids[0]!, foreignId]);
      expect(bundle.listings).toHaveLength(1);
      expect(bundle.listings[0]!.link).toEqual(
        await r.platformProducts.getByListingId(ids[0]!),
      );
      expect(bundle.listings[0]!.link?.id).toBe(latest);
    });
  });
  it("classifies only malformed owned active content, leaving the healthy rows usable", async () => {
    await db.forWorkspace(workspace, async (r) => {
      const bundle = await r.reads.sourceReadinessBatch([ids[1]!, badId]);
      expect(
        bundle.listings.find((item) => item.id === badId)?.error,
      ).toMatchObject({ reason: "invalid_active_version" });
      expect(
        bundle.listings.find((item) => item.id === ids[1])?.error,
      ).toBeNull();
      await expect(r.listings.getReviewSnapshot(badId)).rejects.toMatchObject({
        reason: "invalid_active_version",
      });
    });
  });
});
