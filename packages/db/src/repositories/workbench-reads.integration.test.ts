import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { createWorkbenchReadRepository } from "./workbench-reads.js";
import type { WorkspaceTransaction } from "../client.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  classifyListing,
  workbenchStateForReason,
  type WorkbenchQuery,
} from "../index.js";
import { buildExportReconciliation } from "../../../../apps/web/lib/export-reconciliation.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error(
    "Explicit TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL required",
  );
const a = new URL(adminUrl),
  b = new URL(appUrl);
if (a.host !== b.host || a.pathname !== b.pathname)
  throw new Error("Test URLs must target the same isolated database");
const admin = postgres(adminUrl, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});
const app = postgres(appUrl, { max: 1, prepare: false });
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const ws = `workbench_${randomUUID()}`,
  other = `workbench_other_${randomUUID()}`;
const at = new Date("2026-09-01T00:00:00Z"),
  readyAt = new Date("2026-09-02T00:00:00Z"),
  receiptAt = new Date("2026-09-03T00:00:00Z");
const statuses = [
  "failed",
  "publish_failed",
  "needs_info",
  "in_review",
  "reopened",
  "approved",
  "received",
  "processing",
  "publishing",
  "published",
  ...Array<string>(21).fill("failed"),
];
const listings = statuses.map((status) => ({
  id: randomUUID(),
  version: randomUUID(),
  status,
}));
const wrongVersion = randomUUID();
const exports = new Map<string, string>();
const page = (query: Partial<WorkbenchQuery> = {}, workspace = ws) =>
  db.forWorkspace(workspace, (r) =>
    r.workbench.page({ state: "attention", page: 1, pageSize: 25, ...query }),
  );
beforeAll(async () => {
  await db.migrate();
  await admin`insert into workspaces(id,name,profile) values (${ws},'Synthetic workbench','{}'),(${other},'Foreign synthetic','{}')`;
  await admin`insert into users(id,email) values (${ws + "op"},${ws + "@example.test"}),(${ws + "viewer"},${ws + "viewer@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${ws},${ws + "op"},'operator'),(${ws},${ws + "viewer"},'viewer')`;
  for (const [index, l] of listings.entries()) {
    await admin`insert into listing_drafts(id,workspace_id,status,updated_at) values (${l.id},${ws},${l.status},${at})`;
    await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${l.version},${ws},${l.id},1,${admin.json(index === 0 ? { title: { "zh-Hant": "合成商品", en: "Synthetic" }, secret: "CONTENT_SENTINEL" } : {})},${ws + "op"})`;
    await admin`update listing_drafts set active_version_id=${l.version} where workspace_id=${ws} and id=${l.id}`;
  }
  await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values (${wrongVersion},${ws},${listings[0]!.id},2,'{}',${ws + "op"})`;
  await admin`insert into listing_pipeline_runs(workspace_id,listing_id,active_version_sequence,idempotency_key,status) values (${ws},${listings[0]!.id},1,'synthetic','failed')`;
  for (const state of ["queued", "running", "ready", "partial", "failed"]) {
    await admin`insert into website_scans(workspace_id,requested_url,requested_by,request_key,state,checkpoint,next_eligible_at,deadline_at,updated_at,dispatch_status) values (${ws},'https://synthetic.test/',${ws + "op"},${state},${state},'{"preview":{"products":[{"title":"CONTENT_SENTINEL"}]}}',${at},${receiptAt},${at},'pending')`;
  }
  for (const count of [2, 7]) {
    await admin`insert into workbook_imports(workspace_id,workbook_sha256,filename,sheet_name,header_contract_sha256,product_bindings,normalized_sheet,spec_version,total_rows,eligible_products,excluded_rows,actor_id,created_at) values (${ws},${String(count).repeat(64)},'synthetic.xlsx','Default',${"a".repeat(64)},'{"CONTENT_SENTINEL":"binding"}','[["CONTENT_SENTINEL"]]','synthetic',${count + 1},${count},1,${ws + "op"},${at})`;
  }
  for (const kind of [
    "failed",
    "pending",
    "legacy",
    "empty",
    "unreported",
    "rejected",
    "corrected",
    "accepted",
  ]) {
    const id = randomUUID();
    exports.set(kind, id);
    const status =
      kind === "legacy"
        ? null
        : ["failed", "pending"].includes(kind)
          ? kind
          : "ready";
    const manifest =
      kind === "empty"
        ? []
        : [
            ...listings.slice(0, 2).map((l) => ({
              listingId: l.id,
              versionId: l.version,
              outcome: "included",
            })),
            {
              listingId: listings[2]!.id,
              versionId: listings[2]!.version,
              outcome: "excluded_no_op",
            },
          ];
    await admin`insert into export_attempts(id,workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version,artifact_status,artifact_ready_at,created_at,artifact_sha256,provenance) values (${id},${ws},${kind},${ws + "op"},${admin.json(manifest)},2,'synthetic',${status},${status === "ready" ? readyAt : null},${at},${"a".repeat(64)},${admin.json({ identityVersion: 1, workspaceId: ws, freshnessAttested: true, manifest, evidence: [] })})`;
    if (["unreported", "rejected", "corrected", "accepted"].includes(kind)) {
      await admin.begin(async (tx) => {
        // Historical adversarial fixture only: current runtime rejects wrong-version receipts.
        // DDL and data roll back together on failure; all FK/check constraints remain enabled.
        if (kind === "unreported")
          await tx`alter table import_results disable trigger import_results_insert_guard`;
        for (const [i, l] of listings.slice(0, 2).entries()) {
          const outcome =
            i === 0 && ["rejected", "corrected"].includes(kind)
              ? "rejected"
              : "accepted";
          const resultId = randomUUID();
          await tx`insert into import_results(id,workspace_id,listing_id,version_id,export_attempt_id,mode,outcome,reject_reason,recorded_by,idempotency_key,revision,created_at) values (${resultId},${ws},${l.id},${i === 0 && kind === "unreported" ? wrongVersion : l.version},${id},'export',${outcome},${outcome === "rejected" ? "synthetic rejection" : null},${ws + "op"},${randomUUID()},1,${receiptAt})`;
          if (i === 0 && kind === "corrected")
            await tx`insert into import_results(workspace_id,listing_id,version_id,export_attempt_id,mode,outcome,recorded_by,idempotency_key,revision,supersedes_result_id,correction_reason,created_at) values (${ws},${l.id},${l.version},${id},'export','accepted',${ws + "op"},${randomUUID()},2,${resultId},'synthetic correction',${readyAt})`;
        }
        if (kind === "unreported")
          await tx`alter table import_results enable trigger import_results_insert_guard`;
      });
    }
  }
  await admin`insert into import_results(workspace_id,listing_id,mode,outcome,recorded_by,idempotency_key,created_at) values (${ws},${listings[0]!.id},'historical_manual','accepted',${ws + "op"},${randomUUID()},${new Date("2026-09-05T00:00:00Z")})`;
  await admin.begin(async (tx) => {
    await tx`alter table import_results disable trigger import_results_insert_guard`;
    await tx`insert into import_results(workspace_id,listing_id,export_attempt_id,mode,outcome,recorded_by,created_at) values (${ws},${listings[0]!.id},${exports.get("unreported")!},'legacy_historical','accepted',${ws + "op"},${new Date("2026-09-05T00:00:00Z")})`;
    await tx`alter table import_results enable trigger import_results_insert_guard`;
  });
  await admin`insert into website_scans(workspace_id,requested_url,requested_by,request_key,state,checkpoint,next_eligible_at,deadline_at) values (${other},'https://foreign.test/','synthetic','foreign','failed','{}',${at},${receiptAt})`;
  await admin`insert into workbook_imports(workspace_id,workbook_sha256,filename,sheet_name,header_contract_sha256,product_bindings,normalized_sheet,spec_version,total_rows,eligible_products,excluded_rows,actor_id,created_at) values (${other},${"f".repeat(64)},'foreign.xlsx','Default',${"a".repeat(64)},'{}','[]','synthetic',9,9,0,'synthetic',${at})`;
  await admin`insert into listing_drafts(workspace_id,status) values (${other},'failed')`;
  await admin`insert into export_attempts(workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version,artifact_status) values (${other},'foreign','synthetic','[]',0,'synthetic','failed')`;
});
afterAll(async () => {
  await db.close();
  await app.end();
  await admin.end();
});

describe("workspace workbench snapshot", () => {
  it("counts retained tasks before pagination and stabilizes equal timestamp ordering", async () => {
    const first = await page(),
      second = await page({ page: 2 });
    expect(first.counts).toEqual({
      attention: 31,
      progress: 6,
      completed: 7,
      unclassified: 2,
    });
    expect(second.counts).toEqual(first.counts);
    expect(first.totalMatching).toBe(31);
    expect(first.items).toHaveLength(25);
    expect(second.items).toHaveLength(6);
    expect(
      new Set([...first.items, ...second.items].map((x) => x.key)).size,
    ).toBe(31);
    expect((await page()).items).toEqual(first.items);
    const all = [...first.items, ...second.items];
    const priorities = {
      failed: 0,
      needs_info: 1,
      review: 2,
      delivery: 3,
      result_needed: 3,
    };
    expect(all).toEqual(
      [...all].sort(
        (a, b) =>
          priorities[a.reason as keyof typeof priorities] -
            priorities[b.reason as keyof typeof priorities] ||
          Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
          a.key.localeCompare(b.key),
      ),
    );
    expect(Date.parse(first.observedAt)).toBeGreaterThan(0);
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(25);
  });
  it("retains counts on empty pages and applies kind to every state count", async () => {
    expect(await page({ page: 999 })).toMatchObject({
      items: [],
      totalMatching: 31,
      counts: { attention: 31, progress: 6, completed: 7, unclassified: 2 },
    });
    expect(await page({ kind: "listing" })).toMatchObject({
      totalMatching: 27,
      counts: { attention: 27, progress: 3, completed: 1, unclassified: 0 },
    });
    expect(await page({ kind: "workbook_import" })).toMatchObject({
      items: [],
      totalMatching: 0,
      counts: { attention: 0, progress: 0, completed: 2, unclassified: 0 },
    });
    expect(await page({}, `empty_${randomUUID()}`)).toMatchObject({
      items: [],
      totalMatching: 0,
      counts: { attention: 0, progress: 0, completed: 0, unclassified: 0 },
    });
  });
  it("matches domain listing classifications without pipeline duplicates or content blobs", async () => {
    const items = (
      await Promise.all(
        ["attention", "progress", "completed", "unclassified"].map((state) =>
          page({ state: state as WorkbenchQuery["state"], pageSize: 100 }),
        ),
      )
    ).flatMap((p) => p.items);
    for (const l of listings)
      expect(items.find((x) => x.id === l.id)).toMatchObject({
        reason: classifyListing(l.status),
        state: workbenchStateForReason(classifyListing(l.status)),
        productCount: 1,
        timestampKind: "updated",
      });
    expect(items.filter((x) => x.kind === "listing")).toHaveLength(31);
    expect(items.find((x) => x.id === listings[0]!.id)?.title).toBe("合成商品");
    expect(items.find((x) => x.id === listings[1]!.id)?.title).toBeNull();
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "key",
          "id",
          "kind",
          "state",
          "reason",
          "title",
          "sourceLabel",
          "productCount",
          "occurredAt",
          "timestampKind",
        ].sort(),
      );
      expect(item.state).toBe(workbenchStateForReason(item.reason));
    }
    expect(JSON.stringify(items)).not.toContain("CONTENT_SENTINEL");
    const workbooks = items.filter((x) => x.kind === "workbook_import");
    expect(workbooks.map((x) => x.productCount).sort()).toEqual([2, 7]);
    expect(
      workbooks.every(
        (x) =>
          x.title === "synthetic.xlsx" &&
          x.reason === "imported" &&
          Date.parse(x.occurredAt) === +at &&
          x.timestampKind === "recorded",
      ),
    ).toBe(true);
    expect(
      items
        .filter((x) => x.kind === "website_scan")
        .map((x) => x.reason)
        .sort(),
    ).toEqual(
      [
        "processing",
        "processing",
        "preview_ready",
        "preview_partial",
        "failed",
      ].sort(),
    );
  });
  it("uses exact included versions and highest receipt revision like reconciliation", async () => {
    const all = (
      await Promise.all(
        ["attention", "progress", "completed", "unclassified"].map((state) =>
          page({ kind: "export", state: state as WorkbenchQuery["state"] }),
        ),
      )
    ).flatMap((p) => p.items);
    for (const [name, id] of exports) {
      const item = all.find((x) => x.id === id)!;
      const expected =
        name === "failed"
          ? "failed"
          : name === "pending"
            ? "processing"
            : ["empty", "legacy"].includes(name)
              ? "unknown"
              : ["corrected", "accepted"].includes(name)
                ? "result_reported"
                : "result_needed";
      expect(item.reason).toBe(expected);
      if (["unreported", "rejected", "corrected", "accepted"].includes(name)) {
        const evidence = await db.forWorkspace(ws, async (r) => ({
          attempt: await r.exportAttempts.getById(id),
          results: await r.importResults.listForExportAttempts([id]),
        }));
        const counts = buildExportReconciliation(
          evidence.attempt!,
          evidence.results,
        ).counts;
        expect(item.productCount).toBe(counts.included);
        expect(item.reason === "result_reported").toBe(
          counts.rejected === 0 && counts.unreported === 0,
        );
        expect(Date.parse(item.occurredAt)).toBe(+receiptAt);
      }
      if (name === "failed")
        expect(item).toMatchObject({ timestampKind: "recorded" });
    }
  });
  it("enforces runtime-role tenant isolation and closed scope", async () => {
    const [role] =
      await app`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const foreign = await page({}, other);
    expect(foreign.totalMatching).toBe(3);
    expect(foreign.counts).toEqual({
      attention: 3,
      progress: 0,
      completed: 1,
      unclassified: 0,
    });
    expect(
      foreign.items.every(
        (x) =>
          !listings.some((l) => l.id === x.id) &&
          ![...exports.values()].includes(x.id),
      ),
    ).toBe(true);
    const repo = await db.forWorkspace(ws, async (r) => r.workbench);
    await expect(
      repo.page({ state: "attention", page: 1, pageSize: 25 }),
    ).rejects.toThrow("closed");
  });
  it("rejects invalid pagination and filters", async () => {
    for (const q of [
      { page: 0 },
      { page: 1.5 },
      { page: Number.MAX_SAFE_INTEGER },
      { pageSize: 101 },
      { pageSize: 0 },
      { pageSize: NaN },
      { state: "bogus" },
      { kind: "bogus" },
    ])
      await expect(page(q as Partial<WorkbenchQuery>)).rejects.toThrow(
        "invalid",
      );
  });
});

it("executes one statement with counts and page under a concurrent commit", async () => {
  const monitor = postgres(adminUrl!, { max: 1, prepare: false });
  let pending: Promise<unknown> | undefined;
  let statements = 0;
  const query = { state: "attention" as const, page: 1, pageSize: 100 };
  const before = await page(query);
  try {
    await admin.begin(async (writer) => {
      await writer`select pg_advisory_xact_lock(99881235)`;
      pending = drizzle(app).transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id',${ws},true)`);
        const wrapped = {
          execute(statement: SQL) {
            statements++;
            return tx.execute(
              sql`with barrier as materialized (select pg_advisory_xact_lock(99881235)) select packet.* from barrier cross join lateral (${statement}) packet`,
            );
          },
        };
        return createWorkbenchReadRepository(
          wrapped as unknown as WorkspaceTransaction,
          ws,
          { assertOpen() {} },
        ).page(query);
      });
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows =
          await monitor`select 1 from pg_stat_activity where wait_event='advisory' and query like '%listing_items%'`;
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await writer`insert into listing_drafts(workspace_id,status) values (${ws},'failed')`;
    });
    const snapshot = (await pending) as Awaited<ReturnType<typeof page>>;
    expect(statements).toBe(1);
    expect(snapshot.counts).toEqual(before.counts);
    expect(snapshot.items).toEqual(before.items);
    const after = await page(query);
    expect(after.totalMatching).toBe(before.totalMatching + 1);
    expect(after.items).toHaveLength(before.items.length + 1);
  } finally {
    if (pending) await pending.catch(() => undefined);
    await monitor.end();
  }
});

it("explains the exact one-statement projection over a multi-page population", async () => {
  await drizzle(app).transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id',${ws},true)`);
    let captured: SQL | undefined;
    let statements = 0;
    const wrapped = {
      execute(statement: SQL) {
        captured = statement;
        statements++;
        return tx.execute(statement);
      },
    };
    const result = await createWorkbenchReadRepository(
      wrapped as unknown as WorkspaceTransaction,
      ws,
      { assertOpen() {} },
    ).page({ state: "attention", page: 2, pageSize: 25 });
    expect(statements).toBe(1);
    expect(result.totalMatching).toBeGreaterThan(25);
    const explained = await tx.execute(
      sql`explain (analyze, buffers, format json) ${captured!}`,
    );
    const plan = explained[0]!["QUERY PLAN"] as Array<{
      Plan: Record<string, unknown>;
      "Execution Time": number;
      "Planning Time": number;
    }>;
    expect(plan[0]!.Plan["Actual Rows"]).toBe(1);
    expect(plan[0]!["Execution Time"]).toBeGreaterThanOrEqual(0);
    console.info(
      JSON.stringify({
        event: "workbench_synthetic_explain",
        statements,
        tasks: result.totalMatching,
        plan: plan[0],
      }),
    );
  });
});
