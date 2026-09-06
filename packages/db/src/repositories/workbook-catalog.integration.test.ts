import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  BULK_FORM_COLUMNS,
  prepareWorkbookBase,
  hashBulkFormHeaderContract,
} from "@wukong/shopline";
import { createDatabase } from "../index.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL,
  appUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !appUrl)
  throw new Error(
    "Explicit TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL required",
  );
const admin = postgres(adminUrl, {
  max: 1,
  prepare: false,
  onnotice: () => {},
});
const app = postgres(appUrl, { max: 1, prepare: false });
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const ws = "workbook_" + randomUUID(),
  other = "workbook_other_" + randomUUID();
const row = (id: string, variant = false) =>
  BULK_FORM_COLUMNS.map((c) =>
    c.key === "productId"
      ? id
      : c.key === "sku"
        ? "0001"
        : c.key === "nameEn"
          ? "Synthetic"
          : c.key === "variantId" && variant
            ? "variant-001"
            : "",
  );
const sheet = [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
  row("0009007199254740993123"),
  row("variant", true),
];
const input = () => ({
  filename: "synthetic.xlsx",
  workbookSha256: randomUUID().replaceAll("-", "").repeat(2),
  headerContractSha256: hashBulkFormHeaderContract(),
  sheetName: "Default",
  prepared: prepareWorkbookBase(sheet, "synthetic.xlsx"),
  actorId: ws + "op",
});
beforeAll(async () => {
  await db.migrate();
  await admin`insert into workspaces(id,name,profile) values (${ws},'Synthetic workbook','{}'),(${other},'Other','{}')`;
  await admin`insert into users(id,email) values (${ws + "op"},${ws + "@example.test"}),(${ws + "v"},${ws + "v@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values (${ws},${ws + "op"},'operator'),(${ws},${ws + "v"},'viewer')`;
});
afterAll(async () => {
  await db.close();
  await app.end();
  await admin.end();
});
describe("immutable workbook catalog", () => {
  it("saves with no connection, preserves excluded rows and exact IDs, isolates reads and creates no drafts/platform rows", async () => {
    const data = input();
    expect(data.prepared.products).toHaveLength(1);
    const result = await db.forWorkspace(ws, (r) =>
      r.workbookCatalog.save(data),
    );
    expect(result).toMatchObject({
      importedProducts: 1,
      alreadyImportedProducts: 0,
      excludedRows: 1,
    });
    const [stored] =
      await admin`select * from workbook_imports where id=${result.importId}`;
    expect(stored!.normalized_sheet).toEqual(sheet);
    const [product] =
      await admin`select * from workbook_products where import_id=${result.importId}`;
    const read = await db.forWorkspace(ws, (r) =>
      r.workbookCatalog.getProduct(product!.id),
    );
    expect(read).toMatchObject({
      sourceType: "workbook",
      canExport: false,
      product: { productId: "0009007199254740993123", rowNumber: 3 },
    });
    expect(
      await db.forWorkspace(other, (r) =>
        r.workbookCatalog.getProduct(product!.id),
      ),
    ).toBeNull();
    for (const table of [
      "listing_drafts",
      "platform_products",
      "shopline_connections",
    ])
      expect(
        Number(
          (
            await admin.unsafe(
              `select count(*) n from ${table} where workspace_id=$1`,
              [ws],
            )
          )[0]!.n,
        ),
      ).toBe(0);
  });
  it("concurrent retries produce one import, one product and one counts-only audit", async () => {
    const data = input();
    const results = await Promise.all(
      [0, 1].map(() =>
        db.forWorkspace(ws, (r) => r.workbookCatalog.save(data)),
      ),
    );
    expect(results[0]!.importId).toBe(results[1]!.importId);
    expect(results.map((r) => r.importedProducts).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.alreadyImportedProducts).sort()).toEqual([
      0, 1,
    ]);
    expect(
      Number(
        (
          await admin`select count(*) n from workbook_products where import_id=${results[0]!.importId}`
        )[0]!.n,
      ),
    ).toBe(1);
    const events =
      await admin`select metadata from audit_events where entity_id=${results[0]!.importId}`;
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({
      importedProducts: 1,
      excludedRows: 1,
      totalRows: 2,
    });
  });
  it("denies insufficient repository role and rolls back invalid prepared evidence", async () => {
    await expect(
      db.forWorkspace(ws, (r) =>
        r.workbookCatalog.save({ ...input(), actorId: ws + "v" }),
      ),
    ).rejects.toThrow("operator");
    const data = input();
    data.prepared.products[0]!.productId = "forged";
    await expect(
      db.forWorkspace(ws, (r) => r.workbookCatalog.save(data)),
    ).rejects.toThrow();
    expect(
      Number(
        (
          await admin`select count(*) n from workbook_imports where workbook_sha256=${data.workbookSha256}`
        )[0]!.n,
      ),
    ).toBe(0);
  });
  it("rejects cross-tenant FK writes and update/delete even by owner", async () => {
    const saved = await db.forWorkspace(ws, (r) =>
      r.workbookCatalog.save(input()),
    );
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${other},true)`;
        await tx`insert into workbook_products(workspace_id,import_id,row_number,product) values (${other},${saved.importId},3,${tx.json(input().prepared.products[0]! as never)})`;
      }),
    ).rejects.toThrow();
    for (const table of ["workbook_imports", "workbook_products"]) {
      for (const verb of ["update", "delete"]) {
        const statement =
          verb === "update"
            ? `update ${table} set workspace_id=workspace_id where workspace_id=$1`
            : `delete from ${table} where workspace_id=$1`;
        await expect(
          app.begin(async (tx) => {
            await tx`select set_config('app.workspace_id',${ws},true)`;
            await tx.unsafe(statement, [ws]);
          }),
        ).rejects.toThrow();
        await expect(admin.unsafe(statement, [ws])).rejects.toThrow(
          "immutable",
        );
      }
    }
  });
});
it("rejects extra products and incomplete JSON against a committed source", async () => {
  const data = input(),
    saved = await db.forWorkspace(ws, (r) => r.workbookCatalog.save(data));
  for (const product of [{ ...data.prepared.products[0], rowNumber: 99 }, {}]) {
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into workbook_products(workspace_id,import_id,row_number,product) values (${ws},${saved.importId},99,${tx.json(product as never)})`;
      }),
    ).rejects.toThrow();
  }
});

it("uses PostgreSQL JSON canonicalization for exact product membership", async () => {
  const data = input(),
    saved = await db.forWorkspace(ws, (r) => r.workbookCatalog.save(data));
  const original = data.prepared.products[0]!;
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  await app.begin(async (tx) => {
    await tx`select set_config('app.workspace_id',${ws},true)`;
    await tx`insert into workbook_products(workspace_id,import_id,row_number,product) values (${ws},${saved.importId},${original.rowNumber},${tx.json(reordered as never)}) on conflict do nothing`;
  });
  const { rowNumber, ...missingRow } = original;
  for (const product of [
    missingRow,
    { ...original, title: { en: "Forged", "zh-Hant": null } },
  ]) {
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id',${ws},true)`;
        await tx`insert into workbook_products(workspace_id,import_id,row_number,product) values (${ws},${saved.importId},${rowNumber},${tx.json(product as never)}) on conflict do nothing`;
      }),
    ).rejects.toThrow("immutable source binding");
  }
});
it("separates different file digests and rolls back source, products and audit together", async () => {
  const a = input(),
    b = { ...a, workbookSha256: input().workbookSha256 };
  const first = await db.forWorkspace(ws, (r) => r.workbookCatalog.save(a)),
    second = await db.forWorkspace(ws, (r) => r.workbookCatalog.save(b));
  expect(first.importId).not.toBe(second.importId);
  const rollback = input();
  let rolledBackId = "";
  await expect(
    db.forWorkspace(ws, async (r) => {
      rolledBackId = (await r.workbookCatalog.save(rollback)).importId;
      throw new Error("synthetic rollback");
    }),
  ).rejects.toThrow("synthetic rollback");
  for (const [table, column] of [
    ["workbook_imports", "id"],
    ["workbook_products", "import_id"],
    ["audit_events", "entity_id"],
  ]) {
    expect(
      Number(
        (
          await admin.unsafe(
            `select count(*) n from ${table} where ${column}=$1`,
            [rolledBackId],
          )
        )[0]!.n,
      ),
    ).toBe(0);
  }
});
it("keeps PostgreSQL canonical-size rejection atomic at the compact JSON boundary", async () => {
  const data = input();
  const rows = sheet.map((row) => [...row]);
  const nameColumn = BULK_FORM_COLUMNS.findIndex((c) => c.key === "nameEn");
  rows[2]![nameColumn] = "x".repeat(500000);
  let prepared = prepareWorkbookBase(rows, data.filename);
  const compactBytes = Buffer.byteLength(JSON.stringify(prepared.products[0]));
  rows[2]![nameColumn] = "x".repeat(
    500000 + Math.floor((1024 * 1024 - 10 - compactBytes) / 2),
  );
  prepared = prepareWorkbookBase(rows, data.filename);
  expect(Buffer.byteLength(JSON.stringify(prepared.products[0]))).toBeLessThan(
    1024 * 1024,
  );
  const [canonical] =
    await admin`select octet_length(${admin.json(prepared.products[0]! as never)}::jsonb::text) n`;
  expect(Number(canonical!.n)).toBeGreaterThan(1024 * 1024);
  await expect(
    db.forWorkspace(ws, (r) => r.workbookCatalog.save({ ...data, prepared })),
  ).rejects.toMatchObject({
    cause: {
      code: "23514",
      constraint_name: "workbook_products_check",
    },
  });
  expect(
    Number(
      (
        await admin`select count(*) n from workbook_imports where workbook_sha256=${data.workbookSha256}`
      )[0]!.n,
    ),
  ).toBe(0);
});
it("enforces the 16 MiB PostgreSQL source limit without retaining partial evidence", async () => {
  const data = input(),
    rows = sheet.map((row) => [...row]);
  const column = BULK_FORM_COLUMNS.findIndex((c) => c.key === "summaryEn");
  rows[3]![column] = "x";
  const baseSize = Buffer.byteLength(JSON.stringify(rows));
  rows[3]![column] = "x".repeat(16 * 1024 * 1024 - 10 - baseSize + 1);
  const prepared = prepareWorkbookBase(rows, data.filename);
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(
    16 * 1024 * 1024,
  );
  await expect(
    db.forWorkspace(ws, (r) => r.workbookCatalog.save({ ...data, prepared })),
  ).rejects.toMatchObject({ cause: { code: "23514" } });
  expect(
    Number(
      (
        await admin`select count(*) n from workbook_imports where workbook_sha256=${data.workbookSha256}`
      )[0]!.n,
    ),
  ).toBe(0);
});
