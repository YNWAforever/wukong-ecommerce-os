# Catalog Enrichment Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich imported SHOPLINE catalog drafts through the existing listing pipeline, in operator-approved, budget-capped waves.

**Architecture:** An imported draft has no source assets, so if its `note` carries the product's own text the existing `listing-pipeline.ts` runs end to end unchanged — `extract` derives facts with evidence, `generate` writes a `CanonicalListing`, the draft lands in `in_review`. This slice therefore adds no pipeline: it adds a text rendering of a bulk-form row, two batch tables, budget accounting observed from `ai_runs`, and an advance operation that releases existing `listingJobSchema` messages in waves until the budget is spent.

**Tech Stack:** TypeScript 7 (5.9 in `apps/web`), Drizzle ORM + raw SQL migrations, Postgres with RLS, Cloudflare Queues, Next.js 16 route handlers, Vitest, zod v4.

---

## Prerequisites

Read `docs/superpowers/specs/2026-08-16-catalog-enrichment-batches-design.md` first — especially "The central finding: no new pipeline is needed" and "Budget accounting is observed, not predicted".

This plan builds on the catalog import slice (PR #32). It assumes `platform_products`, `bulk-form.ts`, and `bulk-form-import.ts` are on `main`.

Local services for the integration tests:

```bash
docker compose up -d postgres minio minio-tls mailpit
```

If the `docker compose` plugin is unavailable, the containers can be run directly:

```bash
docker run -d --name wukong-postgres -e POSTGRES_USER=wukong -e POSTGRES_PASSWORD=wukong -e POSTGRES_DB=wukong -p 54329:5432 postgres:17-alpine
```

Integration tests and migrations need both URLs exported:

```bash
export DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong"
export DATABASE_ADMIN_URL="postgres://wukong:wukong@localhost:54329/wukong"
```

## Hard constraints

- **Do not modify `apps/worker/src/listing-pipeline.ts`, `packages/ai/src/contracts.ts`, or `packages/ai/src/prompts.ts`.** The whole design rests on reusing them unchanged. If a task seems to need a change there, stop and report it.
- **Never put `Product Cost` in the rendered source.** It is the merchant's wholesale price and must not reach a prompt.
- **Never render the enrichable columns** (`nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`) into the source. Those are the fields being generated; feeding the existing placeholder back in invites the model to reproduce it.

## File Structure

| File                                                                           | Responsibility                                                                                             |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `packages/shopline/src/bulk-form.ts` (modify)                                  | Extract the gaps computation into an exported pure function so a cohort can be selected from a stored row. |
| `packages/shopline/src/bulk-form-source.ts` (create)                           | Render a stored raw row as a plain-text extraction source. Pure, no deps.                                  |
| `packages/shopline/src/bulk-form-source.test.ts` (create)                      | Rendering content and the two exclusion rules.                                                             |
| `packages/shopline/src/index.ts` (modify)                                      | Export the renderer and the gaps function.                                                                 |
| `apps/web/lib/bulk-form-import.ts` (modify)                                    | Write the rendered document as the draft note.                                                             |
| `packages/db/src/schema.ts` (modify)                                           | `enrichmentBatches` and `enrichmentBatchItems` tables.                                                     |
| `packages/db/src/enrichment-batches-schema.test.ts` (create)                   | Column and composite-FK assertions, no Postgres needed.                                                    |
| `packages/db/drizzle/0005_enrichment_batches.sql` (create)                     | DDL, indexes, RLS policies, `wukong_app` grants.                                                           |
| `packages/db/src/repositories/ai-runs.ts` (modify)                             | `sumCostForListings` — observed spend for a set of drafts.                                                 |
| `packages/db/src/repositories/enrichment-batches.ts` (create)                  | Workspace-scoped batch and item access.                                                                    |
| `packages/db/src/repositories/enrichment-batches.integration.test.ts` (create) | Round-trip, wave claiming, isolation.                                                                      |
| `packages/db/src/client.ts`, `packages/db/src/index.ts` (modify)               | Wire and export the repository.                                                                            |
| `packages/db/src/cli/audit-verify.ts` (modify)                                 | Add both tables to `TENANT_TABLES`.                                                                        |
| `apps/web/lib/enrichment-batch-service.ts` (create)                            | Create a batch from a cohort; advance it within budget.                                                    |
| `apps/web/lib/enrichment-batch-service.test.ts` (create)                       | Cohort selection, budget stop, wave sizing, idempotency.                                                   |
| `apps/web/app/api/enrichment-batches/route.ts` (create)                        | `POST` create batch.                                                                                       |
| `apps/web/app/api/enrichment-batches/route.test.ts` (create)                   | Role and validation.                                                                                       |
| `apps/web/app/api/enrichment-batches/[id]/advance/route.ts` (create)           | `POST` advance batch.                                                                                      |
| `apps/web/app/api/enrichment-batches/[id]/advance/route.test.ts` (create)      | Role, budget-exhausted response.                                                                           |
| `docs/runbooks/shopline-pilot-onboarding.md` (modify)                          | Operator steps for running a budgeted enrichment.                                                          |

---

### Task 1: Expose the gaps computation as a reusable function

The batch service must select a cohort from `platform_products.rawRow`, which is a stored row rather than a parsed sheet. The gaps block is currently computed inline inside `parseRow`. Extract it — behaviour must not change.

**Files:**

- Modify: `packages/shopline/src/bulk-form.ts`
- Modify: `packages/shopline/src/bulk-form.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/shopline/src/bulk-form.test.ts`, inside the existing top-level `describe` list (as a new top-level `describe`):

```ts
describe("bulkFormGaps", () => {
  it("computes the same gaps from a stored row as the parser reports", () => {
    const parsed = parseBulkForm(sheetOf(dataRow()));
    const row = parsed.rows[0];
    if (row === undefined) throw new Error("fixture row did not parse");

    expect(bulkFormGaps(row.raw)).toEqual(row.gaps);
  });

  it("accepts a partial row, because a stored snapshot may omit blank columns", () => {
    expect(
      bulkFormGaps({ nameEn: "Demo Estate Riesling 2024", nameZh: null }),
    ).toMatchObject({ untranslatedName: true, summaryMissing: true });
  });

  it("treats a filled Chinese name as translated", () => {
    expect(
      bulkFormGaps({
        nameEn: "Demo Estate Riesling 2024",
        nameZh: "示範酒莊麗絲玲 2024",
      }).untranslatedName,
    ).toBe(false);
  });
});
```

Add `bulkFormGaps` to the existing import from `./bulk-form.js` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/shopline exec vitest run bulk-form.test
```

Expected: FAIL — `bulkFormGaps` is not exported.

- [ ] **Step 3: Extract the function**

In `packages/shopline/src/bulk-form.ts`, add this above `parseRow`:

```ts
/**
 * A stored snapshot may omit columns that were blank, so this accepts a partial
 * row rather than a complete one. Exported so a cohort can be selected from
 * `platform_products.rawRow` without re-parsing a sheet.
 */
export type BulkFormGapsInput = Readonly<
  Partial<Record<BulkFormColumnKey, string | null>>
>;

export function bulkFormGaps(raw: BulkFormGapsInput): BulkFormContentGaps {
  const nameEn = raw.nameEn ?? null;
  const nameZh = raw.nameZh ?? null;
  const seoTitleEn = raw.seoTitleEn ?? null;
  const seoTitleZh = raw.seoTitleZh ?? null;
  const seoDescriptionEn = raw.seoDescriptionEn ?? null;
  const summaryEn = raw.summaryEn ?? null;
  const summaryZh = raw.summaryZh ?? null;

  return {
    untranslatedName: nameZh === null || sameText(nameEn, nameZh),
    untranslatedSeoTitle:
      seoTitleZh === null || sameText(seoTitleEn, seoTitleZh),
    seoTitleMirrorsName: sameText(seoTitleEn, nameEn),
    seoDescriptionMirrorsSeoTitle: sameText(seoDescriptionEn, seoTitleEn),
    keywordsMirrorName: sameText(raw.seoKeywords ?? null, nameEn),
    summaryMissing: summaryEn === null && summaryZh === null,
  };
}
```

Then in `parseRow`, replace the inline `gaps: { … }` object literal with:

```ts
    gaps: bulkFormGaps(raw),
```

- [ ] **Step 4: Export it**

In `packages/shopline/src/index.ts`, add `bulkFormGaps` to the existing value export block from `./bulk-form.js`, and `BulkFormGapsInput` to the type export block.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @wukong/shopline test
```

Expected: PASS. The pre-existing gaps tests must still pass unchanged — that is the proof this refactor changed no behaviour.

- [ ] **Step 6: Commit**

```bash
git add packages/shopline/src/bulk-form.ts packages/shopline/src/bulk-form.test.ts packages/shopline/src/index.ts
git commit -m "refactor(shopline): expose bulk form gaps as a reusable function"
```

---

### Task 2: Render a row as an extraction source

**Files:**

- Create: `packages/shopline/src/bulk-form-source.ts`
- Create: `packages/shopline/src/bulk-form-source.test.ts`
- Modify: `packages/shopline/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shopline/src/bulk-form-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { renderBulkFormSource } from "./bulk-form-source.js";

const row = {
  nameEn: "Demo Estate Riesling 2024",
  nameZh: "PLACEHOLDER SHOULD NOT APPEAR",
  seoTitleEn: "SEO PLACEHOLDER SHOULD NOT APPEAR",
  seoKeywords: "KEYWORD PLACEHOLDER SHOULD NOT APPEAR",
  summaryEn: "SUMMARY PLACEHOLDER SHOULD NOT APPEAR",
  onlineStoreCategories: "White Wine>Germany>Mosel\nTop Picks",
  regularPrice: "100.0",
  salePrice: "80.0",
  productCost: "40.0",
  sku: "0001",
  quantity: "6",
  barcode: "1234567890123",
  supplier: "Demo Supplier Ltd",
  promotionLabelEn: "1500ML",
};

describe("renderBulkFormSource", () => {
  it("renders the stated product facts as labelled lines", () => {
    const source = renderBulkFormSource(row);

    expect(source).toContain("Product name: Demo Estate Riesling 2024");
    expect(source).toContain("SKU: 0001");
    expect(source).toContain("Categories: White Wine > Germany > Mosel");
    expect(source).toContain("Categories: Top Picks");
    expect(source).toContain("Regular price (HKD): 100.0");
    expect(source).toContain("Sale price (HKD): 80.0");
    expect(source).toContain("Barcode: 1234567890123");
    expect(source).toContain("Supplier: Demo Supplier Ltd");
    expect(source).toContain("Promotion label: 1500ML");
  });

  it("never renders the merchant's wholesale cost", () => {
    // Product Cost is the merchant's buying price. It has no bearing on
    // customer-facing copy and must not reach a prompt.
    expect(renderBulkFormSource(row)).not.toContain("40.0");
    expect(renderBulkFormSource(row).toLowerCase()).not.toContain("cost");
  });

  it("never renders the fields that are about to be generated", () => {
    // Feeding the existing placeholder Chinese name or SEO text back in as a
    // source invites the model to reproduce it.
    expect(renderBulkFormSource(row)).not.toContain("PLACEHOLDER");
  });

  it("omits blank fields rather than emitting empty labels", () => {
    const source = renderBulkFormSource({ nameEn: "Only a name", sku: null });

    expect(source).toBe("Product name: Only a name");
  });

  it("returns an empty string when the row states nothing usable", () => {
    expect(renderBulkFormSource({})).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/shopline exec vitest run bulk-form-source
```

Expected: FAIL — cannot resolve `./bulk-form-source.js`.

- [ ] **Step 3: Write the renderer**

Create `packages/shopline/src/bulk-form-source.ts`:

```ts
import type { BulkFormGapsInput } from "./bulk-form.js";

/**
 * Renders a stored bulk-form row as a plain-text document for the `extract`
 * step, which reads it as the draft's note.
 *
 * Two exclusions are deliberate and load-bearing:
 *
 * - The enrichable columns (Chinese name, summary, SEO fields) are absent.
 *   Those are what `generate` is about to write; for 499 of the pilot's 500
 *   products the Chinese name is just the English one, and feeding that back in
 *   as a source invites the model to reproduce the placeholder.
 * - `Product Cost` is absent. It is the merchant's wholesale price, it has no
 *   bearing on customer-facing copy, and it must not reach a prompt.
 *
 * Every line becomes potential evidence that `extract` may quote, so lines
 * carry only what the form states, never interpretation.
 */
export function renderBulkFormSource(raw: BulkFormGapsInput): string {
  const lines: string[] = [];
  const push = (label: string, value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return;
    lines.push(`${label}: ${trimmed}`);
  };

  push("Product name", raw.nameEn);
  push("SKU", raw.sku);

  // Newlines separate complete category paths; each becomes its own line so a
  // multi-category product does not read as one nonsensical path.
  for (const path of (raw.onlineStoreCategories ?? "").split(/\r?\n/)) {
    const segments = path
      .split(">")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length > 0) lines.push(`Categories: ${segments.join(" > ")}`);
  }

  push("Brand", raw.brand);
  push("Regular price (HKD)", raw.regularPrice);
  push("Sale price (HKD)", raw.salePrice);
  push("Stock quantity", raw.quantity);
  push("Barcode", raw.barcode);
  push("Manufacturer part number", raw.mpn);
  push("Supplier", raw.supplier);
  push("Promotion label", raw.promotionLabelEn);

  return lines.join("\n");
}
```

- [ ] **Step 4: Export it**

In `packages/shopline/src/index.ts`, after the `bulk-form-digest.js` export line, add:

```ts
export { renderBulkFormSource } from "./bulk-form-source.js";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @wukong/shopline test && pnpm --filter @wukong/shopline lint
```

Expected: all tests PASS, `lint` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shopline/src/bulk-form-source.ts packages/shopline/src/bulk-form-source.test.ts packages/shopline/src/index.ts
git commit -m "feat(shopline): render a bulk form row as an extraction source"
```

---

### Task 3: Importer writes the rendered note

**Files:**

- Modify: `apps/web/lib/bulk-form-import.ts`
- Modify: `apps/web/lib/bulk-form-import.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/bulk-form-import.test.ts` inside the existing `describe("bulk form importer", …)`:

```ts
it("writes a note the extract step can read, keeping provenance first", async () => {
  const { importBulkForm, recorded } = importerWith();

  await importBulkForm({
    workspaceId: "ws_opak",
    actorId: "user_1",
    sheet: sheetOf(rowFor()),
  });

  const note = recorded.created[0]?.note ?? "";
  expect(note.split("\n")[0]).toMatch(/^Imported from SHOPLINE bulk update/);
  expect(note).toContain("Product name: Demo Estate Riesling 2024");
  expect(note).toContain("Categories: White Wine > Germany > Mosel");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts
```

Expected: FAIL — the note contains only the provenance line.

- [ ] **Step 3: Render the note**

In `apps/web/lib/bulk-form-import.ts`, add `renderBulkFormSource` to the existing `@wukong/shopline` import.

Then replace the `listings.create` call:

```ts
const draft = await repositories.listings.create({
  target: "shopline",
  note: `Imported from SHOPLINE bulk update form ${parsed.specVersion}, row ${row.rowNumber}`,
});
```

with:

```ts
const draft = await repositories.listings.create({
  target: "shopline",
  // Provenance first so the note stays readable to an operator, then
  // the rendered row, which is what the extract step reads when this
  // draft is enriched.
  note: [
    `Imported from SHOPLINE bulk update form ${parsed.specVersion}, row ${row.rowNumber}`,
    "",
    renderBulkFormSource(rawRow),
  ].join("\n"),
});
```

- [ ] **Step 4: Write the failing test for the refresh path**

A note written at first import goes stale once a re-import changes the row, and
enrichment would then read data the merchant has already replaced. Add to
`apps/web/lib/bulk-form-import.test.ts`:

```ts
it("refreshes the note when a re-import changes the row", async () => {
  const { importBulkForm, recorded } = importerWith({
    remote_1: { listingId: "draft_existing", contentDigest: "stale" },
  });

  await importBulkForm({
    workspaceId: "ws_opak",
    actorId: "user_1",
    sheet: sheetOf(rowFor({ nameEn: "Renamed Estate Riesling 2024" })),
  });

  expect(recorded.notes).toEqual([
    {
      listingId: "draft_existing",
      note: expect.stringContaining(
        "Product name: Renamed Estate Riesling 2024",
      ),
    },
  ]);
});

it("does not touch the note when a re-import changes nothing", async () => {
  const first = importerWith();
  await first.importBulkForm({
    workspaceId: "ws_opak",
    actorId: "user_1",
    sheet: sheetOf(rowFor()),
  });
  const digest = first.recorded.upserts[0]?.contentDigest ?? "";

  const second = importerWith({
    remote_1: { listingId: "draft_existing", contentDigest: digest },
  });
  await second.importBulkForm({
    workspaceId: "ws_opak",
    actorId: "user_1",
    sheet: sheetOf(rowFor()),
  });

  expect(second.recorded.notes).toEqual([]);
});
```

Extend the `Recorded` type in that file with `notes: { listingId: string; note: string }[]`, initialise it to `[]` in `importerWith`, and add this to the fake `listings` repository:

```ts
              async updateNote(listingId: string, note: string) {
                recorded.notes.push({ listingId, note });
              },
```

- [ ] **Step 5: Run test to verify it fails**

```bash
pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts
```

Expected: FAIL — `repositories.listings.updateNote is not a function`.

- [ ] **Step 6: Add the repository method**

In `packages/db/src/repositories/listings.ts`, add to the `ListingRepository` type, after `create`:

```ts
  /**
   * Replaces the draft's note. Used when a re-import changes the source row:
   * the note is what the extract step reads, so a stale note means enrichment
   * runs on data the merchant has already replaced.
   */
  updateNote(id: string, note: string): Promise<void>;
```

Add the implementation after `create`:

```ts
    async updateNote(id, note) {
      scope.assertOpen();
      await transaction
        .update(listingDrafts)
        .set({ note, updatedAt: new Date() })
        .where(byId(id));
    },
```

`byId` is the existing helper in that file that scopes by workspace and ID.

- [ ] **Step 7: Refresh the note on the refresh path**

In `apps/web/lib/bulk-form-import.ts`, inside the `else` branch that handles an
existing draft, replace:

```ts
          } else {
            listingId = existingListingId;
            if (isRefresh) refreshedProducts += 1;
          }
```

with:

```ts
          } else {
            listingId = existingListingId;
            if (isRefresh) {
              refreshedProducts += 1;
              // The note is what the extract step reads, so a changed row must
              // update it or enrichment runs on data the merchant replaced.
              await repositories.listings.updateNote(
                listingId,
                [
                  `Imported from SHOPLINE bulk update form ${parsed.specVersion}, row ${row.rowNumber}`,
                  "",
                  renderBulkFormSource(rawRow),
                ].join("\n"),
              );
            }
          }
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts && pnpm lint
```

Expected: all PASS, typecheck 14/14.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/bulk-form-import.ts apps/web/lib/bulk-form-import.test.ts packages/db/src/repositories/listings.ts
git commit -m "feat(web): give imported drafts an extractable note"
```

---

### Task 4: Enrichment batch schema

**Files:**

- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/enrichment-batches-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/enrichment-batches-schema.test.ts`:

```ts
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  enrichmentBatchItems,
  enrichmentBatches,
  listingDrafts,
} from "./schema.js";

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

describe("enrichment batch schema", () => {
  it("records the approved budget and the wave size", () => {
    const columns = getTableColumns(enrichmentBatches);

    expect(columns.budgetUsd.notNull).toBe(true);
    expect(columns.waveSize.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.workspaceId.notNull).toBe(true);
  });

  it("keeps the item's batch and draft references tenant scoped", () => {
    const foreignKeys = foreignKeysOf(enrichmentBatchItems);

    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "batch_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: enrichmentBatches,
      onDelete: "cascade",
    });
    // Restrict, not cascade: an item is a spending record, and deleting a draft
    // must not erase evidence of what was spent on it.
    expect(foreignKeys).toContainEqual({
      columns: ["workspace_id", "listing_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: listingDrafts,
      onDelete: "restrict",
    });
  });

  it("admits one item per draft per batch", () => {
    const uniqueIndexes = getTableConfig(enrichmentBatchItems)
      .indexes.filter((index) => index.config.unique)
      .map((index) =>
        index.config.columns.map((column) => (column as { name: string }).name),
      );

    expect(uniqueIndexes).toContainEqual([
      "workspace_id",
      "batch_id",
      "listing_id",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/db exec vitest run src/enrichment-batches-schema.test.ts
```

Expected: FAIL — `enrichmentBatches` is not exported from `./schema.js`.

- [ ] **Step 3: Add the tables**

In `packages/db/src/schema.ts`, add after the `platformProducts` table (both referenced tables are declared above it):

```ts
export const enrichmentBatchStatus = pgEnum("enrichment_batch_status", [
  "open",
  "running",
  "completed",
  "budget_exhausted",
  "cancelled",
]);

export const enrichmentBatchItemStatus = pgEnum(
  "enrichment_batch_item_status",
  ["pending", "queued", "succeeded", "failed", "skipped"],
);

export const enrichmentBatches = pgTable(
  "enrichment_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    label: text("label").notNull(),
    /** USD, matching ai_runs.estimated_cost_usd. */
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 6 }).notNull(),
    /** Bounds how far a wave already in flight can overshoot the budget. */
    waveSize: integer("wave_size").notNull(),
    status: enrichmentBatchStatus("status").default("open").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("enrichment_batches_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    index("enrichment_batches_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  ],
);

export const enrichmentBatchItems = pgTable(
  "enrichment_batch_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    batchId: uuid("batch_id").notNull(),
    listingId: uuid("listing_id").notNull(),
    status: enrichmentBatchItemStatus("status").default("pending").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("enrichment_batch_items_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex("enrichment_batch_items_batch_listing_uq").on(
      table.workspaceId,
      table.batchId,
      table.listingId,
    ),
    index("enrichment_batch_items_workspace_batch_status_idx").on(
      table.workspaceId,
      table.batchId,
      table.status,
    ),
    index("enrichment_batch_items_workspace_listing_idx").on(
      table.workspaceId,
      table.listingId,
    ),
    foreignKey({
      name: "enrichment_batch_items_workspace_batch_fkey",
      columns: [table.workspaceId, table.batchId],
      foreignColumns: [enrichmentBatches.workspaceId, enrichmentBatches.id],
    }).onDelete("cascade"),
    // Restrict, not cascade: an item records money spent on a draft, and a
    // draft delete must not erase that record.
    foreignKey({
      name: "enrichment_batch_items_workspace_listing_fkey",
      columns: [table.workspaceId, table.listingId],
      foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
    }).onDelete("restrict"),
  ],
);
```

Confirm `pgEnum`, `numeric`, and `integer` are in the `drizzle-orm/pg-core` import at the top of the file; other tables already use all three, so they should be present. Add any that are missing.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @wukong/db exec vitest run src/enrichment-batches-schema.test.ts && pnpm --filter @wukong/db lint
```

Expected: 3 tests PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/enrichment-batches-schema.test.ts
git commit -m "feat(db): add enrichment batch schema"
```

---

### Task 5: Enrichment batch migration

**Files:**

- Create: `packages/db/drizzle/0005_enrichment_batches.sql`

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0005_enrichment_batches.sql`:

```sql
DO $enrichment_enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enrichment_batch_status') THEN
    CREATE TYPE enrichment_batch_status AS ENUM ('open', 'running', 'completed', 'budget_exhausted', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enrichment_batch_item_status') THEN
    CREATE TYPE enrichment_batch_item_status AS ENUM ('pending', 'queued', 'succeeded', 'failed', 'skipped');
  END IF;
END
$enrichment_enums$;

CREATE TABLE IF NOT EXISTS enrichment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL,
  budget_usd numeric(12, 6) NOT NULL,
  wave_size integer NOT NULL,
  status enrichment_batch_status NOT NULL DEFAULT 'open',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batches_workspace_id_uq
  ON enrichment_batches (workspace_id, id);
CREATE INDEX IF NOT EXISTS enrichment_batches_workspace_status_idx
  ON enrichment_batches (workspace_id, status);

CREATE TABLE IF NOT EXISTS enrichment_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  status enrichment_batch_item_status NOT NULL DEFAULT 'pending',
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrichment_batch_items_workspace_batch_fkey
    FOREIGN KEY (workspace_id, batch_id)
    REFERENCES enrichment_batches (workspace_id, id)
    ON DELETE CASCADE,
  -- Restrict, not cascade: an item records money spent on a draft, and a draft
  -- delete must not erase that record.
  CONSTRAINT enrichment_batch_items_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batch_items_workspace_id_uq
  ON enrichment_batch_items (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS enrichment_batch_items_batch_listing_uq
  ON enrichment_batch_items (workspace_id, batch_id, listing_id);
CREATE INDEX IF NOT EXISTS enrichment_batch_items_workspace_batch_status_idx
  ON enrichment_batch_items (workspace_id, batch_id, status);
CREATE INDEX IF NOT EXISTS enrichment_batch_items_workspace_listing_idx
  ON enrichment_batch_items (workspace_id, listing_id);

DO $enrichment_rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['enrichment_batches', 'enrichment_batch_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tenant_table || '_workspace_policy', tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO wukong_app USING (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), ''''))) WITH CHECK (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), '''')))',
      tenant_table || '_workspace_policy',
      tenant_table
    );
  END LOOP;
END
$enrichment_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE enrichment_batches, enrichment_batch_items
  TO wukong_app;
```

- [ ] **Step 2: Apply the migration**

```bash
pnpm --filter @wukong/db db:migrate
```

Expected: exits 0 with no error output.

- [ ] **Step 3: Verify RLS, grants, and the delete actions**

```bash
docker exec wukong-postgres psql -U wukong -d wukong -tAc "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('enrichment_batches','enrichment_batch_items');"
```

Expected: both rows show `t|t`.

```bash
docker exec wukong-postgres psql -U wukong -d wukong -tAc "select conname, confdeltype from pg_constraint where conrelid='enrichment_batch_items'::regclass and contype='f' order by conname;"
```

Expected: the batch FK shows `c` (cascade) and the listing FK shows `r` (restrict).

- [ ] **Step 4: Verify the migration is idempotent**

```bash
pnpm --filter @wukong/db db:migrate
```

Expected: exits 0 again. Every statement is guarded.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0005_enrichment_batches.sql
git commit -m "feat(db): migrate enrichment batch tables with rls"
```

---

### Task 6: Observed spend for a set of drafts

`estimated_cost_usd` is written with `.toFixed(6)` into a numeric column, so it comes back as a string and must be cast before summing.

**Files:**

- Modify: `packages/db/src/repositories/ai-runs.ts`
- Create: `packages/db/src/repositories/ai-runs.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/repositories/ai-runs.integration.test.ts`. Copy the harness (env URLs, `wukong_app` role bootstrap, truncate) from `packages/db/src/repositories/platform-products.integration.test.ts`, seeding a single workspace:

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
const workspaceId = "ws_airuns";

describe("ai run cost accounting", () => {
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
      INSERT INTO workspaces (id, name, profile)
      VALUES ('${workspaceId}', '${workspaceId}', '{}'::jsonb);
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("sums observed cost across the given drafts only", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const first = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const second = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      const run = (listingId: string, cost: number, key: string) =>
        repositories.aiRuns.append({
          listingId,
          task: "extract",
          idempotencyKey: key,
          provider: "fake",
          model: "fake-1",
          promptVersion: "1.0.0",
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 5,
          estimatedCostUsd: cost,
        });

      await run(first.id, 0.012_5, "k1");
      await run(first.id, 0.007_5, "k2");
      await run(second.id, 1.5, "k3");

      expect(
        await repositories.aiRuns.sumCostForListings([first.id]),
      ).toBeCloseTo(0.02, 6);
      expect(
        await repositories.aiRuns.sumCostForListings([first.id, second.id]),
      ).toBeCloseTo(1.52, 6);
    });
  });

  it("returns zero for an empty set rather than querying", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      expect(await repositories.aiRuns.sumCostForListings([])).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/db exec vitest run src/repositories/ai-runs.integration.test.ts
```

Expected: FAIL — `sumCostForListings` is not a function.

- [ ] **Step 3: Add the method**

In `packages/db/src/repositories/ai-runs.ts`, change the imports to:

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
```

Change the repository type to:

```ts
export type AiRunRepository = {
  append(input: AppendAiRunInput): Promise<void>;
  /**
   * Observed spend across the given drafts, in USD.
   *
   * `estimated_cost_usd` is a numeric column written via `toFixed(6)`, so it
   * returns as a string and must be cast before summing. Budgets are enforced
   * on this number rather than on a running total stored elsewhere, so the
   * budget can never drift out of sync with the runs it is counting.
   */
  sumCostForListings(listingIds: readonly string[]): Promise<number>;
};
```

Add the implementation inside the returned object, after `append`:

```ts
    async sumCostForListings(listingIds) {
      scope.assertOpen();
      if (listingIds.length === 0) return 0;
      const [row] = await transaction
        .select({
          total: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}::numeric), 0)::text`,
        })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, workspaceId),
            inArray(aiRuns.listingId, [...listingIds]),
          ),
        );
      return Number(row?.total ?? 0);
    },
```

The existing `and`/`eq` imports may currently be unused; keep whichever the file needs and let `tsc` tell you.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @wukong/db exec vitest run src/repositories/ai-runs.integration.test.ts && pnpm --filter @wukong/db lint
```

Expected: 2 tests PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/ai-runs.ts packages/db/src/repositories/ai-runs.integration.test.ts
git commit -m "feat(db): sum observed ai run cost for a set of drafts"
```

---

### Task 7: Enrichment batch repository and wiring

**Files:**

- Create: `packages/db/src/repositories/enrichment-batches.ts`
- Create: `packages/db/src/repositories/enrichment-batches.integration.test.ts`
- Modify: `packages/db/src/client.ts`, `packages/db/src/index.ts`, `packages/db/src/cli/audit-verify.ts`, `packages/db/src/cli/audit-verify.test.ts`

- [ ] **Step 1: Write the repository**

Create `packages/db/src/repositories/enrichment-batches.ts`:

```ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { enrichmentBatchItems, enrichmentBatches } from "../schema.js";

export type EnrichmentBatchStatus =
  "open" | "running" | "completed" | "budget_exhausted" | "cancelled";

export type EnrichmentBatchItemStatus =
  "pending" | "queued" | "succeeded" | "failed" | "skipped";

export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  createdBy: string;
};

export type CreateEnrichmentBatchInput = {
  label: string;
  budgetUsd: number;
  waveSize: number;
  createdBy: string;
  listingIds: readonly string[];
};

export type EnrichmentBatchCounts = Record<EnrichmentBatchItemStatus, number>;

export type EnrichmentBatchRepository = {
  create(input: CreateEnrichmentBatchInput): Promise<EnrichmentBatch>;
  getById(id: string): Promise<EnrichmentBatch | null>;
  listItemIds(batchId: string): Promise<string[]>;
  listItemsByStatus(
    batchId: string,
    status: EnrichmentBatchItemStatus,
  ): Promise<string[]>;
  countByStatus(batchId: string): Promise<EnrichmentBatchCounts>;
  /** Moves up to `limit` pending items to `queued` and returns their draft IDs. */
  claimWave(batchId: string, limit: number): Promise<string[]>;
  markItems(
    batchId: string,
    listingIds: readonly string[],
    status: EnrichmentBatchItemStatus,
  ): Promise<void>;
  setStatus(batchId: string, status: EnrichmentBatchStatus): Promise<void>;
};

const BATCH_COLUMNS = {
  id: enrichmentBatches.id,
  label: enrichmentBatches.label,
  budgetUsd: enrichmentBatches.budgetUsd,
  waveSize: enrichmentBatches.waveSize,
  status: enrichmentBatches.status,
  createdBy: enrichmentBatches.createdBy,
};

type BatchRow = Omit<EnrichmentBatch, "budgetUsd"> & { budgetUsd: string };

const toBatch = (row: BatchRow): EnrichmentBatch => ({
  ...row,
  budgetUsd: Number(row.budgetUsd),
});

const EMPTY_COUNTS: EnrichmentBatchCounts = {
  pending: 0,
  queued: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
};

export function createEnrichmentBatchRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): EnrichmentBatchRepository {
  return {
    async create(input) {
      scope.assertOpen();
      const [batch] = await transaction
        .insert(enrichmentBatches)
        .values({
          label: input.label,
          budgetUsd: input.budgetUsd.toFixed(6),
          waveSize: input.waveSize,
          createdBy: input.createdBy,
          workspaceId,
        })
        .returning(BATCH_COLUMNS);
      if (!batch)
        throw new Error("enrichment batch insert did not return a row");

      if (input.listingIds.length > 0) {
        await transaction.insert(enrichmentBatchItems).values(
          input.listingIds.map((listingId) => ({
            workspaceId,
            batchId: batch.id,
            listingId,
          })),
        );
      }
      return toBatch(batch);
    },

    async getById(id) {
      scope.assertOpen();
      const [batch] = await transaction
        .select(BATCH_COLUMNS)
        .from(enrichmentBatches)
        .where(
          and(
            eq(enrichmentBatches.workspaceId, workspaceId),
            eq(enrichmentBatches.id, id),
          ),
        )
        .limit(1);
      return batch ? toBatch(batch) : null;
    },

    async listItemIds(batchId) {
      scope.assertOpen();
      const rows = await transaction
        .select({ listingId: enrichmentBatchItems.listingId })
        .from(enrichmentBatchItems)
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.batchId, batchId),
          ),
        );
      return rows.map((row) => row.listingId);
    },

    async listItemsByStatus(batchId, status) {
      scope.assertOpen();
      const rows = await transaction
        .select({ listingId: enrichmentBatchItems.listingId })
        .from(enrichmentBatchItems)
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.batchId, batchId),
            eq(enrichmentBatchItems.status, status),
          ),
        );
      return rows.map((row) => row.listingId);
    },

    async countByStatus(batchId) {
      scope.assertOpen();
      const rows = await transaction
        .select({
          status: enrichmentBatchItems.status,
          count: sql<string>`count(*)::text`,
        })
        .from(enrichmentBatchItems)
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.batchId, batchId),
          ),
        )
        .groupBy(enrichmentBatchItems.status);

      const counts: EnrichmentBatchCounts = { ...EMPTY_COUNTS };
      for (const row of rows) counts[row.status] = Number(row.count);
      return counts;
    },

    async claimWave(batchId, limit) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("wave size must be between 1 and 1000");
      }
      // Claim and read in one statement so two concurrent advances cannot hand
      // out the same draft twice.
      const claimed = await transaction
        .update(enrichmentBatchItems)
        .set({ status: "queued", updatedAt: new Date() })
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.batchId, batchId),
            inArray(
              enrichmentBatchItems.id,
              transaction
                .select({ id: enrichmentBatchItems.id })
                .from(enrichmentBatchItems)
                .where(
                  and(
                    eq(enrichmentBatchItems.workspaceId, workspaceId),
                    eq(enrichmentBatchItems.batchId, batchId),
                    eq(enrichmentBatchItems.status, "pending"),
                  ),
                )
                .orderBy(asc(enrichmentBatchItems.createdAt))
                .limit(limit),
            ),
          ),
        )
        .returning({ listingId: enrichmentBatchItems.listingId });
      return claimed.map((row) => row.listingId);
    },

    async markItems(batchId, listingIds, status) {
      scope.assertOpen();
      if (listingIds.length === 0) return;
      await transaction
        .update(enrichmentBatchItems)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.batchId, batchId),
            inArray(enrichmentBatchItems.listingId, [...listingIds]),
          ),
        );
    },

    async setStatus(batchId, status) {
      scope.assertOpen();
      await transaction
        .update(enrichmentBatches)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(enrichmentBatches.workspaceId, workspaceId),
            eq(enrichmentBatches.id, batchId),
          ),
        );
    },
  };
}
```

- [ ] **Step 2: Add the draft-status lookup reconciliation needs**

Advancing a batch has to ask which queued drafts have reached a terminal state.
In `packages/db/src/repositories/listings.ts`, add to the `ListingRepository`
type, after `getById`:

```ts
  /**
   * Status for each of the given drafts, keyed by draft ID. Used to reconcile
   * batch items whose pipeline run has finished; asking per draft would be one
   * round trip per product.
   */
  statusesByIds(ids: readonly string[]): Promise<Record<string, ListingStatus>>;
```

And the implementation, after `getById`:

```ts
    async statusesByIds(ids) {
      scope.assertOpen();
      if (ids.length === 0) return {};
      const rows = await transaction
        .select({ id: listingDrafts.id, status: listingDrafts.status })
        .from(listingDrafts)
        .where(
          and(
            eq(listingDrafts.workspaceId, workspaceId),
            inArray(listingDrafts.id, [...ids]),
          ),
        );
      return Object.fromEntries(rows.map((row) => [row.id, row.status]));
    },
```

Add `inArray` to the `drizzle-orm` import at the top of that file if it is not
already there.

- [ ] **Step 3: Wire it into the workspace scope**

In `packages/db/src/client.ts` add the import:

```ts
import {
  createEnrichmentBatchRepository,
  type EnrichmentBatchRepository,
} from "./repositories/enrichment-batches.js";
```

Add to `WorkspaceRepositories`, after `platformProducts`:

```ts
enrichmentBatches: EnrichmentBatchRepository;
```

Add to the `repositories` object literal inside `runForWorkspace`, after the `platformProducts` entry:

```ts
        enrichmentBatches: createEnrichmentBatchRepository(
          transaction,
          workspaceId,
          scope,
        ),
```

In `packages/db/src/index.ts`, after the platform-products type export block:

```ts
export type {
  CreateEnrichmentBatchInput,
  EnrichmentBatch,
  EnrichmentBatchCounts,
  EnrichmentBatchItemStatus,
  EnrichmentBatchRepository,
  EnrichmentBatchStatus,
} from "./repositories/enrichment-batches.js";
```

- [ ] **Step 4: Extend the audit RLS probe**

In `packages/db/src/cli/audit-verify.ts`, add both table names to `TENANT_TABLES`, after `"platform_products"`:

```ts
  "enrichment_batches",
  "enrichment_batch_items",
```

The existing drift tests in `audit-verify.test.ts` derive the expected set from `schema.ts`, so they will fail until this is done — that is the guard working. Add an explicit assertion alongside the existing `platform_products` one:

```ts
it("includes the enrichment batch tables", () => {
  expect(TENANT_TABLES).toContain("enrichment_batches");
  expect(TENANT_TABLES).toContain("enrichment_batch_items");
});
```

- [ ] **Step 5: Write the integration test**

Create `packages/db/src/repositories/enrichment-batches.integration.test.ts` using the same harness as Task 6 (workspace `ws_batches`):

```ts
it("creates a batch with one item per draft and claims waves without overlap", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const drafts = [];
    for (let index = 0; index < 5; index += 1) {
      drafts.push(
        await repositories.listings.create({
          target: "shopline",
          note: null,
        }),
      );
    }

    const batch = await repositories.enrichmentBatches.create({
      label: "zh names",
      budgetUsd: 2.5,
      waveSize: 2,
      createdBy: "user_1",
      listingIds: drafts.map((draft) => draft.id),
    });

    expect(batch.budgetUsd).toBe(2.5);
    expect(
      await repositories.enrichmentBatches.countByStatus(batch.id),
    ).toMatchObject({
      pending: 5,
      queued: 0,
    });

    const firstWave = await repositories.enrichmentBatches.claimWave(
      batch.id,
      2,
    );
    const secondWave = await repositories.enrichmentBatches.claimWave(
      batch.id,
      2,
    );

    expect(firstWave).toHaveLength(2);
    expect(secondWave).toHaveLength(2);
    // A claimed draft must never be handed out twice.
    expect(new Set([...firstWave, ...secondWave]).size).toBe(4);
    expect(
      await repositories.enrichmentBatches.countByStatus(batch.id),
    ).toMatchObject({
      pending: 1,
      queued: 4,
    });
  });
});

it("records item outcomes and batch status", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const draft = await repositories.listings.create({
      target: "shopline",
      note: null,
    });
    const batch = await repositories.enrichmentBatches.create({
      label: "one",
      budgetUsd: 1,
      waveSize: 1,
      createdBy: "user_1",
      listingIds: [draft.id],
    });

    await repositories.enrichmentBatches.claimWave(batch.id, 1);
    await repositories.enrichmentBatches.markItems(
      batch.id,
      [draft.id],
      "succeeded",
    );
    await repositories.enrichmentBatches.setStatus(batch.id, "completed");

    expect(
      await repositories.enrichmentBatches.countByStatus(batch.id),
    ).toMatchObject({
      succeeded: 1,
    });
    expect(
      (await repositories.enrichmentBatches.getById(batch.id))?.status,
    ).toBe("completed");
  });
});

it("never returns another workspace's batch", async () => {
  await database.forWorkspace("ws_batches_other", async (repositories) => {
    expect(
      await repositories.enrichmentBatches.listItemIds(otherBatchId),
    ).toEqual([]);
  });
});
```

Seed a second workspace `ws_batches_other` in `beforeAll` the same way, and create `otherBatchId` in the first workspace during `beforeAll` so the isolation test has a real ID to ask for.

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @wukong/db exec vitest run src/repositories/enrichment-batches.integration.test.ts
pnpm --filter @wukong/db exec vitest run src/cli/audit-verify.test.ts
pnpm --filter @wukong/db exec vitest run src/cli/audit-verify.integration.test.ts
pnpm --filter @wukong/db lint
```

Expected: all PASS, lint clean. The `audit-verify` integration test proves both new tables are covered by the live-schema probe.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/enrichment-batches.ts packages/db/src/repositories/enrichment-batches.integration.test.ts packages/db/src/repositories/listings.ts packages/db/src/client.ts packages/db/src/index.ts packages/db/src/cli/audit-verify.ts packages/db/src/cli/audit-verify.test.ts
git commit -m "feat(db): add enrichment batch repository"
```

---

### Task 8: Batch service — create from a cohort

**Files:**

- Create: `apps/web/lib/enrichment-batch-service.ts`
- Create: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/enrichment-batch-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createEnrichmentBatchService } from "./enrichment-batch-service";

const untranslated = {
  remoteProductId: "remote_1",
  listingId: "draft_1",
  rawRow: { nameEn: "Demo Estate Riesling", nameZh: "Demo Estate Riesling" },
};
const translated = {
  remoteProductId: "remote_2",
  listingId: "draft_2",
  rawRow: { nameEn: "Demo Estate Riesling", nameZh: "示範酒莊麗絲玲" },
};
const unlinked = {
  remoteProductId: "remote_3",
  listingId: null,
  rawRow: { nameEn: "Never imported", nameZh: "Never imported" },
};

function serviceWith(products = [untranslated, translated, unlinked]) {
  const recorded: { created: unknown[] } = { created: [] };

  const service = createEnrichmentBatchService({
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          return work({
            platformProducts: {
              async listRecent() {
                return products;
              },
            },
            enrichmentBatches: {
              async create(input: unknown) {
                recorded.created.push(input);
                return {
                  id: "batch_1",
                  label: "x",
                  budgetUsd: 5,
                  waveSize: 10,
                  status: "open",
                  createdBy: "user_1",
                };
              },
            },
          });
        },
      }) as never,
    publisher: {
      async enqueue() {
        return { id: "job_1" };
      },
    },
  });

  return { service, recorded };
}

describe("enrichment batch creation", () => {
  it("selects only products whose rows show the requested gap", async () => {
    const { service, recorded } = serviceWith();

    const result = await service.createBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 5,
      waveSize: 10,
    });

    expect(result.selected).toBe(1);
    expect(
      (recorded.created[0] as { listingIds: string[] }).listingIds,
    ).toEqual(["draft_1"]);
  });

  it("skips products that have no draft to enrich", async () => {
    const { service, recorded } = serviceWith([unlinked]);

    await expect(
      service.createBatch({
        workspaceId: "ws_opak",
        actorId: "user_1",
        label: "zh names",
        gap: "untranslatedName",
        budgetUsd: 5,
        waveSize: 10,
      }),
    ).rejects.toThrow(/no products match/);
    expect(recorded.created).toEqual([]);
  });

  it("refuses a non-positive budget", async () => {
    const { service } = serviceWith();

    await expect(
      service.createBatch({
        workspaceId: "ws_opak",
        actorId: "user_1",
        label: "zh names",
        gap: "untranslatedName",
        budgetUsd: 0,
        waveSize: 10,
      }),
    ).rejects.toThrow(/budget/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts
```

Expected: FAIL — cannot resolve `./enrichment-batch-service`.

- [ ] **Step 3: Write the create half of the service**

Create `apps/web/lib/enrichment-batch-service.ts`:

```ts
import type { Database } from "@wukong/db";
import { bulkFormGaps, type BulkFormContentGaps } from "@wukong/shopline";

import type { ListingPublisher } from "./listing-queue-runtime.js";
import { ApiError } from "./route-support";

export type EnrichmentGap = keyof BulkFormContentGaps;

export type EnrichmentBatchServiceDeps = {
  getDatabase(): Database;
  publisher: ListingPublisher;
};

export type CreateBatchInput = {
  workspaceId: string;
  actorId: string;
  label: string;
  gap: EnrichmentGap;
  budgetUsd: number;
  waveSize: number;
};

export type CreateBatchResult = {
  batchId: string;
  selected: number;
  budgetUsd: number;
  waveSize: number;
};

/** Ten times the pilot catalog, matching the import cap. */
const MAX_BATCH_ITEMS = 5_000;

export function createEnrichmentBatchService(deps: EnrichmentBatchServiceDeps) {
  async function createBatch(
    input: CreateBatchInput,
  ): Promise<CreateBatchResult> {
    if (!(input.budgetUsd > 0)) {
      throw new ApiError(
        400,
        "invalid_budget",
        "A batch needs a budget greater than zero.",
      );
    }
    if (!Number.isInteger(input.waveSize) || input.waveSize < 1) {
      throw new ApiError(
        400,
        "invalid_wave_size",
        "Wave size must be a positive whole number.",
      );
    }

    return deps
      .getDatabase()
      .forWorkspace(input.workspaceId, async (repositories) => {
        const products =
          await repositories.platformProducts.listRecent(MAX_BATCH_ITEMS);

        // A product with no draft has nothing to enrich; the gap is computed
        // from the stored snapshot so the cohort is a query, not a hand-picked
        // list.
        const listingIds = products
          .filter((product) => product.listingId !== null)
          .filter((product) => bulkFormGaps(product.rawRow)[input.gap])
          .map((product) => product.listingId as string);

        if (listingIds.length === 0) {
          throw new ApiError(
            422,
            "empty_cohort",
            "No products match that gap, so there is nothing to enrich.",
          );
        }

        const batch = await repositories.enrichmentBatches.create({
          label: input.label,
          budgetUsd: input.budgetUsd,
          waveSize: input.waveSize,
          createdBy: input.actorId,
          listingIds,
        });

        await repositories.audit.write({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          entityId: batch.id,
          action: "enrichment_batch.created",
          metadata: {
            gap: input.gap,
            selected: listingIds.length,
            budgetUsd: input.budgetUsd,
            waveSize: input.waveSize,
          },
        });

        return {
          batchId: batch.id,
          selected: listingIds.length,
          budgetUsd: batch.budgetUsd,
          waveSize: batch.waveSize,
        };
      });
  }

  return { createBatch };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts && pnpm --filter @wukong/web lint
```

Expected: 3 tests PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "feat(web): create an enrichment batch from a gap cohort"
```

---

### Task 9: Batch service — advance within budget

**Files:**

- Modify: `apps/web/lib/enrichment-batch-service.ts`
- Modify: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/enrichment-batch-service.test.ts`:

```ts
function advanceServiceWith(options: {
  spent: number;
  budget: number;
  pending: string[];
  counts?: Record<string, number>;
}) {
  const enqueued: string[] = [];
  const statuses: string[] = [];
  let remaining = [...options.pending];

  const service = createEnrichmentBatchService({
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          return work({
            enrichmentBatches: {
              async getById() {
                return {
                  id: "batch_1",
                  label: "zh names",
                  budgetUsd: options.budget,
                  waveSize: 2,
                  status: "open",
                  createdBy: "user_1",
                };
              },
              async listItemIds() {
                return options.pending;
              },
              async claimWave(_batchId: string, limit: number) {
                const wave = remaining.slice(0, limit);
                remaining = remaining.slice(limit);
                return wave;
              },
              async countByStatus() {
                return {
                  pending: remaining.length,
                  queued: 0,
                  succeeded: 0,
                  failed: 0,
                  skipped: 0,
                  ...options.counts,
                };
              },
              async setStatus(_batchId: string, status: string) {
                statuses.push(status);
              },
              async markItems() {},
            },
            aiRuns: {
              async sumCostForListings() {
                return options.spent;
              },
            },
            audit: { async write() {} },
          });
        },
      }) as never,
    publisher: {
      async enqueue(job: { draftId: string }) {
        enqueued.push(job.draftId);
        return { id: `job_${job.draftId}` };
      },
    },
  });

  return { service, enqueued, statuses };
}

describe("enrichment batch advance", () => {
  it("enqueues one wave of existing listing jobs", async () => {
    const { service, enqueued } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1", "draft_2", "draft_3"],
    });

    const result = await service.advanceBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      batchId: "batch_1",
    });

    expect(enqueued).toEqual(["draft_1", "draft_2"]);
    expect(result.enqueued).toBe(2);
    expect(result.status).toBe("running");
  });

  it("stops and enqueues nothing once observed spend reaches the budget", async () => {
    const { service, enqueued, statuses } = advanceServiceWith({
      spent: 10,
      budget: 10,
      pending: ["draft_1", "draft_2"],
    });

    const result = await service.advanceBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      batchId: "batch_1",
    });

    expect(enqueued).toEqual([]);
    expect(result.status).toBe("budget_exhausted");
    expect(statuses).toContain("budget_exhausted");
  });

  it("completes the batch when nothing is left to do", async () => {
    const { service, statuses } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      counts: { pending: 0, queued: 0 },
    });

    const result = await service.advanceBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      batchId: "batch_1",
    });

    expect(result.status).toBe("completed");
    expect(statuses).toContain("completed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts
```

Expected: FAIL — `advanceBatch` is not a function.

- [ ] **Step 3: Write advance**

In `apps/web/lib/enrichment-batch-service.ts`, add these types above `createEnrichmentBatchService`:

```ts
export type AdvanceBatchInput = {
  workspaceId: string;
  actorId: string;
  batchId: string;
};

export type AdvanceBatchResult = {
  batchId: string;
  status: "running" | "completed" | "budget_exhausted";
  enqueued: number;
  spentUsd: number;
  budgetUsd: number;
};
```

Add this function inside `createEnrichmentBatchService`, before the `return`:

```ts
async function advanceBatch(
  input: AdvanceBatchInput,
): Promise<AdvanceBatchResult> {
  const plan = await deps
    .getDatabase()
    .forWorkspace(input.workspaceId, async (repositories) => {
      const batch = await repositories.enrichmentBatches.getById(input.batchId);
      if (!batch) {
        throw new ApiError(404, "batch_not_found", "No such enrichment batch.");
      }

      const itemIds = await repositories.enrichmentBatches.listItemIds(
        input.batchId,
      );

      // Reconcile before doing anything else. A queued draft that has since
      // reached a terminal state is no longer in flight, and until it is
      // recorded as such the batch can never report itself complete and a
      // failed product would look like work still pending.
      const queued = await repositories.enrichmentBatches.listItemsByStatus(
        input.batchId,
        "queued",
      );
      if (queued.length > 0) {
        const statuses = await repositories.listings.statusesByIds(queued);
        const succeeded = queued.filter((id) =>
          ["in_review", "approved", "publishing", "published"].includes(
            statuses[id] ?? "",
          ),
        );
        const failed = queued.filter((id) =>
          ["failed", "publish_failed"].includes(statuses[id] ?? ""),
        );
        await repositories.enrichmentBatches.markItems(
          input.batchId,
          succeeded,
          "succeeded",
        );
        // A failed product does not block the batch and is not retried here;
        // re-running failures is a new, separately budgeted batch.
        await repositories.enrichmentBatches.markItems(
          input.batchId,
          failed,
          "failed",
        );
      }

      // Budget is enforced on observed spend, never on a stored running
      // total, so it cannot drift out of sync with the runs it counts.
      const spentUsd = await repositories.aiRuns.sumCostForListings(itemIds);

      if (spentUsd >= batch.budgetUsd) {
        await repositories.enrichmentBatches.setStatus(
          input.batchId,
          "budget_exhausted",
        );
        return { batch, spentUsd, wave: [] as string[], done: false };
      }

      const wave = await repositories.enrichmentBatches.claimWave(
        input.batchId,
        batch.waveSize,
      );
      if (wave.length === 0) {
        const counts = await repositories.enrichmentBatches.countByStatus(
          input.batchId,
        );
        const done = counts.pending === 0 && counts.queued === 0;
        if (done) {
          await repositories.enrichmentBatches.setStatus(
            input.batchId,
            "completed",
          );
        }
        return { batch, spentUsd, wave, done };
      }

      await repositories.enrichmentBatches.setStatus(input.batchId, "running");
      return { batch, spentUsd, wave, done: false };
    });

  if (plan.wave.length === 0) {
    return {
      batchId: input.batchId,
      status:
        plan.spentUsd >= plan.batch.budgetUsd
          ? "budget_exhausted"
          : plan.done
            ? "completed"
            : "running",
      enqueued: 0,
      spentUsd: plan.spentUsd,
      budgetUsd: plan.batch.budgetUsd,
    };
  }

  // Enqueue outside the transaction: the queue is a remote service and must
  // not hold a pooled connection open. Items are already `queued`, so a
  // failure here leaves them claimed rather than silently re-runnable.
  let enqueued = 0;
  for (const draftId of plan.wave) {
    await deps.publisher.enqueue({
      workspaceId: input.workspaceId,
      draftId,
      activeVersionSequence: 0,
    });
    enqueued += 1;
  }

  await deps
    .getDatabase()
    .forWorkspace(input.workspaceId, async (repositories) => {
      await repositories.audit.write({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        entityId: input.batchId,
        action: "enrichment_batch.advanced",
        metadata: {
          enqueued,
          spentUsd: plan.spentUsd,
          budgetUsd: plan.batch.budgetUsd,
        },
      });
    });

  console.info(
    JSON.stringify({
      event: "enrichment_batch.advanced",
      workspaceId: input.workspaceId,
      batchId: input.batchId,
      enqueued,
      spentUsd: plan.spentUsd,
      budgetUsd: plan.batch.budgetUsd,
    }),
  );

  return {
    batchId: input.batchId,
    status: "running",
    enqueued,
    spentUsd: plan.spentUsd,
    budgetUsd: plan.batch.budgetUsd,
  };
}
```

Change the final return to:

```ts
return { createBatch, advanceBatch };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts && pnpm --filter @wukong/web lint
```

Expected: 6 tests PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "feat(web): advance an enrichment batch within its budget"
```

---

### Task 10: Routes

**Files:**

- Create: `apps/web/app/api/enrichment-batches/route.ts`
- Create: `apps/web/app/api/enrichment-batches/route.test.ts`
- Create: `apps/web/app/api/enrichment-batches/[id]/advance/route.ts`
- Create: `apps/web/app/api/enrichment-batches/[id]/advance/route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/app/api/enrichment-batches/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createEnrichmentBatchHandler } from "./route.js";

const okResult = {
  batchId: "batch_1",
  selected: 42,
  budgetUsd: 5,
  waveSize: 10,
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  createBatch = async () => okResult,
) {
  return createEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    createBatch,
  });
}

const post = (body: unknown) =>
  new Request("http://localhost/api/enrichment-batches", {
    method: "POST",
    body: JSON.stringify(body),
  });

const validBody = {
  label: "zh names",
  gap: "untranslatedName",
  budgetUsd: 5,
  waveSize: 10,
};

describe("POST /api/enrichment-batches", () => {
  it("creates a batch for an operator", async () => {
    const response = await handlerFor("operator")(post(validBody));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      batchId: "batch_1",
      selected: 42,
    });
  });

  it("refuses a viewer without creating anything", async () => {
    let called = 0;
    const handler = handlerFor("viewer", async () => {
      called += 1;
      return okResult;
    });

    expect((await handler(post(validBody))).status).toBe(403);
    expect(called).toBe(0);
  });

  it("rejects an unknown gap", async () => {
    const response = await handlerFor("operator")(
      post({ ...validBody, gap: "notAGap" }),
    );

    expect(response.status).toBe(400);
  });
});
```

Create `apps/web/app/api/enrichment-batches/[id]/advance/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createAdvanceEnrichmentBatchHandler } from "./route.js";

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  status: "running" | "completed" | "budget_exhausted" = "running",
) {
  return createAdvanceEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    advanceBatch: async () => ({
      batchId: "batch_1",
      status,
      enqueued: status === "running" ? 2 : 0,
      spentUsd: 1.5,
      budgetUsd: 5,
    }),
  });
}

const request = new Request(
  "http://localhost/api/enrichment-batches/batch_1/advance",
  { method: "POST" },
);
const context = { params: Promise.resolve({ id: "batch_1" }) };

describe("POST /api/enrichment-batches/[id]/advance", () => {
  it("advances for an operator and reports the wave", async () => {
    const response = await handlerFor("operator")(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enqueued: 2,
      status: "running",
    });
  });

  it("reports an exhausted budget without failing the request", async () => {
    const response = await handlerFor("operator", "budget_exhausted")(
      request,
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "budget_exhausted",
      enqueued: 0,
    });
  });

  it("refuses a viewer", async () => {
    expect((await handlerFor("viewer")(request, context)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @wukong/web exec vitest run "app/api/enrichment-batches"
```

Expected: FAIL — cannot resolve `./route.js` for both.

- [ ] **Step 3: Write the create route**

Create `apps/web/app/api/enrichment-batches/route.ts`:

```ts
import { z } from "zod";

import {
  createEnrichmentBatchService,
  type CreateBatchInput,
  type CreateBatchResult,
} from "../../../lib/enrichment-batch-service";
import { getDatabase } from "../../../lib/intake-runtime";
import { listingPublisher } from "../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

const bodySchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    gap: z.enum([
      "untranslatedName",
      "untranslatedSeoTitle",
      "seoTitleMirrorsName",
      "seoDescriptionMirrorsSeoTitle",
      "keywordsMirrorName",
      "summaryMissing",
    ]),
    budgetUsd: z.number().positive().max(10_000),
    waveSize: z.number().int().min(1).max(500),
  })
  .strict();

export type EnrichmentBatchRouteDeps = {
  sessionContext: SessionContextPort;
  createBatch(input: CreateBatchInput): Promise<CreateBatchResult>;
};

export function createEnrichmentBatchHandler(deps: EnrichmentBatchRouteDeps) {
  return async function createEnrichmentBatch(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const body = bodySchema.parse(await request.json());
      const result = await deps.createBatch({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        ...body,
      });

      return jsonResponse(201, result);
    });
  };
}

const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const POST = createEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  createBatch: service.createBatch,
});
```

- [ ] **Step 4: Write the advance route**

Create `apps/web/app/api/enrichment-batches/[id]/advance/route.ts`:

```ts
import {
  createEnrichmentBatchService,
  type AdvanceBatchInput,
  type AdvanceBatchResult,
} from "../../../../../lib/enrichment-batch-service";
import { getDatabase } from "../../../../../lib/intake-runtime";
import { listingPublisher } from "../../../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

export type AdvanceRouteDeps = {
  sessionContext: SessionContextPort;
  advanceBatch(input: AdvanceBatchInput): Promise<AdvanceBatchResult>;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createAdvanceEnrichmentBatchHandler(deps: AdvanceRouteDeps) {
  return async function advanceEnrichmentBatch(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const { id } = await context.params;
      // An exhausted budget is a normal outcome, not a failure: the operator
      // asked whether there was more to do and the answer is no.
      const result = await deps.advanceBatch({
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        batchId: id,
      });

      return jsonResponse(200, result);
    });
  };
}

const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const POST = createAdvanceEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  advanceBatch: service.advanceBatch,
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @wukong/web exec vitest run "app/api/enrichment-batches" && pnpm --filter @wukong/web lint
```

Expected: 6 tests PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/enrichment-batches
git commit -m "feat(web): add enrichment batch routes"
```

---

### Task 11: Runbook and full verification

**Files:**

- Modify: `docs/runbooks/shopline-pilot-onboarding.md`

- [ ] **Step 1: Document the operator flow**

Append to `docs/runbooks/shopline-pilot-onboarding.md`:

````markdown
## 5. Enriching an imported catalog

Enrichment costs real money proportional to catalog size, so it runs as an
explicitly budgeted batch rather than automatically at import.

1. Create a batch for one gap. `budgetUsd` is the ceiling for the whole batch;
   `waveSize` is how many products are released at a time.

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/enrichment-batches" \
     -H "Cookie: $WUKONG_SESSION_COOKIE" \
     -H "Content-Type: application/json" \
     -d '{"label":"zh names","gap":"untranslatedName","budgetUsd":5,"waveSize":25}'
   ```

   Valid gaps: `untranslatedName`, `untranslatedSeoTitle`, `seoTitleMirrorsName`,
   `seoDescriptionMirrorsSeoTitle`, `keywordsMirrorName`, `summaryMissing`.
   The response reports how many products were selected.

2. Release a wave:

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/enrichment-batches/<batch-id>/advance" \
     -H "Cookie: $WUKONG_SESSION_COOKIE"
   ```

   The response reports `enqueued`, `spentUsd`, `budgetUsd`, and `status`.
   Repeat once a wave has drained. `status: "completed"` means there is nothing
   left; `status: "budget_exhausted"` means the budget is spent and no further
   work will be released.

3. Enriched drafts land in the normal review queue as `in_review`. Nothing is
   written back to SHOPLINE by this flow.

**Budget is a stop condition between waves, not a hard ceiling within one.** A
wave already in flight can overshoot by at most the cost of that wave, so size
`waveSize` for the overshoot you are willing to accept. Spend is measured from
`ai_runs.estimated_cost_usd`, which is the actual recorded cost of each run.
````

- [ ] **Step 2: Run the full gate**

```bash
pnpm lint && pnpm test
```

Expected: typecheck 14/14 successful; all unit suites pass.

- [ ] **Step 3: Run the integration suites**

```bash
pnpm test:integration
```

Expected: PASS, including the two new integration test files.

- [ ] **Step 4: Verify the format gate**

```bash
pnpm format:runtime:check
```

Expected: exits 0. If it reports files needing Prettier, run
`npx prettier --write <files>` and re-check. **Do not add a format-debt waiver.**

- [ ] **Step 5: Verify the release gate still reports zero leakage**

```bash
pnpm --filter @wukong/db exec tsx src/cli/audit-verify.ts --workspace ws_opak --draft <an-enriched-draft-id>
```

Expected: `accessible foreign record count: 0`. Run this with the **runtime**
role in `DATABASE_URL` (`wukong_app`), not the admin role — the admin role
bypasses RLS and is the control case, not the gate.

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md
git commit -m "docs: describe the budgeted enrichment flow"
```

---

## Follow-on plans

1. **Bulk review UX (roadmap 1c)** — batch-approve low-risk field classes, keep per-item review for claims-bearing copy.
2. **Exporter delivery (roadmap 1d)** — wire `createBulkFormUpdate` into the delivery module, deciding create-vs-update from `platform_products`.
3. **Automatic advance** — replace operator-triggered advance with advance-on-wave-completion.
4. **Catalog hygiene report (roadmap 1e)** — surface the `gaps` and inventory aggregates, now that `bulkFormGaps` is reusable.
