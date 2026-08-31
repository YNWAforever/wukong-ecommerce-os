# Bulk Update Freshness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every SHOPLINE bulk-form import a durable, auditable record of the import event itself (`source_imports`), attribute each imported product to that record, and add a pure `assertExportFreshness` gate function that a later package (Package H, not part of this plan) will call before writing an export back to SHOPLINE.

**Architecture:** Backend-only, no UI. A new `source_imports` table (RLS-protected like every other tenant table) gets one row per call to `createBulkFormImporter`; every `platform_products` row upserted in that batch is stamped with the new row's id. `assertExportFreshness` is a pure function in `packages/core` with injected deps, matching `transitionListing`'s ports-and-adapters style — it never touches Postgres directly.

**Explicit resolutions to two ambiguities the design left for the plan:**

- **`importerId`** is the existing `actorId` already passed into `createBulkFormImporter` — no new input is added for it.
- **`merchantAttestedExportAt` and `filename` transport:** `POST /api/listings/import`'s body is raw xlsx bytes with no JSON/multipart wrapper, and today's `BulkImportPanel` sends nothing else. This plan adds them as two **required** query-string parameters (`?merchantAttestedExportAt=<ISO8601>&filename=<name>`). **Named consequence:** once this ships, the _existing, already-shipped_ `BulkImportPanel` "Import" button will get a 400 (`merchant_attested_export_at_missing`) on every real import, because it does not send these params yet. That UI fix is a small, separate follow-up task, out of scope here by the design's own boundary — flag it to the user when this plan finishes, don't silently leave it. `sheetName` is **not** taken from the client; it is derived server-side from the uploaded bytes via a new `readBulkFormSheetName` helper, since the client has no reason to be trusted for it.

**Tech Stack:** Drizzle ORM raw SQL migrations, Postgres RLS, Vitest, `node:crypto` sha256.

---

## Environment note for every `Run:` step

`pnpm` is not on a normal PATH in this environment. Prefix every command with:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
```

The integration test in Task 2 needs live Postgres (`docker compose up -d postgres`). If that stack is unavailable when you reach it, **say so explicitly and move on to the next task** rather than silently skipping it — do not mark it complete without having actually run it.

---

### Task 1: `source_imports` table and `platform_products.source_import_id` column

**Files:**

- Create: `packages/db/drizzle/0010_source_imports.sql`
- Modify: `packages/db/src/schema.ts` (add `sourceImports` table; add one column to `platformProducts`)

- [ ] **Step 1: Add the `sourceImports` table to the schema**

In `packages/db/src/schema.ts`, immediately after the `platformProducts` table definition (currently ends at line 702, right before the `enrichmentBatchStatus` enum), insert:

```ts
export const sourceImports = pgTable(
  "source_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    connectionId: uuid("connection_id").notNull(),
    filename: text("filename").notNull(),
    workbookSha256: text("workbook_sha256").notNull(),
    headerContractSha256: text("header_contract_sha256").notNull(),
    sheetName: text("sheet_name").notNull(),
    rowCount: integer("row_count").notNull(),
    merchantAttestedExportAt: timestamp("merchant_attested_export_at", {
      withTimezone: true,
    }).notNull(),
    importerId: text("importer_id").notNull(),
    specVersion: text("spec_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("source_imports_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    index("source_imports_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    foreignKey({
      name: "source_imports_workspace_connection_fkey",
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [shoplineConnections.workspaceId, shoplineConnections.id],
    }).onDelete("cascade"),
  ],
);
```

Then add one nullable column to the existing `platformProducts` table (in its column map, right after `contentDigest: text("content_digest"),` at line 664):

```ts
    sourceImportId: uuid("source_import_id"),
```

And add a matching foreign key to `platformProducts`'s `(table) => [...]` array (after the existing `platform_products_workspace_listing_fkey` entry, line 700):

```ts
    foreignKey({
      name: "platform_products_workspace_source_import_fkey",
      columns: [table.workspaceId, table.sourceImportId],
      foreignColumns: [sourceImports.workspaceId, sourceImports.id],
    }).onDelete("restrict"),
```

`onDelete: "restrict"` because `source_imports` is meant to be an immutable audit trail — an accidental delete must not silently orphan or cascade-null the attribution on products that still reference it.

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0010_source_imports.sql`. This repo re-runs every migration file on every `migrate()` call (confirmed: `packages/db/src/migrations.ts` has no applied-migrations tracking table), so every statement must be idempotent, matching the `IF NOT EXISTS` / `DO` block guard style already used in `0004_platform_products.sql` and `0009_shopline_connections_one_per_workspace.sql`:

```sql
CREATE TABLE IF NOT EXISTS source_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  filename text NOT NULL,
  workbook_sha256 text NOT NULL,
  header_contract_sha256 text NOT NULL,
  sheet_name text NOT NULL,
  row_count integer NOT NULL,
  merchant_attested_export_at timestamptz NOT NULL,
  importer_id text NOT NULL,
  spec_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_imports_workspace_connection_fkey
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES shopline_connections (workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS source_imports_workspace_id_uq
  ON source_imports (workspace_id, id);
CREATE INDEX IF NOT EXISTS source_imports_workspace_created_idx
  ON source_imports (workspace_id, created_at);

ALTER TABLE source_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_imports_workspace_policy ON source_imports;
CREATE POLICY source_imports_workspace_policy ON source_imports
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_imports TO wukong_app;

ALTER TABLE platform_products ADD COLUMN IF NOT EXISTS source_import_id uuid;

DO $platform_products_source_import_fkey$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_products_workspace_source_import_fkey'
  ) THEN
    ALTER TABLE platform_products
      ADD CONSTRAINT platform_products_workspace_source_import_fkey
      FOREIGN KEY (workspace_id, source_import_id)
      REFERENCES source_imports (workspace_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$platform_products_source_import_fkey$;
```

- [ ] **Step 3: Verify the package still typechecks**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/db typecheck
```

Expected: PASS (the new table/column compile; nothing references `sourceImports` yet so nothing else should break).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0010_source_imports.sql
git commit -m "feat: add source_imports table and platform_products.source_import_id"
```

---

### Task 2: `source_imports` repository, wiring, and its RLS integration test

**Files:**

- Create: `packages/db/src/repositories/source-imports.ts`
- Create: `packages/db/src/repositories/source-imports.integration.test.ts`
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/repositories/source-imports.integration.test.ts`, mirroring `platform-products.integration.test.ts`'s exact fixture/lifecycle style and its `"never returns another workspace's ... rows"` pattern:

```ts
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

const workspaceId = "ws_source_import";
const otherWorkspaceId = "ws_source_import_other";
const connectionId = "33333333-3333-4333-8333-333333333333";
const otherConnectionId = "44444444-4444-4444-8444-444444444444";

describe("source import repository", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: ignoreNotice,
    prepare: false,
  });
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
        ('${connectionId}', '${workspaceId}', 'source-import-test.example', 'token'),
        ('${otherConnectionId}', '${otherWorkspaceId}', 'source-import-other.example', 'token');
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const inputFor = (overrides: { connectionId: string }) => ({
    connectionId: overrides.connectionId,
    filename: "opak-export.xlsx",
    workbookSha256: "a".repeat(64),
    headerContractSha256: "b".repeat(64),
    sheetName: "Default",
    rowCount: 2,
    merchantAttestedExportAt: new Date("2026-08-01T00:00:00Z"),
    importerId: "user_1",
    specVersion: "opak-2026-05",
  });

  it("creates a row and reads it back by id", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.sourceImports.create(inputFor({ connectionId })),
    );

    expect(created.filename).toBe("opak-export.xlsx");
    expect(created.headerContractSha256).toBe("b".repeat(64));

    const found = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.sourceImports.getById(created.id),
    );
    expect(found?.id).toBe(created.id);
  });

  it("never returns another workspace's source import row", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.sourceImports.create(inputFor({ connectionId })),
    );

    const found = await database.forWorkspace(
      otherWorkspaceId,
      (repositories) => repositories.sourceImports.getById(created.id),
    );
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
docker compose up -d postgres
pnpm test:integration -- source-imports.integration.test.ts
```

Expected: FAIL — `repositories.sourceImports` is `undefined` (the repository does not exist yet). If Postgres is unavailable in this environment, state that plainly and continue to Step 3 without having run it; come back to Step 4's verification once the stack is reachable.

- [ ] **Step 3: Implement the repository**

Create `packages/db/src/repositories/source-imports.ts`:

```ts
import { eq, and } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { sourceImports } from "../schema.js";

export type CreateSourceImportInput = {
  connectionId: string;
  filename: string;
  workbookSha256: string;
  headerContractSha256: string;
  sheetName: string;
  rowCount: number;
  merchantAttestedExportAt: Date;
  importerId: string;
  specVersion: string;
};

export type SourceImport = {
  id: string;
  connectionId: string;
  filename: string;
  workbookSha256: string;
  headerContractSha256: string;
  sheetName: string;
  rowCount: number;
  merchantAttestedExportAt: Date;
  importerId: string;
  specVersion: string;
  createdAt: Date;
};

export type SourceImportRepository = {
  create(input: CreateSourceImportInput): Promise<SourceImport>;
  getById(id: string): Promise<SourceImport | null>;
};

const COLUMNS = {
  id: sourceImports.id,
  connectionId: sourceImports.connectionId,
  filename: sourceImports.filename,
  workbookSha256: sourceImports.workbookSha256,
  headerContractSha256: sourceImports.headerContractSha256,
  sheetName: sourceImports.sheetName,
  rowCount: sourceImports.rowCount,
  merchantAttestedExportAt: sourceImports.merchantAttestedExportAt,
  importerId: sourceImports.importerId,
  specVersion: sourceImports.specVersion,
  createdAt: sourceImports.createdAt,
};

export function createSourceImportRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): SourceImportRepository {
  return {
    async create(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(sourceImports)
        .values({ ...input, workspaceId })
        .returning(COLUMNS);
      if (!row) throw new Error("source import insert did not return a row");
      return row;
    },

    async getById(id) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(sourceImports)
        .where(
          and(
            eq(sourceImports.workspaceId, workspaceId),
            eq(sourceImports.id, id),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
```

- [ ] **Step 4: Register the repository and run tests to verify they pass**

In `packages/db/src/client.ts`:

- Add the import (after the `platform-products.js` import block, line 42):

```ts
import {
  createSourceImportRepository,
  type SourceImportRepository,
} from "./repositories/source-imports.js";
```

- Add to `WorkspaceRepositories` (after `platformProducts: PlatformProductRepository;`, line 69):

```ts
sourceImports: SourceImportRepository;
```

- Add to the `repositories` object built inside `runForWorkspace` (after the `platformProducts: createPlatformProductRepository(...)` block, line 171):

```ts
        sourceImports: createSourceImportRepository(
          transaction,
          workspaceId,
          scope,
        ),
```

In `packages/db/src/index.ts`, add an export block (after the `platform-products.js` export block):

```ts
export type {
  CreateSourceImportInput,
  SourceImport,
  SourceImportRepository,
} from "./repositories/source-imports.js";
```

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test:integration -- source-imports.integration.test.ts
```

Expected: PASS (2/2). If Postgres was unavailable at Step 2, run this once it is, and note explicitly if it still cannot be run.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/source-imports.ts packages/db/src/repositories/source-imports.integration.test.ts packages/db/src/client.ts packages/db/src/index.ts
git commit -m "feat: add source imports repository with workspace-scoped RLS"
```

---

### Task 3: Stamp `sourceImportId` on `platform_products`

**Files:**

- Modify: `packages/db/src/repositories/platform-products.ts`
- Modify: `packages/db/src/repositories/platform-products.integration.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/db/src/repositories/platform-products.integration.test.ts`, add this test after the existing `"writes a whole batch in one statement"` test (after line 190, before `"rejects a facts prefill..."`):

```ts
it("stamps and round-trips a source import id through upsert", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const sourceImport = await repositories.sourceImports.create({
      connectionId,
      filename: "opak-export.xlsx",
      workbookSha256: "d".repeat(64),
      headerContractSha256: "e".repeat(64),
      sheetName: "Default",
      rowCount: 1,
      merchantAttestedExportAt: new Date("2026-08-01T00:00:00Z"),
      importerId: "user_1",
      specVersion: "opak-2026-05",
    });

    await repositories.platformProducts.upsert({
      connectionId,
      remoteProductId: "aaaaaaaaaaaaaaaaaaaaaa09",
      origin: "import",
      sku: "0009",
      listingId: null,
      specVersion: "opak-2026-05",
      rawRow: { productId: "aaaaaaaaaaaaaaaaaaaaaa09" },
      factsPrefill: null,
      contentDigest: "f".repeat(64),
      sourceImportId: sourceImport.id,
    });

    const found = await repositories.platformProducts.listByRemoteProductIds(
      connectionId,
      ["aaaaaaaaaaaaaaaaaaaaaa09"],
    );
    expect(found[0]?.sourceImportId).toBe(sourceImport.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test:integration -- platform-products.integration.test.ts
```

Expected: FAIL — TypeScript error, `sourceImportId` does not exist on `UpsertPlatformProductInput`.

- [ ] **Step 3: Extend the repository**

In `packages/db/src/repositories/platform-products.ts`:

Add `sourceImportId: string | null;` to `PlatformProduct` (after `contentDigest: string | null;`, line 30) and to `UpsertPlatformProductInput` (after `contentDigest: string | null;`, line 56).

Add to `COLUMNS` (after `contentDigest: platformProducts.contentDigest,`, line 98):

```ts
  sourceImportId: platformProducts.sourceImportId,
```

In `upsert`'s `.onConflictDoUpdate({ set: {...} })` (line 154-163), add:

```ts
            sourceImportId: input.sourceImportId,
```

In `upsertMany`'s `.onConflictDoUpdate({ set: {...} })` (line 184-193), add:

```ts
            sourceImportId: sql`excluded.source_import_id`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test:integration -- platform-products.integration.test.ts
```

Expected: PASS, including the new test. Note the existing tests in this file construct `UpsertPlatformProductInput` object literals without `sourceImportId` (e.g. line 80-90) — since it's now a required field on the type, add `sourceImportId: null,` to every existing literal in this file that constructs an `UpsertPlatformProductInput` (search the file for `contentDigest:` to find each one; there are 8 such literals as of this writing).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/platform-products.ts packages/db/src/repositories/platform-products.integration.test.ts
git commit -m "feat: stamp platform_products with the source import that produced it"
```

---

### Task 4: Read the real worksheet name from an uploaded workbook

**Files:**

- Modify: `packages/shopline/src/bulk-form-xlsx.ts`
- Modify: `packages/shopline/src/bulk-form-xlsx.test.ts`

`readBulkFormSheet` already computes `firstWorksheetName` internally (the zip entry's file path, e.g. `xl/worksheets/sheet1.xml`) but discards it, and that's a different string from the human-readable name (e.g. `"Default"`) declared in `xl/workbook.xml`'s `<sheet name="...">` tag — the same tag the existing sheet-naming test already regex-matches directly. This task adds a small, separate, additive function rather than changing `readBulkFormSheet`'s return shape, to avoid touching its other callers (`profile-bulk-form.ts` CLI, `delivery-service.review-fix.test.ts`).

- [ ] **Step 1: Write the failing test**

In `packages/shopline/src/bulk-form-xlsx.test.ts`, add this test after the existing `'names the generated worksheet "Default"...'` test (after line 142):

```ts
it("reads back the worksheet name it wrote", () => {
  const bytes = writeBulkFormWorkbook([["Product ID (DO NOT EDIT)"], ["001"]]);

  expect(readBulkFormSheetName(bytes)).toBe("Default");
});
```

And add `readBulkFormSheetName` to the existing import from `./bulk-form-xlsx.js` (line 10-14):

```ts
import {
  BulkFormWorkbookError,
  readBulkFormSheet,
  readBulkFormSheetName,
  writeBulkFormWorkbook,
} from "./bulk-form-xlsx.js";
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/shopline test -- bulk-form-xlsx.test.ts
```

Expected: FAIL — `readBulkFormSheetName` is not exported.

- [ ] **Step 3: Implement it**

In `packages/shopline/src/bulk-form-xlsx.ts`, add this function immediately after `readBulkFormSheet` (after its closing brace):

```ts
/**
 * Reads the workbook's declared worksheet name from `xl/workbook.xml` — a
 * different string from the zip entry path `firstWorksheetName` resolves
 * internally. Opak's real exports and this reader's own writer both produce
 * exactly one worksheet, so the first declared name is unambiguous.
 */
export function readBulkFormSheetName(bytes: Uint8Array): string {
  const entries = readZipEntries(bytes);
  const workbookXml = entries.get("xl/workbook.xml");
  if (workbookXml === undefined) {
    throw new BulkFormWorkbookError("workbook contains no xl/workbook.xml");
  }
  const xml = new TextDecoder().decode(workbookXml);
  const match = /<sheet\s[^>]*\bname="([^"]*)"/.exec(xml);
  if (match?.[1] === undefined) {
    throw new BulkFormWorkbookError("workbook declares no worksheet name");
  }
  return match[1];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/shopline test -- bulk-form-xlsx.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add packages/shopline/src/bulk-form-xlsx.ts packages/shopline/src/bulk-form-xlsx.test.ts
git commit -m "feat: read a workbook's declared worksheet name"
```

---

### Task 5: Hash the current header contract

**Files:**

- Modify: `packages/shopline/src/bulk-form-digest.ts`
- Create: `packages/shopline/src/bulk-form-digest.test.ts`
- Modify: `packages/shopline/src/index.ts`

- [ ] **Step 1: Write the failing test**

`bulk-form-digest.ts` currently has no dedicated test file (its `hashBulkFormRow` is exercised indirectly elsewhere). Create `packages/shopline/src/bulk-form-digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { hashBulkFormHeaderContract } from "./bulk-form-digest.js";

describe("hashBulkFormHeaderContract", () => {
  it("returns a stable sha256 hex digest", () => {
    const first = hashBulkFormHeaderContract();
    const second = hashBulkFormHeaderContract();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/shopline test -- bulk-form-digest.test.ts
```

Expected: FAIL — `hashBulkFormHeaderContract` is not exported.

- [ ] **Step 3: Implement it**

In `packages/shopline/src/bulk-form-digest.ts`, add after `hashBulkFormRow`:

```ts
/**
 * Stable digest of the *current* column contract — key, English header, and
 * Chinese header for every column, in contract order. Used by the freshness
 * gate to detect that the runtime's column contract has drifted since a
 * given import, independent of any one row's content.
 */
export function hashBulkFormHeaderContract(): string {
  const ordered = BULK_FORM_COLUMNS.map((column) => [
    column.key,
    column.en,
    column.zh,
  ]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}
```

- [ ] **Step 4: Export it and run tests to verify they pass**

In `packages/shopline/src/index.ts`, change line 55 from:

```ts
export { hashBulkFormRow } from "./bulk-form-digest.js";
```

to:

```ts
export {
  hashBulkFormHeaderContract,
  hashBulkFormRow,
} from "./bulk-form-digest.js";
```

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/shopline test -- bulk-form-digest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shopline/src/bulk-form-digest.ts packages/shopline/src/bulk-form-digest.test.ts packages/shopline/src/index.ts
git commit -m "feat: hash the current bulk form header contract"
```

---

### Task 6: Wire `source_imports` creation into `createBulkFormImporter`

**Files:**

- Modify: `apps/web/lib/bulk-form-import.ts`
- Modify: `apps/web/lib/bulk-form-import.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/web/lib/bulk-form-import.test.ts`, add a `sourceImports` fake to `importerWith`'s returned repositories object (inside the `work({...})` call, after the `shoplineConnections` block, before `platformProducts`):

```ts
            sourceImports: {
              async create(input: Record<string, unknown>) {
                return { id: "source_import_1", ...input };
              },
            },
```

Then add this new test at the end of the `describe("bulk form importer", ...)` block (after the last existing test, before the closing `});` on line 376):

```ts
it("creates a source_imports row and stamps its id on every upserted mirror", async () => {
  const { importBulkForm, recorded } = importerWith();

  await importBulkForm({
    workspaceId: "ws_opak",
    actorId: "user_1",
    rawBytes: new Uint8Array([1, 2, 3]),
    merchantAttestedExportAt: new Date("2026-08-01T00:00:00Z"),
    filename: "opak-export.xlsx",
    sheetName: "Default",
    sheet: sheetOf(rowFor(), rowFor({ productId: "remote_2", sku: "0002" })),
  });

  expect(
    recorded.upserts.every((u) => u.sourceImportId === "source_import_1"),
  ).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-form-import.test.ts
```

Expected: FAIL — TypeScript error, the new call passes `rawBytes`/`merchantAttestedExportAt`/`filename`/`sheetName` which don't exist on `BulkFormImportInput` yet (excess property error on the object literal).

- [ ] **Step 3: Implement it**

In `apps/web/lib/bulk-form-import.ts`:

Add the import (top of file, after the `@wukong/shopline` import block):

```ts
import { createHash } from "node:crypto";
```

Change the `@wukong/shopline` import (line 2-9) to also pull in the new hasher:

```ts
import {
  hashBulkFormHeaderContract,
  hashBulkFormRow,
  parseBulkForm,
  renderBulkFormSource,
  type BulkFormGapsInput,
  type BulkFormIssue,
  type BulkFormSheet,
} from "@wukong/shopline";
```

Extend `BulkFormImportInput` (lines 21-25):

```ts
export type BulkFormImportInput = {
  workspaceId: string;
  actorId: string;
  sheet: BulkFormSheet;
  rawBytes: Uint8Array;
  merchantAttestedExportAt: Date;
  filename: string;
  sheetName: string;
};
```

Inside `importBulkForm`, right after the `parsed.rows.length > MAX_IMPORT_ROWS` guard (line 89, before the `return deps.getDatabase()...` call), compute the two hashes once:

```ts
const workbookSha256 = createHash("sha256")
  .update(input.rawBytes)
  .digest("hex");
const headerContractSha256 = hashBulkFormHeaderContract();
```

Inside the `forWorkspace` callback, right after the `connection` null-check (line 101, before `const known = ...`), create the source import row:

```ts
const sourceImport = await repositories.sourceImports.create({
  connectionId: connection.id,
  filename: input.filename,
  workbookSha256,
  headerContractSha256,
  sheetName: input.sheetName,
  rowCount: parsed.rows.length,
  merchantAttestedExportAt: input.merchantAttestedExportAt,
  importerId: input.actorId,
  specVersion: parsed.specVersion,
});
```

In the `mirrors.push({...})` call (line 172-184), add one field:

```ts
mirrors.push({
  connectionId: connection.id,
  remoteProductId: row.productId,
  sku: row.sku,
  listingId,
  specVersion: parsed.specVersion,
  rawRow,
  factsPrefill: row.facts,
  contentDigest,
  origin: "import",
  sourceImportId: sourceImport.id,
});
```

- [ ] **Step 4: Fix up the other existing test calls**

Every other call to `importBulkForm({...})` in `apps/web/lib/bulk-form-import.test.ts` must now also satisfy the new required fields. Add this helper right after the `sheetOf` definition (line 27):

```ts
const RAW_BYTES = new Uint8Array([1, 2, 3]);
const MERCHANT_ATTESTED_EXPORT_AT = new Date("2026-08-01T00:00:00Z");
const FILENAME = "opak-export.xlsx";
const SHEET_NAME = "Default";
```

Then, in every existing `importBulkForm({ workspaceId: "ws_opak", actorId: "user_1", sheet: ... })` call in this file (there are 13 as of this writing — every call except the one added in Step 1, which already carries its own literals), add these four lines right after `actorId: "user_1",` and before `sheet:`:

```ts
      rawBytes: RAW_BYTES,
      merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
      filename: FILENAME,
      sheetName: SHEET_NAME,
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- bulk-form-import.test.ts
```

Expected: PASS, all tests including the new one.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-form-import.ts apps/web/lib/bulk-form-import.test.ts
git commit -m "feat: attribute every imported product to its source import"
```

---

### Task 7: Collect the merchant-attested export timestamp and filename at the route

**Files:**

- Modify: `apps/web/app/api/listings/import/route.ts`
- Modify: `apps/web/app/api/listings/import/route.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/web/app/api/listings/import/route.test.ts`, change `handlerFor` (lines 13-27) to accept a `readSheetName` fake and default the request URL to carry both new required query params:

```ts
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
    readSheetName: () => "Default",
    importBulkForm: async () => okResult,
    ...overrides,
  });
}

const IMPORT_URL =
  "http://localhost/api/listings/import?merchantAttestedExportAt=2026-08-01T00%3A00%3A00Z&filename=opak-export.xlsx";

const requestWith = (body: Uint8Array<ArrayBuffer>, url = IMPORT_URL) =>
  new Request(url, { method: "POST", body });
```

Update every existing `requestWith(...)` call in this file to rely on the new default `IMPORT_URL` (they already call `requestWith(new Uint8Array([...]))` with one argument, so they pick up the default automatically — no change needed there beyond the signature above).

Add four new tests at the end of the `describe(...)` block (after the `"caps the number of issues it echoes back"` test, before the closing `});`):

```ts
it("rejects a request with no merchantAttestedExportAt", async () => {
  const response = await handlerFor("operator")(
    requestWith(
      new Uint8Array([1]),
      "http://localhost/api/listings/import?filename=opak-export.xlsx",
    ),
  );

  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe(
    "merchant_attested_export_at_missing",
  );
});

it("rejects a request with an unparseable merchantAttestedExportAt", async () => {
  const response = await handlerFor("operator")(
    requestWith(
      new Uint8Array([1]),
      "http://localhost/api/listings/import?merchantAttestedExportAt=not-a-date&filename=opak-export.xlsx",
    ),
  );

  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe(
    "merchant_attested_export_at_invalid",
  );
});

it("rejects a request with no filename", async () => {
  const response = await handlerFor("operator")(
    requestWith(
      new Uint8Array([1]),
      "http://localhost/api/listings/import?merchantAttestedExportAt=2026-08-01T00%3A00%3A00Z",
    ),
  );

  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("filename_missing");
});

it("passes the parsed timestamp, filename, and sheet name through to the importer", async () => {
  let received: Record<string, unknown> | undefined;
  const handler = handlerFor("operator", {
    importBulkForm: async (input) => {
      received = input as unknown as Record<string, unknown>;
      return okResult;
    },
  });

  await handler(requestWith(new Uint8Array([1, 2, 3])));

  expect(received?.filename).toBe("opak-export.xlsx");
  expect(received?.sheetName).toBe("Default");
  expect((received?.merchantAttestedExportAt as Date).toISOString()).toBe(
    "2026-08-01T00:00:00.000Z",
  );
  expect(received?.rawBytes).toEqual(new Uint8Array([1, 2, 3]));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- apps/web/app/api/listings/import/route.test.ts
```

Expected: FAIL — `readSheetName` doesn't exist on `BulkFormImportRouteDeps`, and the route doesn't parse the new query params yet.

- [ ] **Step 3: Implement it**

In `apps/web/app/api/listings/import/route.ts`:

Change the import from `@wukong/shopline/bulk-form-xlsx` (line 2):

```ts
import {
  readBulkFormSheet,
  readBulkFormSheetName,
} from "@wukong/shopline/bulk-form-xlsx";
```

Extend `BulkFormImportRouteDeps` (lines 37-41):

```ts
export type BulkFormImportRouteDeps = {
  sessionContext: SessionContextPort;
  readSheet(bytes: Uint8Array): BulkFormSheet;
  readSheetName(bytes: Uint8Array): string;
  importBulkForm(input: BulkFormImportInput): Promise<BulkFormImportResult>;
};
```

Right after the `upload_not_a_workbook` catch block (line 74-85, before `const result = await deps.importBulkForm({...})`), add the query-param parsing:

```ts
const url = new URL(request.url);
const merchantAttestedExportAtRaw = url.searchParams.get(
  "merchantAttestedExportAt",
);
if (merchantAttestedExportAtRaw === null) {
  throw new ApiError(
    400,
    "merchant_attested_export_at_missing",
    "Provide the date this SHOPLINE export was generated.",
  );
}
const merchantAttestedExportAt = new Date(merchantAttestedExportAtRaw);
if (Number.isNaN(merchantAttestedExportAt.getTime())) {
  throw new ApiError(
    400,
    "merchant_attested_export_at_invalid",
    "merchantAttestedExportAt must be a valid ISO 8601 date.",
  );
}
const filename = url.searchParams.get("filename");
if (filename === null || filename.trim().length === 0) {
  throw new ApiError(
    400,
    "filename_missing",
    "Provide the original filename of the uploaded workbook.",
  );
}
```

Change the `deps.importBulkForm({...})` call (line 87-91) to:

```ts
const result = await deps.importBulkForm({
  workspaceId: context.workspaceId,
  actorId: context.actorId,
  sheet,
  rawBytes: body,
  merchantAttestedExportAt,
  filename,
  sheetName: deps.readSheetName(body),
});
```

Change the production wiring at the bottom of the file (line 116-120):

```ts
export const POST = createBulkFormImportHandler({
  sessionContext: authSessionContext,
  readSheet: readBulkFormSheet,
  readSheetName: readBulkFormSheetName,
  importBulkForm: createBulkFormImporter({ getDatabase }),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- apps/web/app/api/listings/import/route.test.ts
```

Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/listings/import/route.ts apps/web/app/api/listings/import/route.test.ts
git commit -m "feat: require a merchant-attested export timestamp and filename on catalog import"
```

---

### Task 8: `assertExportFreshness` pure gate function

**Files:**

- Create: `packages/core/src/assert-export-freshness.ts`
- Create: `packages/core/src/assert-export-freshness.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/assert-export-freshness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  assertExportFreshness,
  type AssertExportFreshnessDeps,
  type AssertExportFreshnessInput,
} from "./assert-export-freshness.js";

const BASE_INPUT: AssertExportFreshnessInput = {
  workspaceId: "ws_opak",
  listingId: "listing_1",
  expectedSourceImportId: "source_import_1",
  expectedRowDigest: "digest_1",
  expectedVersionId: "version_1",
  freshnessAttested: true,
};

function depsWith(
  overrides: Partial<AssertExportFreshnessDeps> = {},
): AssertExportFreshnessDeps {
  return {
    async getPlatformProductLink() {
      return { sourceImportId: "source_import_1", contentDigest: "digest_1" };
    },
    async getActiveVersionId() {
      return "version_1";
    },
    async getSourceImportHeaderContractSha256() {
      return "contract_1";
    },
    currentHeaderContractSha256() {
      return "contract_1";
    },
    ...overrides,
  };
}

describe("assertExportFreshness", () => {
  it("succeeds when every check agrees", async () => {
    const result = await assertExportFreshness(BASE_INPUT, depsWith());
    expect(result).toEqual({ ok: true });
  });

  it("rejects when freshness was not attested, before checking anything else", async () => {
    const result = await assertExportFreshness(
      { ...BASE_INPUT, freshnessAttested: false },
      depsWith({
        async getPlatformProductLink() {
          throw new Error("must not be called");
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "not_attested" });
  });

  it("rejects when the listing has no remote product link", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return null;
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "no_remote_link" });
  });

  it("rejects when the link's source import id does not match", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return {
            sourceImportId: "source_import_other",
            contentDigest: "digest_1",
          };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "source_import_mismatch" });
  });

  it("rejects when the link's content digest does not match", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return {
            sourceImportId: "source_import_1",
            contentDigest: "stale_digest",
          };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "row_digest_mismatch" });
  });

  it("rejects when the listing's active version has moved on", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({
        async getActiveVersionId() {
          return "version_other";
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "version_mismatch" });
  });

  it("rejects when the stored header contract no longer matches the current one", async () => {
    const result = await assertExportFreshness(
      BASE_INPUT,
      depsWith({ currentHeaderContractSha256: () => "contract_new" }),
    );
    expect(result).toEqual({ ok: false, reason: "header_contract_stale" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/core test -- assert-export-freshness.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement it**

Create `packages/core/src/assert-export-freshness.ts`:

```ts
export type PlatformProductLink = {
  sourceImportId: string | null;
  contentDigest: string | null;
};

export type AssertExportFreshnessDeps = {
  getPlatformProductLink(
    listingId: string,
  ): Promise<PlatformProductLink | null>;
  getActiveVersionId(listingId: string): Promise<string | null>;
  getSourceImportHeaderContractSha256(
    sourceImportId: string,
  ): Promise<string | null>;
  currentHeaderContractSha256(): string;
};

export type AssertExportFreshnessInput = {
  workspaceId: string;
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
  /**
   * Must come from an explicit human attestation before an export, never
   * from a time-since-import comparison — the master instruction bars a
   * hard-coded freshness threshold until Opak approves a policy.
   */
  freshnessAttested: boolean;
};

export type FreshnessFailureReason =
  | "not_attested"
  | "no_remote_link"
  | "source_import_mismatch"
  | "row_digest_mismatch"
  | "version_mismatch"
  | "header_contract_stale";

export type FreshnessResult =
  { ok: true } | { ok: false; reason: FreshnessFailureReason };

/**
 * Gate a listing's SHOPLINE export against everything that must still be
 * true since it was imported. Deliberately does not touch Postgres directly
 * — a future export flow (not part of this package) supplies real deps.
 */
export async function assertExportFreshness(
  input: AssertExportFreshnessInput,
  deps: AssertExportFreshnessDeps,
): Promise<FreshnessResult> {
  if (!input.freshnessAttested) {
    return { ok: false, reason: "not_attested" };
  }

  const link = await deps.getPlatformProductLink(input.listingId);
  if (link === null) {
    return { ok: false, reason: "no_remote_link" };
  }
  if (link.sourceImportId !== input.expectedSourceImportId) {
    return { ok: false, reason: "source_import_mismatch" };
  }
  if (link.contentDigest !== input.expectedRowDigest) {
    return { ok: false, reason: "row_digest_mismatch" };
  }

  const activeVersionId = await deps.getActiveVersionId(input.listingId);
  if (activeVersionId !== input.expectedVersionId) {
    return { ok: false, reason: "version_mismatch" };
  }

  const storedHeaderContractSha256 =
    await deps.getSourceImportHeaderContractSha256(
      input.expectedSourceImportId,
    );
  if (storedHeaderContractSha256 !== deps.currentHeaderContractSha256()) {
    return { ok: false, reason: "header_contract_stale" };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Export it and run tests to verify they pass**

In `packages/core/src/index.ts`, add (after the `transitionListing`/`workflow.js` export block, lines 25-26):

```ts
export { assertExportFreshness } from "./assert-export-freshness.js";
export type {
  AssertExportFreshnessDeps,
  AssertExportFreshnessInput,
  FreshnessFailureReason,
  FreshnessResult,
  PlatformProductLink,
} from "./assert-export-freshness.js";
```

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/core test -- assert-export-freshness.test.ts
```

Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/assert-export-freshness.ts packages/core/src/assert-export-freshness.test.ts packages/core/src/index.ts
git commit -m "feat: add the assertExportFreshness gate function"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm typecheck
```

Expected: PASS across every package.

- [ ] **Step 2: Format check**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm format:runtime:check
```

Expected: PASS. If it fails only on files this plan touched, run the repo's format-write command and re-check, then re-run Step 1.

- [ ] **Step 3: Full unit suite**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test
```

Expected: PASS, all packages.

- [ ] **Step 4: Integration suite (requires live Postgres)**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
docker compose up -d postgres
pnpm test:integration
```

Expected: PASS, all packages, including the two `source_imports.integration.test.ts` cases and the extended `platform-products.integration.test.ts`. If Postgres is genuinely unreachable in this environment, state that explicitly in your final report rather than reporting this step as passed.

- [ ] **Step 5: Report the known UI gap**

In your final report, explicitly note: `BulkImportPanel`'s "Import" button will now receive a 400 (`merchant_attested_export_at_missing`) on every real import, because it does not yet send `merchantAttestedExportAt`/`filename` as query parameters. This is a named, tracked follow-up, not a regression to silently fix here — flag it so the user can decide when to schedule the small UI addition.

---

## Self-Review

**Spec coverage:** §2 (schema) → Task 1. §2 RLS → Task 1 migration + Task 2 integration test. §3 (import-path wiring, hashes, source_imports row, sourceImportId stamping, caller-supplied timestamp) → Tasks 4, 5, 6, 7. §4 (`assertExportFreshness`, 5 ordered checks) → Task 8. §5 (testing: RLS negative test, importer extension, 6+1 gate tests) → Tasks 2, 3, 6, 8. §6 self-review's named UI gap → called out explicitly in this plan's header and in Task 9 Step 5.

**Placeholder scan:** none found — every step has literal, complete code.

**Type consistency:** `BulkFormImportInput` gains the same four fields (`rawBytes`, `merchantAttestedExportAt`, `filename`, `sheetName`) everywhere it's constructed (Tasks 6, 7). `UpsertPlatformProductInput`/`PlatformProduct` both gain `sourceImportId: string | null` (Task 3). `AssertExportFreshnessInput`/`Deps`/`FreshnessResult` field names in Task 8's implementation match its own test file exactly (`getPlatformProductLink`, `getActiveVersionId`, `getSourceImportHeaderContractSha256`, `currentHeaderContractSha256`).
