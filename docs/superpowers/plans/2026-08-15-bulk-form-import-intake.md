# Bulk Form Import Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a parsed SHOPLINE bulk update form into workspace-scoped listing drafts joined to their remote products, so Wukong can act on a catalog that already exists on the platform.

**Architecture:** A new `platform_products` link table stores the remote Product ID, the raw 71-column row snapshot, the `ListingFacts` prefill, and a content digest, following the existing composite-FK + RLS + `wukong_app` grant pattern. A `POST /api/listings/import` route accepts an xlsx body, converts it to a cell matrix through the Node-only adapter, and hands the matrix to an injectable importer service that creates one draft per row inside a single `forWorkspace` transaction. Re-importing the same file is idempotent: rows already linked to a draft refresh their snapshot instead of creating a second draft.

**Tech Stack:** TypeScript 7 (5.9 in `apps/web`), Drizzle ORM + raw SQL migrations, Postgres (Neon) with RLS, Next.js 16 route handlers, Vitest, zod v4.

---

## Prerequisites

The bulk form parser this plan builds on already exists and is verified against the real 500-product export:

- `packages/shopline/src/bulk-form.ts` — `parseBulkForm`, `createBulkFormUpdate`, `BULK_FORM_COLUMNS`, `BulkFormRawRow`, `BulkFormProductRow`
- `packages/shopline/src/bulk-form-xlsx.ts` — `readBulkFormSheet`, `writeBulkFormWorkbook` (Node-only, exported at the `@wukong/shopline/bulk-form-xlsx` subpath)
- `docs/superpowers/specs/2026-08-15-shopline-bulk-form-design.md` — read this before starting

Local Postgres and MinIO are required for the integration tests in Tasks 4 and 6:

```bash
docker compose up -d postgres minio minio-tls mailpit
```

## Deliberate non-goals for this slice

- **Imported drafts are not enqueued.** The normal `POST /api/listings` path enqueues a pipeline job per draft. Importing 500 products must not fire 500 AI runs, so this path creates drafts and stops. Batch enrichment with per-batch cost caps is a separate plan.
- No exporter wiring, no `updateProduct` in publish, no hygiene report UI.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shopline/src/bulk-form-digest.ts` (create) | Stable sha-256 of one raw row, ordered by the column contract. Separate from `bulk-form.ts` so that module stays dependency-free as its spec claims. |
| `packages/shopline/src/bulk-form-digest.test.ts` (create) | Digest stability and sensitivity. |
| `packages/shopline/src/index.ts` (modify) | Export the digest helper. |
| `packages/db/src/schema.ts` (modify) | `platformProducts` table definition. |
| `packages/db/src/platform-products-schema.test.ts` (create) | Column and composite-FK assertions, no Postgres needed. |
| `packages/db/drizzle/0004_platform_products.sql` (create) | DDL, indexes, RLS policy, `wukong_app` grants. |
| `packages/db/src/repositories/platform-products.ts` (create) | Workspace-scoped read/upsert for the link table. |
| `packages/db/src/repositories/platform-products.integration.test.ts` (create) | Round-trip and cross-workspace isolation against real Postgres. |
| `packages/db/src/client.ts` (modify) | Wire the repository into `WorkspaceRepositories`. |
| `packages/db/src/index.ts` (modify) | Export the repository types. |
| `packages/db/src/cli/audit-verify.ts` (modify) | Add `platform_products` to the RLS leak probe, driven by an exported table list. |
| `packages/db/src/cli/audit-verify.test.ts` (modify) | Assert the probe list covers every workspace-scoped table. |
| `apps/web/lib/bulk-form-import.ts` (create) | Importer service: parse → drafts → link rows → audit, injectable. |
| `apps/web/lib/bulk-form-import.test.ts` (create) | Service behaviour against fake repositories. |
| `apps/web/app/api/listings/import/route.ts` (create) | Handler factory + concrete binding. |
| `apps/web/app/api/listings/import/route.test.ts` (create) | Role, body, and error mapping. |
| `docs/runbooks/shopline-pilot-onboarding.md` (modify) | Operator steps for a catalog import. |

---

### Task 1: Row content digest

**Files:**
- Create: `packages/shopline/src/bulk-form-digest.ts`
- Create: `packages/shopline/src/bulk-form-digest.test.ts`
- Modify: `packages/shopline/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shopline/src/bulk-form-digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { BULK_FORM_COLUMNS, parseBulkForm, type BulkFormColumnKey } from "./bulk-form.js";
import { hashBulkFormRow } from "./bulk-form-digest.js";

const HEADER_EN = BULK_FORM_COLUMNS.map((column) => column.en);
const HEADER_ZH = BULK_FORM_COLUMNS.map((column) => column.zh);

const DEFAULTS: Partial<Record<BulkFormColumnKey, string>> = {
  productId: "aaaaaaaaaaaaaaaaaaaaaa01",
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "Demo Estate Riesling 2024",
  sku: "0001",
  regularPrice: "100.0",
  salePrice: "80.0",
  quantity: "6",
  updateQuantity: "+0",
  onlineStoreCategories: "White Wine>Germany>Mosel",
};

const rowFor = (overrides: Partial<Record<BulkFormColumnKey, string>> = {}) =>
  BULK_FORM_COLUMNS.map((column) => overrides[column.key] ?? DEFAULTS[column.key] ?? "");

const rawRowFor = (overrides: Partial<Record<BulkFormColumnKey, string>> = {}) => {
  const parsed = parseBulkForm([HEADER_EN, HEADER_ZH, rowFor(overrides)]);
  const row = parsed.rows[0];
  if (row === undefined) throw new Error("fixture row did not parse");
  return row.raw;
};

describe("hashBulkFormRow", () => {
  it("returns the same digest for the same cells", () => {
    expect(hashBulkFormRow(rawRowFor())).toBe(hashBulkFormRow(rawRowFor()));
  });

  it("ignores object key insertion order", () => {
    const raw = rawRowFor();
    const reversed = Object.fromEntries(
      Object.entries(raw).reverse(),
    ) as typeof raw;

    expect(hashBulkFormRow(reversed)).toBe(hashBulkFormRow(raw));
  });

  it("changes when any cell changes", () => {
    const baseline = hashBulkFormRow(rawRowFor());

    expect(hashBulkFormRow(rawRowFor({ nameZh: "示範酒莊麗絲玲 2024" }))).not.toBe(baseline);
    expect(hashBulkFormRow(rawRowFor({ salePrice: "70.0" }))).not.toBe(baseline);
  });

  it("emits a hex sha-256", () => {
    expect(hashBulkFormRow(rawRowFor())).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/shopline test bulk-form-digest
```

Expected: FAIL — `Failed to resolve import "./bulk-form-digest.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shopline/src/bulk-form-digest.ts`:

```ts
import { createHash } from "node:crypto";

import { BULK_FORM_COLUMNS, type BulkFormRawRow } from "./bulk-form.js";

/**
 * Stable digest of one bulk-form row, used to tell an unchanged re-import from a
 * real catalog change.
 *
 * Cell order comes from the column contract rather than object key order, so a
 * snapshot taken today and one rebuilt from a fresh export hash identically when
 * the merchant changed nothing. Lives outside `bulk-form.ts` to keep that module
 * dependency-free, as its design doc states.
 */
export function hashBulkFormRow(raw: BulkFormRawRow): string {
  const ordered = BULK_FORM_COLUMNS.map((column) => [column.key, raw[column.key] ?? null]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
```

- [ ] **Step 4: Export it from the package barrel**

In `packages/shopline/src/index.ts` there are two blocks ending in `from "./bulk-form.js";` — a value export and a type export. Add this line immediately after the second one (the `export type { ... }` block):

```ts
export { hashBulkFormRow } from "./bulk-form-digest.js";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @wukong/shopline test
```

Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add packages/shopline/src/bulk-form-digest.ts packages/shopline/src/bulk-form-digest.test.ts packages/shopline/src/index.ts
git commit -m "feat(shopline): add bulk form row digest"
```

---

### Task 2: platform_products schema

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/platform-products-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/platform-products-schema.test.ts`:

```ts
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { listingDrafts, platformProducts, shoplineConnections } from "./schema.js";

const foreignKeysOf = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      columns: reference.columns.map((column) => column.name),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      foreignTable: reference.foreignTable,
      onDelete: foreignKey.onDelete,
    };
  });

describe("platform product schema", () => {
  it("stores the remote identity, the row snapshot, and the facts prefill", () => {
    const columns = getTableColumns(platformProducts);

    expect(columns.remoteProductId.notNull).toBe(true);
    expect(columns.sku.notNull).toBe(true);
    expect(columns.specVersion.notNull).toBe(true);
    expect(columns.rawRow.notNull).toBe(true);
    expect(columns.factsPrefill.notNull).toBe(true);
    expect(columns.contentDigest.notNull).toBe(true);
  });

  it("allows a link row that has no draft yet", () => {
    expect(getTableColumns(platformProducts).listingId.notNull).toBe(false);
  });

  it("keeps the connection and draft references tenant scoped", () => {
    const foreignKeys = foreignKeysOf(platformProducts);

    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "connection_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: shoplineConnections,
      onDelete: "cascade",
    });
    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "listing_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: listingDrafts,
      onDelete: "cascade",
    });
  });

  it("admits one row per remote product per connection", () => {
    const uniqueIndexes = getTableConfig(platformProducts)
      .indexes.filter((index) => index.config.unique)
      .map((index) => index.config.columns.map((column) => (column as { name: string }).name));

    expect(uniqueIndexes).toContainEqual(["workspace_id", "id"]);
    expect(uniqueIndexes).toContainEqual(["workspace_id", "connection_id", "remote_product_id"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/db test platform-products-schema
```

Expected: FAIL — `platformProducts` is not exported from `./schema.js`.

- [ ] **Step 3: Add the table**

In `packages/db/src/schema.ts`, add the following immediately after the `shoplineConnections` table definition (both referenced tables are declared above that point):

```ts
export const platformProducts = pgTable("platform_products", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  connectionId: uuid("connection_id").notNull(),
  /** The platform's own product ID — the join key a listing has never carried. */
  remoteProductId: text("remote_product_id").notNull(),
  sku: text("sku").notNull(),
  /** Null until a draft is created for this product. */
  listingId: uuid("listing_id"),
  specVersion: text("spec_version").notNull(),
  rawRow: jsonb("raw_row").$type<Record<string, string | null>>().notNull(),
  factsPrefill: jsonb("facts_prefill").$type<ListingFacts>().notNull(),
  contentDigest: text("content_digest").notNull(),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("platform_products_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("platform_products_workspace_connection_remote_uq").on(
    table.workspaceId,
    table.connectionId,
    table.remoteProductId,
  ),
  index("platform_products_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("platform_products_workspace_sku_idx").on(table.workspaceId, table.sku),
  foreignKey({
    name: "platform_products_workspace_connection_fkey",
    columns: [table.workspaceId, table.connectionId],
    foreignColumns: [shoplineConnections.workspaceId, shoplineConnections.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "platform_products_workspace_listing_fkey",
    columns: [table.workspaceId, table.listingId],
    foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
  }).onDelete("cascade"),
]);
```

`rawRow` is typed as `Record<string, string | null>` rather than `BulkFormRawRow` so the schema stays connector-neutral; the precise type is applied at the repository boundary in Task 4.

- [ ] **Step 4: Import ListingFacts if it is not already imported**

Check the top of `packages/db/src/schema.ts`. If `ListingFacts` is absent from the `@wukong/core` type import, add it:

```ts
import type { CanonicalListing, ListingFacts } from "@wukong/core";
```

Also confirm `index`, `uniqueIndex`, `foreignKey`, `jsonb`, `uuid`, and `text` are already in the `drizzle-orm/pg-core` import list at the top of the file. They are used by existing tables, so all six should already be present.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @wukong/db test platform-products-schema
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/platform-products-schema.test.ts
git commit -m "feat(db): add platform products link table schema"
```

---

### Task 3: platform_products migration

**Files:**
- Create: `packages/db/drizzle/0004_platform_products.sql`

The composite foreign keys require unique indexes on the referenced columns. Both already exist: `shopline_connections_workspace_id_uq` and `listing_drafts_workspace_id_uq`.

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0004_platform_products.sql`:

```sql
CREATE TABLE IF NOT EXISTS platform_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  remote_product_id text NOT NULL,
  sku text NOT NULL,
  listing_id uuid,
  spec_version text NOT NULL,
  raw_row jsonb NOT NULL,
  facts_prefill jsonb NOT NULL,
  content_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_products_workspace_connection_fkey
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES shopline_connections (workspace_id, id)
    ON DELETE CASCADE,
  -- Restrict, not cascade: this row mirrors a product that exists on the
  -- platform whether or not Wukong keeps a draft, and its digest is the only
  -- thing that tells an unchanged re-import from a real catalog change.
  CONSTRAINT platform_products_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_products_workspace_id_uq
  ON platform_products (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS platform_products_workspace_connection_remote_uq
  ON platform_products (workspace_id, connection_id, remote_product_id);
CREATE INDEX IF NOT EXISTS platform_products_workspace_listing_idx
  ON platform_products (workspace_id, listing_id);

ALTER TABLE platform_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_products FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_products_workspace_policy ON platform_products;
CREATE POLICY platform_products_workspace_policy ON platform_products
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform_products TO wukong_app;
```

- [ ] **Step 2: Apply the migration**

```bash
pnpm --filter @wukong/db db:migrate
```

Expected: exits 0 with no error output.

- [ ] **Step 3: Verify RLS and grants landed**

```bash
psql "$DATABASE_URL" -c "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'platform_products';" -c "select polname from pg_policies join pg_class on pg_class.relname = tablename where tablename = 'platform_products';"
```

Expected: `relrowsecurity` and `relforcerowsecurity` both `t`; one policy named `platform_products_workspace_policy`.

- [ ] **Step 4: Verify the migration is idempotent**

```bash
pnpm --filter @wukong/db db:migrate
```

Expected: exits 0 again with no error — every statement is `IF NOT EXISTS` or `DROP ... IF EXISTS` guarded.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0004_platform_products.sql
git commit -m "feat(db): migrate platform products table with rls"
```

---

### Task 4: platform products repository

**Files:**
- Create: `packages/db/src/repositories/platform-products.ts`
- Create: `packages/db/src/repositories/platform-products.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/repositories/platform-products.integration.test.ts`. The
harness below mirrors `listings.integration.test.ts`: same env-var URLs, same
`wukong_app` role bootstrap, same truncate. It additionally seeds two workspaces
and one SHOPLINE connection each, because `platform_products` has a composite
foreign key onto `shopline_connections`.

```ts
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ListingFacts } from "@wukong/core";

import { createDatabase } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

const workspaceId = "ws_import";
const otherWorkspaceId = "ws_import_other";
const connectionId = "11111111-1111-4111-8111-111111111111";
const otherConnectionId = "22222222-2222-4222-8222-222222222222";

const factsFixture: ListingFacts = {
  sku: "0001",
  producer: null,
  productType: "wine",
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: 100,
  stockQuantity: 6,
  criticScores: [],
  awards: [],
};

describe("platform product repository", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: ignoreNotice, prepare: false });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  beforeAll(async () => {
    await admin.unsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
          CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await database.migrate();
    await admin.unsafe("TRUNCATE TABLE workspaces, users CASCADE");
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${workspaceId}', '${workspaceId}', '{}'::jsonb),
        ('${otherWorkspaceId}', '${otherWorkspaceId}', '{}'::jsonb);
      INSERT INTO shopline_connections (id, workspace_id, shop_domain, encrypted_access_token) VALUES
        ('${connectionId}', '${workspaceId}', 'import-test.example', 'token'),
        ('${otherConnectionId}', '${otherWorkspaceId}', 'other-test.example', 'token');
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("inserts a link row and reads it back by remote product id", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({ target: "shopline", note: null });
      const upserted = await repositories.platformProducts.upsert({
        connectionId,
        remoteProductId: "aaaaaaaaaaaaaaaaaaaaaa01",
        sku: "0001",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        rawRow: { productId: "aaaaaaaaaaaaaaaaaaaaaa01", sku: "0001" },
        factsPrefill: factsFixture,
        contentDigest: "a".repeat(64),
      });

      expect(upserted.remoteProductId).toBe("aaaaaaaaaaaaaaaaaaaaaa01");
      expect(upserted.listingId).toBe(draft.id);

      const found = await repositories.platformProducts.listByRemoteProductIds(connectionId, [
        "aaaaaaaaaaaaaaaaaaaaaa01",
      ]);
      expect(found).toHaveLength(1);
      expect(found[0]?.sku).toBe("0001");
      expect(found[0]?.contentDigest).toBe("a".repeat(64));
    });
  });

  it("refreshes the snapshot instead of duplicating the remote product", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({ target: "shopline", note: null });
      const base = {
        connectionId,
        remoteProductId: "aaaaaaaaaaaaaaaaaaaaaa02",
        sku: "0002",
        listingId: draft.id,
        specVersion: "opak-2026-05",
        factsPrefill: factsFixture,
      };

      await repositories.platformProducts.upsert({
        ...base,
        rawRow: { sku: "0002", nameZh: "0002" },
        contentDigest: "b".repeat(64),
      });
      await repositories.platformProducts.upsert({
        ...base,
        rawRow: { sku: "0002", nameZh: "示範" },
        contentDigest: "c".repeat(64),
      });

      const found = await repositories.platformProducts.listByRemoteProductIds(connectionId, [
        "aaaaaaaaaaaaaaaaaaaaaa02",
      ]);
      expect(found).toHaveLength(1);
      expect(found[0]?.contentDigest).toBe("c".repeat(64));
      expect(found[0]?.listingId).toBe(draft.id);
    });
  });

  it("returns an empty list rather than querying when no ids are asked for", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      expect(await repositories.platformProducts.listByRemoteProductIds(connectionId, [])).toEqual([]);
    });
  });

  it("never returns another workspace's link rows", async () => {
    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const found = await repositories.platformProducts.listByRemoteProductIds(connectionId, [
        "aaaaaaaaaaaaaaaaaaaaaa01",
      ]);
      expect(found).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/db exec vitest run src/repositories/platform-products.integration.test.ts
```

Expected: FAIL — `repositories.platformProducts` is undefined.

- [ ] **Step 3: Write the repository**

Create `packages/db/src/repositories/platform-products.ts`:

```ts
import { and, desc, eq, inArray } from "drizzle-orm";

import type { ListingFacts } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { platformProducts } from "../schema.js";

export type PlatformProduct = {
  id: string;
  connectionId: string;
  remoteProductId: string;
  sku: string;
  listingId: string | null;
  specVersion: string;
  rawRow: Record<string, string | null>;
  factsPrefill: ListingFacts;
  contentDigest: string;
};

export type UpsertPlatformProductInput = {
  connectionId: string;
  remoteProductId: string;
  sku: string;
  /**
   * The caller supplies the draft this product is linked to, including when it
   * is re-supplying an existing one. An upsert that passed null here would
   * unlink a product that already has a draft.
   */
  listingId: string | null;
  specVersion: string;
  rawRow: Record<string, string | null>;
  factsPrefill: ListingFacts;
  /**
   * MUST be `hashBulkFormRow(rawRow)`. A digest that disagrees with its row
   * reads as "unchanged" on the next import, which is a silent false negative
   * in the only mechanism that detects a real catalog change. The repository
   * cannot derive it here without coupling `@wukong/db` to a specific
   * connector's row type, so the importer owns the invariant and its tests
   * assert it.
   */
  contentDigest: string;
};

export type PlatformProductRepository = {
  upsert(input: UpsertPlatformProductInput): Promise<PlatformProduct>;
  listByRemoteProductIds(
    connectionId: string,
    remoteProductIds: readonly string[],
  ): Promise<PlatformProduct[]>;
  listRecent(limit?: number): Promise<PlatformProduct[]>;
};

const COLUMNS = {
  id: platformProducts.id,
  connectionId: platformProducts.connectionId,
  remoteProductId: platformProducts.remoteProductId,
  sku: platformProducts.sku,
  listingId: platformProducts.listingId,
  specVersion: platformProducts.specVersion,
  rawRow: platformProducts.rawRow,
  factsPrefill: platformProducts.factsPrefill,
  contentDigest: platformProducts.contentDigest,
};

export function createPlatformProductRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): PlatformProductRepository {
  return {
    async upsert(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(platformProducts)
        .values({ workspaceId, ...input })
        .onConflictDoUpdate({
          target: [
            platformProducts.workspaceId,
            platformProducts.connectionId,
            platformProducts.remoteProductId,
          ],
          set: {
            sku: input.sku,
            listingId: input.listingId,
            specVersion: input.specVersion,
            rawRow: input.rawRow,
            factsPrefill: input.factsPrefill,
            contentDigest: input.contentDigest,
            updatedAt: new Date(),
          },
        })
        .returning(COLUMNS);
      if (!row) throw new Error("platform product upsert did not return a row");
      return row;
    },

    async listByRemoteProductIds(connectionId, remoteProductIds) {
      scope.assertOpen();
      if (remoteProductIds.length === 0) return [];
      return transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            eq(platformProducts.connectionId, connectionId),
            inArray(platformProducts.remoteProductId, [...remoteProductIds]),
          ),
        );
    },

    async listRecent(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("platform product limit must be between 1 and 1000");
      }
      return transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(eq(platformProducts.workspaceId, workspaceId))
        .orderBy(desc(platformProducts.updatedAt))
        .limit(limit);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they still fail on wiring only**

```bash
pnpm --filter @wukong/db exec vitest run src/repositories/platform-products.integration.test.ts
```

Expected: still FAIL — the repository exists but is not on `WorkspaceRepositories` yet. Task 5 wires it.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/platform-products.ts packages/db/src/repositories/platform-products.integration.test.ts
git commit -m "feat(db): add platform product repository"
```

---

### Task 5: Wire the repository into the workspace scope

**Files:**
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Import the factory**

In `packages/db/src/client.ts`, next to the other repository imports, add:

```ts
import {
  createPlatformProductRepository,
  type PlatformProductRepository,
} from "./repositories/platform-products.js";
```

- [ ] **Step 2: Add it to the repositories type**

In the same file, add one line to `WorkspaceRepositories`:

```ts
export type WorkspaceRepositories = {
  listings: ListingRepository;
  sourceAssets: SourceAssetRepository;
  publishJobs: PublishJobRepository;
  shoplineConnections: ShoplineConnectionRepository;
  platformProducts: PlatformProductRepository;
  pipelineRuns: PipelineRunRepository;
  aiRuns: AiRunRepository;
  workspaces: WorkspaceRepository;
  audit: WorkspaceAuditWriter;
};
```

- [ ] **Step 3: Construct it inside forWorkspace**

In the `repositories` object literal inside `runForWorkspace`, after the `shoplineConnections` entry, add:

```ts
        platformProducts: createPlatformProductRepository(
          transaction,
          workspaceId,
          scope,
        ),
```

- [ ] **Step 4: Export the types**

In `packages/db/src/index.ts`, after the `ShoplineConnection` export line, add:

```ts
export type {
  PlatformProduct,
  PlatformProductRepository,
  UpsertPlatformProductInput,
} from "./repositories/platform-products.js";
```

- [ ] **Step 5: Run the integration tests to verify they pass**

```bash
pnpm --filter @wukong/db exec vitest run src/repositories/platform-products.integration.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm lint
```

Expected: 14 successful tasks.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/client.ts packages/db/src/index.ts
git commit -m "feat(db): expose platform products in workspace scope"
```

---

### Task 6: Keep the audit RLS probe honest

`audit:verify` is a release gate that must report zero accessible foreign records. Its probe is a hand-written UNION, so a new tenant table silently weakens the gate. Drive the probe from an exported list and test that list against the schema.

**Files:**
- Modify: `packages/db/src/cli/audit-verify.ts`
- Modify: `packages/db/src/cli/audit-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/cli/audit-verify.test.ts`:

```ts
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "../schema.js";
import { TENANT_TABLES } from "./audit-verify.js";

describe("tenant table probe list", () => {
  it("covers every workspace-scoped table in the schema", () => {
    const scoped = Object.values(schema)
      .filter((value): value is Parameters<typeof getTableConfig>[0] => {
        try {
          return "workspaceId" in getTableColumns(value as never);
        } catch {
          return false;
        }
      })
      .map((table) => getTableConfig(table).name)
      .sort();

    expect([...TENANT_TABLES].sort()).toEqual(scoped);
  });

  it("includes the platform products link table", () => {
    expect(TENANT_TABLES).toContain("platform_products");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/db exec vitest run src/cli/audit-verify.test.ts
```

Expected: FAIL — `TENANT_TABLES` is not exported.

- [ ] **Step 3: Export the list and build the probe from it**

In `packages/db/src/cli/audit-verify.ts`, add below `REQUIRED_AUDIT_SEQUENCE`:

```ts
/**
 * Every workspace-scoped table. The RLS leak probe is generated from this list
 * so adding a tenant table cannot silently narrow the release gate. Names are
 * literals from this module, never user input, so interpolating them is safe.
 */
export const TENANT_TABLES = [
  "memberships",
  "workspace_invites",
  "listing_drafts",
  "listing_versions",
  "source_assets",
  "field_evidence",
  "compliance_flags",
  "prompt_versions",
  "ai_runs",
  "shopline_connections",
  "platform_products",
  "publish_jobs",
  "review_events",
  "audit_events",
  "listing_pipeline_runs",
  "listing_pipeline_steps",
] as const;
```

Then replace the hand-written `foreignRows` query with:

```ts
      // Probe every tenant-scoped table, not only rows linked to this draft. RLS
      // should make all rows with another workspace invisible to the runtime role.
      // Running with an admin URL intentionally exposes any leaked foreign rows.
      const probe = [
        `select 'workspaces' as source, count(*)::bigint as count from workspaces where id <> $1`,
        ...TENANT_TABLES.map(
          (table) =>
            `select '${table}', count(*) from ${table} where workspace_id <> $1`,
        ),
      ].join(" union all ");
      const foreignRows = await transaction.unsafe<{ source: string; count: number }[]>(
        `select source, count::int from (${probe}) as counts where count > 0`,
        [input.workspaceId],
      );
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @wukong/db exec vitest run src/cli/audit-verify.test.ts
```

Expected: PASS, including the two new cases.

If the first new test fails listing a table you did not expect, do not delete the assertion — add the missing table to `TENANT_TABLES`. That mismatch is the bug the test exists to catch.

- [ ] **Step 5: Run the audit-verify integration test**

```bash
pnpm --filter @wukong/db exec vitest run src/cli/audit-verify.integration.test.ts
```

Expected: PASS — the generated probe must behave exactly like the literal UNION it replaced.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/cli/audit-verify.ts packages/db/src/cli/audit-verify.test.ts
git commit -m "fix(db): generate audit rls probe from the tenant table list"
```

---

### Task 7: Import service

**Files:**
- Create: `apps/web/lib/bulk-form-import.ts`
- Create: `apps/web/lib/bulk-form-import.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/bulk-form-import.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { BULK_FORM_COLUMNS, type BulkFormColumnKey } from "@wukong/shopline";

import { createBulkFormImporter } from "./bulk-form-import";

const HEADER_EN = BULK_FORM_COLUMNS.map((column) => column.en);
const HEADER_ZH = BULK_FORM_COLUMNS.map((column) => column.zh);

const DEFAULTS: Partial<Record<BulkFormColumnKey, string>> = {
  productId: "remote_1",
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "Demo Estate Riesling 2024",
  sku: "0001",
  regularPrice: "100.0",
  salePrice: "80.0",
  quantity: "6",
  updateQuantity: "+0",
  onlineStoreCategories: "White Wine>Germany>Mosel",
};

const rowFor = (overrides: Partial<Record<BulkFormColumnKey, string>> = {}) =>
  BULK_FORM_COLUMNS.map((column) => overrides[column.key] ?? DEFAULTS[column.key] ?? "");

const sheetOf = (...rows: string[][]) => [HEADER_EN, HEADER_ZH, ...rows];

type Recorded = {
  created: { note: string | null }[];
  upserts: { remoteProductId: string; listingId: string | null; contentDigest: string }[];
  audits: { action: string; entityId: string }[];
};

function importerWith(existing: Record<string, { listingId: string; contentDigest: string }> = {}) {
  const recorded: Recorded = { created: [], upserts: [], audits: [] };
  let nextDraft = 0;

  const importBulkForm = createBulkFormImporter({
    getDatabase: () =>
      ({
        async forWorkspace<T>(_workspaceId: string, work: (repositories: any) => Promise<T>) {
          return work({
            shoplineConnections: {
              async getDefault() {
                return { id: "connection_1" };
              },
            },
            platformProducts: {
              async listByRemoteProductIds(_connectionId: string, ids: string[]) {
                return ids
                  .filter((id) => existing[id] !== undefined)
                  .map((id) => ({ remoteProductId: id, ...existing[id] }));
              },
              async upsert(input: Recorded["upserts"][number]) {
                recorded.upserts.push(input);
                return input;
              },
            },
            listings: {
              async create(input: { note: string | null }) {
                recorded.created.push(input);
                nextDraft += 1;
                return { id: `draft_${nextDraft}` };
              },
            },
            audit: {
              async write(event: Recorded["audits"][number]) {
                recorded.audits.push(event);
              },
            },
          });
        },
      }) as never,
  });

  return { importBulkForm, recorded };
}

describe("bulk form importer", () => {
  it("creates one draft per parsed row and links it to the remote product", async () => {
    const { importBulkForm, recorded } = importerWith();

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor(), rowFor({ productId: "remote_2", sku: "0002" })),
    });

    expect(result.parsedRows).toBe(2);
    expect(result.createdDrafts).toBe(2);
    expect(result.refreshedProducts).toBe(0);
    expect(recorded.created).toHaveLength(2);
    expect(recorded.upserts.map((upsert) => upsert.listingId)).toEqual(["draft_1", "draft_2"]);
  });

  it("writes an audit event per created draft", async () => {
    const { importBulkForm, recorded } = importerWith();

    await importBulkForm({ workspaceId: "ws_opak", actorId: "user_1", sheet: sheetOf(rowFor()) });

    expect(recorded.audits).toEqual([
      expect.objectContaining({ action: "listing.imported", entityId: "draft_1" }),
    ]);
  });

  it("keeps an already-imported product on its existing draft", async () => {
    const { importBulkForm, recorded } = importerWith({
      remote_1: { listingId: "draft_existing", contentDigest: "stale" },
    });

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor()),
    });

    expect(result.createdDrafts).toBe(0);
    expect(result.refreshedProducts).toBe(1);
    expect(recorded.created).toEqual([]);
    expect(recorded.upserts[0]?.listingId).toBe("draft_existing");
  });

  it("does not count an unchanged re-import as a refresh", async () => {
    const first = importerWith();
    await first.importBulkForm({ workspaceId: "ws_opak", actorId: "user_1", sheet: sheetOf(rowFor()) });
    const digest = first.recorded.upserts[0]?.contentDigest ?? "";

    const second = importerWith({ remote_1: { listingId: "draft_existing", contentDigest: digest } });
    const result = await second.importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor()),
    });

    expect(result.createdDrafts).toBe(0);
    expect(result.refreshedProducts).toBe(0);
  });

  it("reports parse warnings without dropping the import", async () => {
    const { importBulkForm } = importerWith();

    const result = await importBulkForm({
      workspaceId: "ws_opak",
      actorId: "user_1",
      sheet: sheetOf(rowFor({ quantity: "-1" })),
    });

    expect(result.createdDrafts).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain("quantity_negative");
  });

  it("rejects a sheet with no readable rows", async () => {
    const { importBulkForm } = importerWith();

    await expect(
      importBulkForm({ workspaceId: "ws_opak", actorId: "user_1", sheet: [["nonsense"]] }),
    ).rejects.toThrow(/No product rows/);
  });

  it("rejects an import when no SHOPLINE connection exists", async () => {
    const importBulkForm = createBulkFormImporter({
      getDatabase: () =>
        ({
          async forWorkspace<T>(_workspaceId: string, work: (repositories: any) => Promise<T>) {
            return work({ shoplineConnections: { async getDefault() { return null; } } });
          },
        }) as never,
    });

    await expect(
      importBulkForm({ workspaceId: "ws_opak", actorId: "user_1", sheet: sheetOf(rowFor()) }),
    ).rejects.toThrow(/Connect a SHOPLINE store/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts
```

Expected: FAIL — cannot resolve `./bulk-form-import`.

- [ ] **Step 3: Write the service**

Create `apps/web/lib/bulk-form-import.ts`:

```ts
import type { Database } from "@wukong/db";
import {
  hashBulkFormRow,
  parseBulkForm,
  type BulkFormIssue,
  type BulkFormSheet,
} from "@wukong/shopline";

import { ApiError } from "./route-support";

export type BulkFormImportDeps = { getDatabase(): Database };

export type BulkFormImportInput = {
  workspaceId: string;
  actorId: string;
  sheet: BulkFormSheet;
};

export type BulkFormImportResult = {
  specVersion: string;
  parsedRows: number;
  createdDrafts: number;
  refreshedProducts: number;
  issues: BulkFormIssue[];
};

/**
 * Turns a parsed bulk update form into drafts joined to their remote products.
 *
 * Deliberately does not enqueue the AI pipeline. The normal intake path enqueues
 * one job per draft, which for a 500-product catalog would be 500 uncapped AI
 * runs. Enrichment is a separate, budgeted batch.
 */
export function createBulkFormImporter(deps: BulkFormImportDeps) {
  return async function importBulkForm(
    input: BulkFormImportInput,
  ): Promise<BulkFormImportResult> {
    const parsed = parseBulkForm(input.sheet);
    if (parsed.rows.length === 0) {
      throw new ApiError(
        422,
        "bulk_form_unreadable",
        "No product rows could be read from this bulk update form.",
      );
    }

    return deps.getDatabase().forWorkspace(input.workspaceId, async (repositories) => {
      const connection = await repositories.shoplineConnections.getDefault();
      if (!connection) {
        throw new ApiError(
          409,
          "shopline_connection_missing",
          "Connect a SHOPLINE store before importing a catalog.",
        );
      }

      const known = await repositories.platformProducts.listByRemoteProductIds(
        connection.id,
        parsed.rows.map((row) => row.productId),
      );
      const knownByRemoteId = new Map(known.map((product) => [product.remoteProductId, product]));

      let createdDrafts = 0;
      let refreshedProducts = 0;

      for (const row of parsed.rows) {
        const prior = knownByRemoteId.get(row.productId);
        const contentDigest = hashBulkFormRow(row.raw);
        let listingId = prior?.listingId ?? null;

        if (listingId === null) {
          const draft = await repositories.listings.create({
            target: "shopline",
            note: `Imported from SHOPLINE bulk update form ${parsed.specVersion}, row ${row.rowNumber}`,
          });
          listingId = draft.id;
          createdDrafts += 1;
          // Metadata carries identifiers only — never merchant content.
          await repositories.audit.write({
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            entityId: draft.id,
            action: "listing.imported",
            metadata: {
              remoteProductId: row.productId,
              specVersion: parsed.specVersion,
              sourceRow: row.rowNumber,
            },
          });
        } else if (prior !== undefined && prior.contentDigest !== contentDigest) {
          refreshedProducts += 1;
        }

        await repositories.platformProducts.upsert({
          connectionId: connection.id,
          remoteProductId: row.productId,
          sku: row.sku,
          listingId,
          specVersion: parsed.specVersion,
          // Spread rather than pass through: `row.raw` is a readonly mapped type
          // and the repository takes a plain mutable record.
          rawRow: { ...row.raw },
          factsPrefill: row.facts,
          contentDigest,
        });
      }

      return {
        specVersion: parsed.specVersion,
        parsedRows: parsed.rows.length,
        createdDrafts,
        refreshedProducts,
        issues: [...parsed.issues],
      };
    });
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/bulk-form-import.ts apps/web/lib/bulk-form-import.test.ts
git commit -m "feat(web): add bulk form import service"
```

---

### Task 8: Import route

**Files:**
- Create: `apps/web/app/api/listings/import/route.ts`
- Create: `apps/web/app/api/listings/import/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/api/listings/import/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createBulkFormImportHandler } from "./route.js";

const okResult = {
  specVersion: "opak-2026-05",
  parsedRows: 2,
  createdDrafts: 2,
  refreshedProducts: 0,
  issues: [],
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  overrides: Partial<Parameters<typeof createBulkFormImportHandler>[0]> = {},
) {
  return createBulkFormImportHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    readSheet: () => [["a"]],
    importBulkForm: async () => okResult,
    ...overrides,
  });
}

const requestWith = (body: Uint8Array) =>
  new Request("http://localhost/api/listings/import", { method: "POST", body });

describe("POST /api/listings/import", () => {
  it("imports for an operator and returns the counts", async () => {
    const response = await handlerFor("operator")(requestWith(new Uint8Array([1, 2, 3])));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      specVersion: "opak-2026-05",
      parsedRows: 2,
      createdDrafts: 2,
      refreshedProducts: 0,
    });
  });

  it("refuses a viewer", async () => {
    const response = await handlerFor("viewer")(requestWith(new Uint8Array([1])));

    expect(response.status).toBe(403);
  });

  it("rejects an empty upload", async () => {
    const response = await handlerFor("operator")(requestWith(new Uint8Array()));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("empty_upload");
  });

  it("rejects an upload that is not a readable workbook", async () => {
    const handler = handlerFor("operator", {
      readSheet: () => {
        throw new Error("file is not a zip container");
      },
    });

    const response = await handler(requestWith(new Uint8Array([9, 9, 9])));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("bulk_form_unreadable");
  });

  it("caps the number of issues it echoes back", async () => {
    const handler = handlerFor("operator", {
      importBulkForm: async () => ({
        ...okResult,
        issues: Array.from({ length: 250 }, () => ({
          code: "quantity_negative" as const,
          severity: "warning" as const,
          row: 3,
          column: "quantity" as const,
          value: "-1",
          message: "negative stock clamped to 0",
        })),
      }),
    });

    const response = await handler(requestWith(new Uint8Array([1])));

    expect((await response.json()).issues).toHaveLength(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/web exec vitest run "app/api/listings/import/route.test.ts"
```

Expected: FAIL — cannot resolve `./route.js`.

- [ ] **Step 3: Write the route**

Create `apps/web/app/api/listings/import/route.ts`:

```ts
import { readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
import type { BulkFormSheet } from "@wukong/shopline";

import {
  createBulkFormImporter,
  type BulkFormImportInput,
  type BulkFormImportResult,
} from "../../../../lib/bulk-form-import";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

// readBulkFormSheet unzips with node:zlib, so this route cannot run on edge.
export const runtime = "nodejs";

/** Opak's real export is ~180KB; this leaves generous headroom under Vercel's body limit. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_ECHOED_ISSUES = 100;

export type BulkFormImportRouteDeps = {
  sessionContext: SessionContextPort;
  readSheet(bytes: Uint8Array): BulkFormSheet;
  importBulkForm(input: BulkFormImportInput): Promise<BulkFormImportResult>;
};

export function createBulkFormImportHandler(deps: BulkFormImportRouteDeps) {
  return async function importBulkForm(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(403, "insufficient_role", "Operator access is required.");
      }

      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength === 0) {
        throw new ApiError(400, "empty_upload", "Attach a SHOPLINE bulk update form.");
      }
      if (body.byteLength > MAX_UPLOAD_BYTES) {
        throw new ApiError(413, "upload_too_large", "The bulk update form is too large.");
      }

      let sheet: BulkFormSheet;
      try {
        sheet = deps.readSheet(body);
      } catch {
        // The reader's message can name internal container details; do not leak it.
        throw new ApiError(
          400,
          "bulk_form_unreadable",
          "The upload is not a readable xlsx workbook.",
        );
      }

      const result = await deps.importBulkForm({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        sheet,
      });

      console.info(
        JSON.stringify({
          event: "listing.bulk_form_imported",
          workspaceId: context.workspaceId,
          specVersion: result.specVersion,
          parsedRows: result.parsedRows,
          createdDrafts: result.createdDrafts,
          refreshedProducts: result.refreshedProducts,
          issueCount: result.issues.length,
        }),
      );

      return jsonResponse(201, {
        specVersion: result.specVersion,
        parsedRows: result.parsedRows,
        createdDrafts: result.createdDrafts,
        refreshedProducts: result.refreshedProducts,
        issues: result.issues.slice(0, MAX_ECHOED_ISSUES),
      });
    });
  };
}

export const POST = createBulkFormImportHandler({
  sessionContext: authSessionContext,
  readSheet: readBulkFormSheet,
  importBulkForm: createBulkFormImporter({ getDatabase }),
});
```

- [ ] **Step 4: Confirm the workspace dependency resolves**

```bash
grep -n "@wukong/shopline" apps/web/package.json
```

Expected: a `"@wukong/shopline": "workspace:*"` line. If it is missing, add it to `dependencies` and run `pnpm install`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @wukong/web exec vitest run "app/api/listings/import/route.test.ts"
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm lint
```

Expected: 14 successful tasks.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/listings/import/route.ts apps/web/app/api/listings/import/route.test.ts apps/web/package.json
git commit -m "feat(web): add bulk form import route"
```

---

### Task 9: Runbook and full verification

**Files:**
- Modify: `docs/runbooks/shopline-pilot-onboarding.md`

- [ ] **Step 1: Document the operator flow**

Append this section to `docs/runbooks/shopline-pilot-onboarding.md`:

```markdown
## Importing an existing catalog

Prerequisite: the workspace has a verified SHOPLINE connection.

1. In SHOPLINE admin, export the bulk update form for the catalog.
2. Do not open the file in Excel before importing. A re-save can retype the SKU
   column and strip the leading zeros that every Opak SKU carries.
3. Upload it:

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/listings/import" \
     -H "Cookie: $WUKONG_SESSION_COOKIE" \
     -H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
     --data-binary @bulk-update-form.xlsx
   ```

4. The response reports `parsedRows`, `createdDrafts`, `refreshedProducts`, and
   up to 100 parse issues. Re-running the same file is safe: products already
   imported keep their draft and only refresh their snapshot.
5. Imported drafts are **not** enqueued for AI processing. Enrichment is a
   separate budgeted batch.

To inspect a form before importing it:

```bash
pnpm --filter @wukong/shopline bulk-form:profile <bulk-update-form.xlsx>
```
```

- [ ] **Step 2: Run the full gate**

```bash
pnpm lint && pnpm test
```

Expected: typecheck 14/14 successful; all unit suites pass.

- [ ] **Step 3: Run the integration suites**

```bash
docker compose up -d postgres minio minio-tls mailpit && pnpm test:integration
```

Expected: PASS, including the new `platform-products.integration.test.ts`.

- [ ] **Step 4: Verify the release gate still reports zero leakage**

```bash
pnpm --filter @wukong/db exec tsx src/cli/audit-verify.ts --workspace ws_opak --draft <an-imported-draft-id>
```

Expected: `accessible foreign record count: 0`. The missing-action count will be non-zero for an imported draft — it has not been through review or publish yet, which is correct at this stage.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md
git commit -m "docs: describe the catalog import flow"
```

---

## Follow-on plans

Each of these deserves its own plan and produces working software on its own:

1. **Batch enrichment (roadmap 1b)** — a queue message type and worker consumer that runs generate over imported drafts in cost-capped batches, seeded from `platform_products.factsPrefill`.
2. **Bulk review UX (1c)** — batch-approve low-risk field classes, per-item review for claims-bearing copy.
3. **Exporter delivery (1d)** — wire `createBulkFormUpdate` into the delivery module, and decide create-vs-update from `platform_products`.
4. **Catalog hygiene report (1e)** — surface the `gaps` and inventory aggregates the parser already computes.
