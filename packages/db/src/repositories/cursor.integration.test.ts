import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";
const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1",
  adminUrl = process.env.TEST_DATABASE_ADMIN_URL!,
  appUrl = process.env.TEST_DATABASE_URL!;
if (enabled)
  for (const value of [adminUrl, appUrl]) {
    const url = new URL(value);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/opak_fixes_")
    )
      throw new Error(
        "cursor integration requires explicit dedicated loopback DB",
      );
  }
describe.skipIf(!enabled)("exact workspace keyset pagination", () => {
  const workspace = "ws_cursor_" + randomUUID(),
    foreign = "ws_cursor_foreign_" + randomUUID();
  const sameId = randomUUID(),
    connection = randomUUID(),
    scan = randomUUID(),
    importId = randomUUID();
  let admin: ReturnType<typeof postgres>, db: ReturnType<typeof createDatabase>;
  let capturedCatalog: { text: string; params: unknown[] } | undefined;
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, prepare: false, onnotice() {} });
    db = createDatabase(appUrl, {
      migrationUrl: adminUrl,
      createClient: Object.assign(
        (url: string, options?: postgres.Options<{}>) =>
          postgres(url, {
            ...options,
            debug(_connection, sqlText, params) {
              if (/^with catalog as materialized/i.test(sqlText.trim()))
                capturedCatalog = {
                  text: sqlText,
                  params: structuredClone(params),
                };
            },
          }),
        postgres,
      ) as typeof postgres,
    });
    await db.migrate();
    await admin`insert into workspaces(id,name,profile) values (${workspace},'Synthetic cursors','{}'),(${foreign},'Synthetic foreign','{}')`;
    await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connection},${workspace},'synthetic.invalid','disabled')`;
    await admin`insert into listing_drafts(id,workspace_id,target,note,created_at,updated_at) values (${sameId},${workspace},'shopline','same timestamp','2026-01-01T00:00:00.123456Z','2026-01-01T00:00:00.123456Z')`;
    await admin`insert into platform_products(id,workspace_id,connection_id,remote_product_id,origin,created_at) values (${sameId},${workspace},${connection},'same timestamp','created','2026-01-01T00:00:00.123456Z')`;
    await admin`insert into platform_products(workspace_id,connection_id,remote_product_id,origin,created_at) values (${workspace},${connection},'one microsecond newer','created','2026-01-01T00:00:00.123457Z'),(${workspace},${connection},'one microsecond older','created','2026-01-01T00:00:00.123455Z')`;
    const observation = {
      key: "https://synthetic.invalid",
      sourceUrl: "https://synthetic.invalid",
      title: "same timestamp",
      capturedAt: "2026-01-01T00:00:00Z",
      description: null,
      imageUrls: [],
      price: null,
      availability: "unknown",
      attributes: {},
      fieldSources: {},
      warnings: [],
    };
    await admin`insert into website_scans(id,workspace_id,requested_url,requested_by,request_key,state,checkpoint,next_eligible_at,deadline_at) values (${scan},${workspace},'https://synthetic.invalid','synthetic','synthetic','ready',${admin.json({ preview: { products: [observation], warnings: [] } })},now(),now())`;
    await admin`insert into website_products(id,workspace_id,canonical_source_url,source_scan_id,source_key,observation,saved_by,created_at) values (${sameId},${workspace},${observation.key},${scan},${observation.key},${admin.json(observation)},'synthetic','2026-01-01T00:00:00.123456Z')`;
    const product = {
      rowNumber: 1,
      title: { en: "same timestamp" },
      sku: "000674",
      productId: "synthetic",
    };
    await admin`insert into workbook_imports(id,workspace_id,workbook_sha256,filename,sheet_name,header_contract_sha256,product_bindings,normalized_sheet,spec_version,total_rows,eligible_products,excluded_rows,actor_id) values (${importId},${workspace},${"a".repeat(64)},'synthetic.xlsx','synthetic',${"b".repeat(64)},jsonb_build_object('1',encode(sha256(convert_to(${admin.json(product)}::jsonb::text,'UTF8')),'hex')),'[]','synthetic',1,1,0,'synthetic')`;
    await admin`insert into workbook_products(id,workspace_id,import_id,row_number,product,created_at) values (${sameId},${workspace},${importId},1,${admin.json(product)},'2026-01-01T00:00:00.123456Z')`;
    await admin`insert into listing_drafts(workspace_id,target,note,created_at,updated_at) values (${workspace},'shopline','newer draft','2026-02-01','2026-01-01T00:00:00.123457Z'),(${workspace},'shopline','older draft','2025-12-01','2026-01-01T00:00:00.123455Z'),(${foreign},'shopline','foreign only','2026-01-01','2026-01-01')`;
    await admin`insert into enrichment_batches(workspace_id,label,budget_usd,wave_size,created_by,created_at) values (${workspace},'microsecond newer',1,1,'synthetic','2026-01-01T00:00:00.123457Z'),(${workspace},'microsecond tie A',1,1,'synthetic','2026-01-01T00:00:00.123456Z'),(${workspace},'microsecond tie B',1,1,'synthetic','2026-01-01T00:00:00.123456Z'),(${workspace},'microsecond older',1,1,'synthetic','2026-01-01T00:00:00.123455Z')`;
  });
  afterAll(async () => {
    // Immutable reference evidence remains in this dedicated synthetic DB.
    await db.close();
    await admin.end();
  });
  it("pages all four source arms with equal IDs/timestamps and microseconds, and returns to the exact previous page", async () => {
    await db.forWorkspace(workspace, async (r) => {
      const all = await r.reads.catalogPage({
        page: 1,
        pageSize: 100,
        filter: "all",
      });
      const first = await r.reads.catalogPage({
        page: 1,
        pageSize: 2,
        filter: "all",
      });
      const second = await r.reads.catalogPage({
        page: 2,
        pageSize: 2,
        filter: "all",
        cursor: first.nextCursor!,
      });
      expect(second.previousCursor!.at).toContain(".123456");
      const back = await r.reads.catalogPage({
        page: 1,
        pageSize: 2,
        filter: "all",
        cursor: second.previousCursor!,
      });
      expect(back.items).toEqual(first.items);
      const collected = [...first.items, ...second.items];
      let current = second,
        page = 2;
      while (current.nextCursor) {
        current = await r.reads.catalogPage({
          page: ++page,
          pageSize: 2,
          filter: "all",
          cursor: current.nextCursor,
        });
        collected.push(...current.items);
      }
      expect(collected).toEqual(all.items);
      expect(
        new Set(collected.map((item) => item.sourceType + ":" + item.id)).size,
      ).toBe(8);
      expect(
        collected
          .filter((item) => item.id === sameId)
          .map((item) => item.sourceType),
      ).toEqual(["draft", "platform", "website", "workbook"]);
      expect(
        (
          await r.reads.catalogPage({
            page: 1,
            pageSize: 25,
            filter: "all",
            q: "000674",
          })
        ).items,
      ).toHaveLength(1);
    });
  });
  it("materializes only bounded catalog identity work while preserving complete mixed-source rows", async () => {
    const all = await db.forWorkspace(workspace, (r) =>
      r.reads.catalogPage({ page: 1, pageSize: 100, filter: "all" }),
    );
    expect(all.totalMatching).toBe(8);
    expect(all.summary).toMatchObject({
      total: 8,
      referenceRows: 2,
      drafts: 3,
      workbook: 1,
      website: 1,
    });
    expect(
      all.items.find((item) => item.sourceType === "website"),
    ).toMatchObject({
      id: sameId,
      title: "same timestamp",
      sourceUrl: "https://synthetic.invalid",
      capturedAt: "2026-01-01T00:00:00Z",
      canExport: false,
    });
    expect(
      all.items.find((item) => item.sourceType === "workbook"),
    ).toMatchObject({
      id: sameId,
      title: "same timestamp",
      sku: "000674",
      sourceProductId: "synthetic",
      canExport: false,
    });
    expect(
      all.items.find(
        (item) => item.sourceType === "draft" && item.id === sameId,
      ),
    ).toMatchObject({
      title: "same timestamp",
      listingStatus: "received",
      needsReview: false,
      needsAttention: false,
      canExport: false,
    });
    const captured = capturedCatalog!;
    expect(captured).toBeDefined();
    const reader = postgres(appUrl, {
      max: 1,
      prepare: false,
      onnotice() {},
      connection: { default_transaction_read_only: "on" },
    });
    // Match the real adapter's transparent timestamp serializer; raw postgres would lose microseconds.
    drizzle(reader);
    try {
      const [identity] =
        await reader`select current_user role,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
      expect(identity).toMatchObject({
        role: "wukong_app",
        rolsuper: false,
        rolbypassrls: false,
      });
      const plan = await reader.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${workspace},true)`;
        const rows = await tx.unsafe(
          "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + captured.text,
          structuredClone(captured.params) as postgres.ParameterOrJSON<never>[],
        );
        return rows[0]["QUERY PLAN"][0].Plan;
      });
      const nodes: Record<string, unknown>[] = [];
      function visit(node: Record<string, unknown>) {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      }
      visit(plan);
      const identityWork = nodes.find(
        (node) => node["Subplan Name"] === "CTE catalog",
      );
      expect(identityWork).toBeDefined();
      expect(identityWork!["Actual Rows"]).toBe(8);
      // Counts and cursor order need identity/policy scalars, not all18 response columns.
      expect(Number(identityWork!["Plan Width"])).toBeLessThanOrEqual(100);
    } finally {
      await reader.end();
    }
  });
  it("keeps duplicate product links distinct and retains exact totals on an empty page", async () => {
    const duplicateWorkspace = randomUUID(),
      duplicateConnection = randomUUID(),
      listingId = randomUUID();
    await admin`insert into workspaces(id,name,profile) values (${duplicateWorkspace},'Synthetic duplicate links','{}')`;
    await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${duplicateConnection},${duplicateWorkspace},'synthetic.invalid','disabled')`;
    await admin`insert into listing_drafts(id,workspace_id,target,status,note,created_at,updated_at) values (${listingId},${duplicateWorkspace},'shopline','needs_info','Synthetic linked draft','2026-01-01','2026-01-01')`;
    await admin`insert into platform_products(workspace_id,connection_id,remote_product_id,listing_id,origin,sku,created_at) values (${duplicateWorkspace},${duplicateConnection},'duplicate link A',${listingId},'created','0001','2026-01-01'),(${duplicateWorkspace},${duplicateConnection},'duplicate link B',${listingId},'created','0002','2026-01-01')`;
    await db.forWorkspace(duplicateWorkspace, async (r) => {
      const all = await r.reads.catalogPage({
        page: 1,
        pageSize: 100,
        filter: "bound",
      });
      expect(all.totalMatching).toBe(2);
      expect(all.summary).toMatchObject({
        total: 2,
        drafts: 1,
        boundProducts: 2,
        needsAttention: 2,
      });
      expect(new Set(all.items.map((item) => item.id)).size).toBe(2);
      expect(all.items.map((item) => item.listingId)).toEqual([
        listingId,
        listingId,
      ]);
      expect(
        all.items.every(
          (item) =>
            item.sourceType === "platform" &&
            item.needsAttention &&
            item.openBlockingFlagCount === 0,
        ),
      ).toBe(true);
      expect(all.items.map((item) => item.sku).sort()).toEqual([
        "0001",
        "0002",
      ]);
      const first = await r.reads.catalogPage({
        page: 1,
        pageSize: 1,
        filter: "bound",
      });
      const second = await r.reads.catalogPage({
        page: 2,
        pageSize: 1,
        filter: "bound",
        cursor: first.nextCursor!,
      });
      expect([...first.items, ...second.items]).toEqual(all.items);
      const empty = await r.reads.catalogPage({
        page: 3,
        pageSize: 1,
        filter: "bound",
      });
      expect(empty.items).toEqual([]);
      expect(empty.totalMatching).toBe(2);
      expect(empty.summary).toEqual(all.summary);
      expect(empty.nextCursor).toBeNull();
    });
  });
  it("uses exact microsecond/id cursors for listings and merged jobs, without a recency cap", async () => {
    await db.forWorkspace(workspace, async (r) => {
      const listingAll = await r.reads.listingPage({ page: 1, pageSize: 100 });
      const listingFirst = await r.reads.listingPage({ page: 1, pageSize: 1 });
      const listingSecond = await r.reads.listingPage({
        page: 2,
        pageSize: 1,
        cursor: listingFirst.nextCursor!,
      });
      const listingLast = await r.reads.listingPage({
        page: 3,
        pageSize: 1,
        cursor: listingSecond.nextCursor!,
      });
      expect([
        ...listingFirst.ids,
        ...listingSecond.ids,
        ...listingLast.ids,
      ]).toEqual(listingAll.ids);
      expect(
        (
          await r.reads.listingPage({
            page: 1,
            pageSize: 1,
            cursor: listingSecond.previousCursor!,
          })
        ).ids,
      ).toEqual(listingFirst.ids);
      const jobsAll = await r.reads.jobsPage({ page: 1, pageSize: 100 });
      const jobsFirst = await r.reads.jobsPage({ page: 1, pageSize: 2 });
      const jobsSecond = await r.reads.jobsPage({
        page: 2,
        pageSize: 2,
        cursor: jobsFirst.nextCursor!,
      });
      expect([...jobsFirst.items, ...jobsSecond.items]).toEqual(jobsAll.items);
      expect(
        (
          await r.reads.jobsPage({
            page: 1,
            pageSize: 2,
            cursor: jobsSecond.previousCursor!,
          })
        ).items,
      ).toEqual(jobsFirst.items);
    });
  });
});
