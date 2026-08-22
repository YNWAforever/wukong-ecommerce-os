# SHOPLINE Update-After-Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a reviewer re-delivers an already-published, since-edited, re-approved listing via `shopline_api`, the system calls `updateProduct` against the same remote SHOPLINE product instead of creating a duplicate — covering both listings imported from SHOPLINE and listings Wukong created and published itself.

**Architecture:** `platform_products` becomes the one place any listing's known remote-product link lives (today it's written only by bulk-form import). `evaluateDeliveryPolicy` (`packages/shopline`) becomes the single place that turns "does a link exist" into an idempotency key and a create/update decision, via a new `platformProductLink` input and a new shared `shoplinePublishIdempotencyKey` helper — every caller (the request-phase web route, the worker) supplies the link it already looked up, and gets a consistent key and action back. The worker branches on that action to call `createProduct` or `updateProduct`, then upserts `platform_products` on success either way.

**Tech Stack:** TypeScript 7 (5.9 in `apps/web`), Drizzle ORM, Postgres, Next.js App Router route handlers, Cloudflare Workers, Vitest, zod v4.

---

## Prerequisites

Read `docs/superpowers/specs/2026-08-21-shopline-update-after-publish-design.md` before starting — every decision below cites it.

### Local services

Task 1 and Task 2's tests need Postgres on port 54329 with the `wukong_app` role: `docker exec wukong-postgres pg_isready -U wukong`, or `docker compose up -d postgres` per `docs/runbooks/local-development.md`.

## Hard constraints

- **`platformProducts.upsert`'s `.onConflictDoUpdate` REPLACES every field in `set`, it does not merge.** Task 5's worker upsert on the update path must pass through the existing row's `sku`/`specVersion`/`rawRow`/`factsPrefill`/`contentDigest` unchanged (from the `existingLink` it already has), or an update-publish of an _imported_ listing would silently wipe its bulk-form import data. This is the single most important correctness property in this plan — get it wrong and `platform_products` quietly corrupts for every workspace that mixes import and direct-create-publish.
- **`enrichmentBatchService.createBatch` must filter to `origin === "import"`** before calling `bulkFormGaps(product.rawRow)` (Task 6) — a required regression fix, not optional cleanup. Skipping it means this plan ships enrichment-batch creation broken for any workspace with a create-origin `platform_products` row.
- **No change to `createBulkFormUpdate`'s, `writeBulkFormWorkbook`'s, or `deliverBulkForm`'s behavior.** `deliverBulkForm` already handles a create-origin row correctly today via its existing `isBulkFormRawRow(link.rawRow)` guard (confirmed during planning: a `null` `rawRow` fails that guard and returns `validation_error`, not a crash) — Task 6 adds a regression test proving this, not a code change to `deliverBulkForm` itself.
- **The `ShoplinePublishJob` queue message schema does not change.** No new field. The create-vs-update decision is made by looking up `platform_products` fresh, at processing time, in `apps/worker/src/shopline-consumer.ts`, immediately before the code that already builds an idempotency key there.

## File Structure

| File                                                                 | Change | Responsibility                                                                            |
| -------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `packages/db/drizzle/0008_shopline_update_after_publish.sql`         | Create | Add `origin`, widen 5 columns to nullable                                                 |
| `packages/db/src/schema.ts`                                          | Modify | Match the migration in Drizzle's schema                                                   |
| `packages/db/src/repositories/platform-products.ts`                  | Modify | Widen `PlatformProduct`/`UpsertPlatformProductInput`, add `origin`                        |
| `packages/db/src/repositories/platform-products.integration.test.ts` | Modify | Prove nullability and `origin` against real Postgres                                      |
| `apps/web/lib/bulk-form-import.ts`                                   | Modify | Pass `origin: "import"` explicitly                                                        |
| `apps/web/lib/bulk-form-import.test.ts`                              | Modify | Prove it                                                                                  |
| `packages/shopline/src/delivery-policy.ts`                           | Modify | `shoplinePublishIdempotencyKey` helper; `platformProductLink` input; `action` on the plan |
| `packages/shopline/src/delivery-policy.test.ts`                      | Modify | Prove both key variants                                                                   |
| `packages/shopline/src/index.ts`                                     | Modify | Export the new helper                                                                     |
| `apps/worker/src/publish-product.ts`                                 | Modify | `existingLink` input; create/update branch; upsert `platform_products` on success         |
| `apps/worker/src/publish-product.test.ts`                            | Modify | Prove the update branch and the upsert                                                    |
| `apps/worker/src/shopline-consumer.ts`                               | Modify | Look up `platformProducts` before `claim()`; use the shared key helper                    |
| `apps/worker/src/shopline-consumer.test.ts`                          | Modify | Prove the lookup feeds the right key and `existingLink`                                   |
| `apps/web/lib/delivery-service.ts`                                   | Modify | Snapshot reader fetches `platformProductLink`; thread it into policy calls                |
| `apps/web/lib/delivery-service.review-fix.test.ts`                   | Modify | Prove the request-phase key matches the worker's                                          |
| `apps/web/app/api/listings/[id]/route.ts`                            | Modify | Add `shoplineLink`; use the shared key helper                                             |
| `apps/web/app/api/listings/[id]/route.test.ts`                       | Modify | Prove `shoplineLink`                                                                      |
| `apps/web/components/listing-view-models.ts`                         | Modify | `DeliveryModel` gains `shoplineLink`                                                      |
| `apps/web/components/delivery-panel.tsx`                             | Modify | Show create-vs-update message                                                             |
| `apps/web/components/delivery-panel.test.tsx`                        | Modify | Prove both messages render                                                                |
| `apps/web/lib/enrichment-batch-service.ts`                           | Modify | Filter cohort scan to `origin === "import"`                                               |
| `apps/web/lib/enrichment-batch-service.test.ts`                      | Modify | Prove the filter                                                                          |
| `docs/runbooks/shopline-pilot-onboarding.md`                         | Modify | Document the update-after-publish flow                                                    |
| `CONTEXT.md`                                                         | Modify | Extend the "Shopline bulk form" / add a "platform product link" domain entry              |

---

### Task 1: `platform_products` schema — `origin` column, five columns become nullable

**Files:**

- Create: `packages/db/drizzle/0008_shopline_update_after_publish.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0008_shopline_update_after_publish.sql`:

```sql
-- platform_products stops being import-only. A listing Wukong created and
-- published itself now gets a row too (origin: 'created'), written on a
-- successful createProduct so a later re-publish can find it and call
-- updateProduct instead of creating a duplicate. The import-specific columns
-- (sku, spec_version, raw_row, facts_prefill, content_digest) have no honest
-- value for a create-origin row -- there was no imported sheet to derive
-- them from -- so they become nullable rather than fabricated.
ALTER TABLE platform_products
  ADD COLUMN origin text;

UPDATE platform_products SET origin = 'import' WHERE origin IS NULL;

ALTER TABLE platform_products
  ALTER COLUMN origin SET NOT NULL,
  ADD CONSTRAINT platform_products_origin_check
    CHECK (origin IN ('import', 'created')),
  ALTER COLUMN sku DROP NOT NULL,
  ALTER COLUMN spec_version DROP NOT NULL,
  ALTER COLUMN raw_row DROP NOT NULL,
  ALTER COLUMN facts_prefill DROP NOT NULL,
  ALTER COLUMN content_digest DROP NOT NULL;
```

The `UPDATE ... WHERE origin IS NULL` backfill runs before the `NOT NULL`
constraint is added, so every existing row (all of which came from import,
since this table had no other writer before this plan) becomes `origin =
'import'` without a migration failure on non-empty tables.

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm --filter @wukong/db db:migrate`
Expected: exits 0, no errors. If Postgres isn't running, see Prerequisites above.

- [ ] **Step 3: Update the Drizzle schema to match**

Read `packages/db/src/schema.ts` around the `platformProducts` table (search
for `export const platformProducts = pgTable`). Replace the column
definitions and add the check constraint. The full block, with the changes
applied:

```ts
export const platformProducts = pgTable(
  "platform_products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    connectionId: uuid("connection_id").notNull(),
    /** The platform's own product ID — the join key a listing has never carried. */
    remoteProductId: text("remote_product_id").notNull(),
    /** "import": from the bulk-form catalog importer. "created": from a
     * successful shopline_api createProduct for a listing Wukong made itself. */
    origin: text("origin").notNull(),
    /** Null for a "created"-origin row — there is no imported sheet row. */
    sku: text("sku"),
    /** Null until a draft is created for this product. */
    listingId: uuid("listing_id"),
    specVersion: text("spec_version"),
    rawRow: jsonb("raw_row").$type<Record<string, string | null>>(),
    factsPrefill: jsonb("facts_prefill").$type<ListingFacts>(),
    contentDigest: text("content_digest"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("platform_products_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex("platform_products_workspace_connection_remote_uq").on(
      table.workspaceId,
      table.connectionId,
      table.remoteProductId,
    ),
    index("platform_products_workspace_listing_idx").on(
      table.workspaceId,
      table.listingId,
    ),
    check(
      "platform_products_origin_check",
      sql`origin IN ('import', 'created')`,
    ),
    foreignKey({
      name: "platform_products_workspace_connection_fkey",
      columns: [table.workspaceId, table.connectionId],
      foreignColumns: [shoplineConnections.workspaceId, shoplineConnections.id],
    }).onDelete("cascade"),
    // Restrict, not cascade: this row mirrors a product that exists on the
    // platform whether or not Wukong keeps a draft for it, and its digest is the only
    // thing that tells an unchanged re-import from a real catalog change (for
    // import-origin rows; created-origin rows have no digest at all).
    foreignKey({
      name: "platform_products_workspace_listing_fkey",
      columns: [table.workspaceId, table.listingId],
      foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
    }).onDelete("restrict"),
  ],
);
```

Confirm `check` is already imported from `drizzle-orm/pg-core` at the top of
`schema.ts` (search the existing import block); if not, add it alongside the
other `pgTable`/`text`/`uuid` imports already there. Confirm `sql` is already
imported from `drizzle-orm` (it is — used elsewhere in this file); reuse that
import.

- [ ] **Step 4: Verify the schema compiles and matches the DB**

Run: `pnpm --filter @wukong/db lint`
Expected: passes. This only typechecks — Task 2's tests are what prove the
schema and migration actually agree with each other against real Postgres.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0008_shopline_update_after_publish.sql packages/db/src/schema.ts
git commit -m "feat(db): add platform_products.origin, widen import-only columns to nullable"
```

---

### Task 2: `platform-products.ts` repository — widen types, add `origin`

**Files:**

- Modify: `packages/db/src/repositories/platform-products.ts`
- Modify: `packages/db/src/repositories/platform-products.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Read `packages/db/src/repositories/platform-products.integration.test.ts` in
full first — reuse its exact `workspaceId`/`connectionId`/`factsFixture`
setup (seeded once in `beforeAll`) rather than inventing new fixtures. Append
inside the existing `describe` block:

```ts
it("upserts a create-origin row with every import-specific field null", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const draft = await repositories.listings.create({
      target: "shopline",
      note: null,
    });

    const created = await repositories.platformProducts.upsert({
      connectionId,
      remoteProductId: "remote_created_1",
      origin: "created",
      sku: null,
      listingId: draft.id,
      specVersion: null,
      rawRow: null,
      factsPrefill: null,
      contentDigest: null,
    });

    expect(created.origin).toBe("created");
    expect(created.sku).toBeNull();
    expect(created.specVersion).toBeNull();
    expect(created.rawRow).toBeNull();
    expect(created.factsPrefill).toBeNull();
    expect(created.contentDigest).toBeNull();

    const found = await repositories.platformProducts.getByListingId(draft.id);
    expect(found?.origin).toBe("created");
  });
});

it("preserves an import-origin row's import fields when re-upserted with the same values", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const draft = await repositories.listings.create({
      target: "shopline",
      note: null,
    });

    const importInput = {
      connectionId,
      remoteProductId: "remote_import_1",
      origin: "import" as const,
      sku: "SKU-IMPORT-1",
      listingId: draft.id,
      specVersion: "opak-2026-05",
      rawRow: { productId: "remote_import_1", sku: "SKU-IMPORT-1" },
      factsPrefill: factsFixture,
      contentDigest: "c".repeat(64),
    };
    await repositories.platformProducts.upsert(importInput);

    // Simulate the worker's update-path upsert: re-supplies the same
    // import fields it read back from getByListingId, unchanged.
    const reUpserted = await repositories.platformProducts.upsert(importInput);

    expect(reUpserted.origin).toBe("import");
    expect(reUpserted.sku).toBe("SKU-IMPORT-1");
    expect(reUpserted.rawRow).toEqual({
      productId: "remote_import_1",
      sku: "SKU-IMPORT-1",
    });
    expect(reUpserted.contentDigest).toBe("c".repeat(64));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/platform-products.integration.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'origin' does not exist in type 'UpsertPlatformProductInput'` (a type error, since Step 3 hasn't widened the types yet). If your editor/tsc catches this before the test even runs, that is the expected failure for this step.

- [ ] **Step 3: Widen the repository's types**

In `packages/db/src/repositories/platform-products.ts`, replace the
`PlatformProduct` and `UpsertPlatformProductInput` types:

```ts
export type PlatformProductOrigin = "import" | "created";

export type PlatformProduct = {
  id: string;
  connectionId: string;
  remoteProductId: string;
  origin: PlatformProductOrigin;
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  rawRow: Record<string, string | null> | null;
  factsPrefill: ListingFacts | null;
  contentDigest: string | null;
};

export type UpsertPlatformProductInput = {
  connectionId: string;
  remoteProductId: string;
  origin: PlatformProductOrigin;
  sku: string | null;
  /**
   * The caller supplies the draft this product is linked to, including when it
   * is re-supplying an existing one. An upsert that passed null here would
   * unlink a product that already has a draft.
   */
  listingId: string | null;
  specVersion: string | null;
  rawRow: Record<string, string | null> | null;
  factsPrefill: ListingFacts | null;
  /**
   * MUST be `hashBulkFormRow(rawRow)` for an "import"-origin row — a digest
   * that disagrees with its row reads as "unchanged" on the next import,
   * which is a silent false negative in the only mechanism that detects a
   * real catalog change. Null for a "created"-origin row, which has no
   * imported row to hash. The repository cannot derive it here without
   * coupling `@wukong/db` to a specific connector's row type, so the caller
   * owns the invariant.
   */
  contentDigest: string | null;
};
```

Update `COLUMNS` to include `origin: platformProducts.origin,` (add it
anywhere in the object, e.g. right after `remoteProductId`).

`toPlatformProduct` and `validatedValues` both call
`listingFactsSchema.parse(...)` unconditionally on `factsPrefill`, which now
needs to tolerate `null`. Replace both:

```ts
const toPlatformProduct = (row: PlatformProductRow): PlatformProduct => ({
  ...row,
  factsPrefill:
    row.factsPrefill === null
      ? null
      : listingFactsSchema.parse(row.factsPrefill),
});

const validatedValues = (
  input: UpsertPlatformProductInput,
  workspaceId: string,
) => ({
  ...input,
  factsPrefill:
    input.factsPrefill === null
      ? null
      : listingFactsSchema.parse(input.factsPrefill),
  workspaceId,
});
```

`PlatformProductRow`'s `factsPrefill: unknown` override stays as-is — `unknown`
already accommodates `null`.

In `upsert`'s and `upsertMany`'s `.onConflictDoUpdate({ set: {...} })` blocks,
add `origin` to both `set` objects (`upsert`: `origin: input.origin,`;
`upsertMany`: `origin: sql\`excluded.origin\`,`), placed alongside the
existing `sku`/`listingId`/etc. entries.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/platform-products.integration.test.ts`
Expected: PASS, all tests including the two new ones and every pre-existing test unchanged.

- [ ] **Step 5: Full package verification**

Run: `pnpm --filter @wukong/db test && pnpm --filter @wukong/db test:integration && pnpm --filter @wukong/db lint`
Expected: all pass, no regressions in `enrichment-batch`/`bulk-form-import`-adjacent tests in this package (there are none directly in `@wukong/db`, but this catches anything unexpected).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/platform-products.ts packages/db/src/repositories/platform-products.integration.test.ts
git commit -m "feat(db): widen platform_products repository for create-origin rows"
```

---

### Task 3: `shoplinePublishIdempotencyKey` helper + `platformProductLink` on the delivery policy

**Files:**

- Modify: `packages/shopline/src/delivery-policy.ts`
- Modify: `packages/shopline/src/delivery-policy.test.ts`
- Modify: `packages/shopline/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Read `packages/shopline/src/delivery-policy.test.ts` in full first — reuse
its exact `input()` fixture builder and `workspaceId`/`versionId` constants.
Append inside the existing `describe` block:

```ts
it("builds a create-action idempotency key when no platform product link exists", () => {
  const result = evaluateDeliveryPolicy({
    ...input(),
    platformProductLink: null,
  });

  expect(result).toMatchObject({
    kind: "ready",
    plan: {
      action: "create",
      idempotencyKey: shoplinePublishIdempotencyKey(
        workspaceId,
        versionId,
        "create",
      ),
    },
  });
});

it("builds an update-action idempotency key and carries the target remote id when a platform product link exists", () => {
  const result = evaluateDeliveryPolicy({
    ...input(),
    platformProductLink: { remoteProductId: "remote_existing_1" },
  });

  expect(result).toMatchObject({
    kind: "ready",
    plan: {
      action: "update",
      remoteProductId: "remote_existing_1",
      idempotencyKey: shoplinePublishIdempotencyKey(
        workspaceId,
        versionId,
        "update",
      ),
    },
  });
});

it("does not set action/remoteProductId on the csv method's plan", () => {
  const result = evaluateDeliveryPolicy({
    ...input(),
    method: "csv",
    platformProductLink: { remoteProductId: "remote_existing_1" },
  });

  expect(result.kind).toBe("ready");
  if (result.kind === "ready") {
    expect(result.plan.action).toBeUndefined();
    expect(result.plan.idempotencyKey).toBeUndefined();
  }
});
```

If `input()`'s return type doesn't already include `platformProductLink`,
this step's tests will show a type error where the spread `{ ...input(),
platformProductLink: null }` is redundant-but-harmless (the object literal
gains the field either way) — no fixture change needed, since these tests add
the field via object spread, not by editing `input()` itself.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/shopline exec vitest run src/delivery-policy.test.ts`
Expected: FAIL — `shoplinePublishIdempotencyKey is not a function` (not yet exported), and/or `Property 'action' does not exist`.

- [ ] **Step 3: Add the helper and widen the policy's input/output types**

In `packages/shopline/src/delivery-policy.ts`, add the helper function near
`hashCanonicalListing` (both are small, pure, exported utilities used by
multiple modules):

```ts
export function shoplinePublishIdempotencyKey(
  workspaceId: string,
  versionId: string,
  action: "create" | "update",
): string {
  return `${workspaceId}:${versionId}:shopline:${action}`;
}
```

Widen `DeliveryPolicyInput` to add one field:

```ts
export type DeliveryPolicyInput = {
  workspaceId: string;
  draftId: string;
  method: DeliveryMethod;
  phase: DeliveryPolicyPhase;
  listing: DeliveryListingSnapshot | null;
  imageUrls: readonly string[];
  connection: DeliveryConnectionSnapshot | null;
  job: DeliveryJobSnapshot | null;
  /**
   * The listing's known SHOPLINE remote product link, if any -- from
   * `platform_products.getByListingId`. Null means this delivery will
   * create a new remote product; present means it will update the one
   * already linked. Only read for `method === "shopline_api"`.
   */
  platformProductLink: { remoteProductId: string } | null;
};
```

Widen `DeliveryPlan` to add two fields:

```ts
export type DeliveryPlan = {
  method: DeliveryMethod;
  workspaceId: string;
  draftId: string;
  versionId: string;
  payload: ShoplineProductPayload;
  payloadDigest: string;
  connectionId?: string;
  idempotencyKey?: string;
  action?: "create" | "update";
  remoteProductId?: string;
  auditFacts: DeliveryAuditFacts;
};
```

Replace the hardcoded key line inside `evaluateDeliveryPolicy`'s
`shopline_api` branch (search for `` `${listing.workspaceId}:${versionId}:shopline:create}` ``):

```ts
if (input.method === "shopline_api") {
  if (
    !input.connection ||
    !input.connection.verified ||
    input.connection.workspaceId !== listing.workspaceId
  ) {
    return {
      kind: "disconnected",
      csvFallback: {
        method: "csv",
        path: `/api/listings/${listing.draftId}/deliver`,
      },
      auditFacts: auditFacts(input, "disconnected", versionId, payloadDigest),
    };
  }
  const action: "create" | "update" = input.platformProductLink
    ? "update"
    : "create";
  const idempotencyKey = shoplinePublishIdempotencyKey(
    listing.workspaceId,
    versionId,
    action,
  );
  return {
    kind: "ready",
    plan: {
      method: input.method,
      workspaceId: listing.workspaceId,
      draftId: listing.draftId,
      versionId,
      payload,
      payloadDigest,
      connectionId: input.connection.id,
      idempotencyKey,
      action,
      ...(input.platformProductLink
        ? { remoteProductId: input.platformProductLink.remoteProductId }
        : {}),
      auditFacts: auditFacts(input, "ready", versionId, payloadDigest),
    },
  };
}
```

The `csv` branch's returned plan (the final `return` in the function) is
unchanged — it never sets `idempotencyKey`, `action`, or `remoteProductId`,
matching today's behavior and the third new test above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/shopline exec vitest run src/delivery-policy.test.ts`
Expected: PASS, all tests including the three new ones. Every pre-existing
test that constructs a `DeliveryPolicyInput` without `platformProductLink`
will now fail to typecheck — fix each by adding `platformProductLink: null`
to its fixture (this is the correct behavior for every existing test, since
none of them were exercising an update scenario).

- [ ] **Step 5: Export the helper**

In `packages/shopline/src/index.ts`, find the existing:

```ts
export {
  evaluateDeliveryPolicy,
  hashCanonicalListing,
} from "./delivery-policy.js";
```

and add `shoplinePublishIdempotencyKey` to that list:

```ts
export {
  evaluateDeliveryPolicy,
  hashCanonicalListing,
  shoplinePublishIdempotencyKey,
} from "./delivery-policy.js";
```

`PlatformProductOrigin` from Task 2 does not need exporting from
`@wukong/shopline` — it belongs to `@wukong/db`, which `packages/shopline`
does not depend on and should not start depending on for this.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/shopline test && pnpm --filter @wukong/shopline lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shopline/src/delivery-policy.ts packages/shopline/src/delivery-policy.test.ts packages/shopline/src/index.ts
git commit -m "feat(shopline): add a shared create/update idempotency key and plan action"
```

---

### Task 4: `bulk-form-import.ts` — pass `origin: "import"` explicitly

**Files:**

- Modify: `apps/web/lib/bulk-form-import.ts`
- Modify: `apps/web/lib/bulk-form-import.test.ts`

- [ ] **Step 1: Write the failing test**

Read `apps/web/lib/bulk-form-import.test.ts` in full first, and read
`apps/web/lib/bulk-form-import.ts` around its `platformProducts.upsertMany(mirrors)`
call (search for it) to see exactly how the `mirrors` array is built. Add a
test asserting every mirror object passed to `upsertMany` has
`origin: "import"` — read the existing test file's conventions for how it
already spies on/asserts against `platformProducts.upsertMany`'s call
arguments (there is very likely an existing test doing something adjacent,
e.g. asserting `rawRow`/`contentDigest` shape on the mirrors — extend that
same test with an `origin` assertion, following its exact existing
`toMatchObject`/`toEqual` style, rather than writing a parallel new test if
one already covers this call site closely).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts`
Expected: FAIL — the asserted `origin: "import"` field is missing from the actual mirror object (or a type error if `UpsertPlatformProductInput` now requires `origin` and the mirror-building code doesn't supply it).

- [ ] **Step 3: Add `origin: "import"` to the mirror-building code**

In `apps/web/lib/bulk-form-import.ts`, find where each mirror object is
constructed (the object shape passed into the array that becomes
`platformProducts.upsertMany(mirrors)`'s argument). Add `origin: "import"`
as one of its fields, alongside the existing `sku`/`specVersion`/`rawRow`/
`factsPrefill`/`contentDigest` fields it already sets. Import
`PlatformProductOrigin` from `@wukong/db` if you want to type the literal
explicitly (`origin: "import" satisfies PlatformProductOrigin` or similar) —
optional, since the literal `"import"` already satisfies the widened
`UpsertPlatformProductInput["origin"]` type without it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-form-import.ts apps/web/lib/bulk-form-import.test.ts
git commit -m "feat(web): tag bulk-form-imported platform products with origin: import"
```

---

### Task 5: `publish-product.ts` — create-vs-update branch, upsert on success

**Files:**

- Modify: `apps/worker/src/publish-product.ts`
- Modify: `apps/worker/src/publish-product.test.ts`

This is the most important task in this plan — the hard constraint at the
top of this document about not destroying import data applies directly to
Step 3 below.

- [ ] **Step 1: Read the current file in full**

Read `apps/worker/src/publish-product.ts` in full before making any change —
it is intricate (a two-phase `withWorkspace` structure: a "prepare" phase
that returns either a terminal result or enough state to proceed, then a
"complete"/"fail" phase). The steps below give you the complete replacement
content for every section that changes; do not guess at surrounding lines
that aren't shown — copy them forward unchanged from what you just read.

- [ ] **Step 2: Write the failing tests**

Read `apps/worker/src/publish-product.test.ts` in full, including the
`makeHarness`/`makeRepos`/`makeConnector` factories (read past line 130 if
needed — the truncated research for this plan only confirmed line 1-101).
`makeConnector` already stubs `updateProduct: vi.fn(async () => undefined)` —
confirm this and reuse it. `makeRepos` needs a new `platformProducts` fake
added to whatever it currently returns for `PublishRepositories` — a
plain in-memory object supporting `getByListingId`/`upsert` against a `Map`,
following the same in-memory-fake style the rest of this harness already
uses for `listings`/`publishJobs`.

Add these tests (adapt fixture/harness call shapes to match what you find —
this task's tests are the acceptance criteria, not a literal drop-in, since
`makeHarness`'s exact signature wasn't fully visible during planning):

```ts
it("calls createProduct and records a created-origin platform_products row when no link exists", async () => {
  const { repos, dependencies, input } = makeHarness("approved", [], []);
  const connector = makeConnector({
    createProduct: vi.fn(async () => ({ remoteProductId: "remote_new_1" })),
  });

  const result = await publishApprovedProduct(input, {
    ...dependencies,
    connector,
  });

  expect(result.remoteProductId).toBe("remote_new_1");
  expect(connector.createProduct).toHaveBeenCalledOnce();
  expect(connector.updateProduct).not.toHaveBeenCalled();
  const link = await repos.platformProducts.getByListingId(input.draftId);
  expect(link).toMatchObject({
    origin: "created",
    remoteProductId: "remote_new_1",
    sku: null,
    rawRow: null,
  });
});

it("calls updateProduct, not createProduct, and preserves import fields when a link already exists", async () => {
  const { repos, dependencies, input } = makeHarness("approved", [], []);
  await repos.platformProducts.upsert({
    connectionId: input.connectionId,
    remoteProductId: "remote_existing_1",
    origin: "import",
    sku: "SKU-1",
    listingId: input.draftId,
    specVersion: "opak-2026-05",
    rawRow: { productId: "remote_existing_1", sku: "SKU-1" },
    factsPrefill: null,
    contentDigest: "d".repeat(64),
  });
  const connector = makeConnector({
    updateProduct: vi.fn(async () => undefined),
  });

  const result = await publishApprovedProduct(input, {
    ...dependencies,
    connector,
  });

  expect(result.remoteProductId).toBe("remote_existing_1");
  expect(connector.updateProduct).toHaveBeenCalledWith(
    "remote_existing_1",
    expect.anything(),
    expect.stringContaining(":shopline:update"),
  );
  expect(connector.createProduct).not.toHaveBeenCalled();
  const link = await repos.platformProducts.getByListingId(input.draftId);
  expect(link).toMatchObject({
    origin: "import",
    sku: "SKU-1",
    rawRow: { productId: "remote_existing_1", sku: "SKU-1" },
    contentDigest: "d".repeat(64),
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/worker exec vitest run src/publish-product.test.ts`
Expected: FAIL — `updateProduct` is never called; no `platformProducts` fake exists yet on the harness.

- [ ] **Step 4: Widen `PublishRepositories` and restructure `publishApprovedProduct`**

In `apps/worker/src/publish-product.ts`, add to the top-level imports:

```ts
import {
  evaluateDeliveryPolicy,
  shoplinePublishIdempotencyKey,
  type CommerceConnector,
  type ConnectorErrorCode,
  type DeliveryConnectionSnapshot,
  type DeliveryPolicyOutcome,
  type ShoplineProductPayload,
} from "@wukong/shopline";
```

Add a narrow local type for the platform-product link this file needs (it
does not need the full `PlatformProduct` shape from `@wukong/db` — only
enough to decide the branch and refresh the row on success):

```ts
export type PublishPlatformProductLink = {
  remoteProductId: string;
  origin: "import" | "created";
  sku: string | null;
  specVersion: string | null;
  rawRow: Record<string, string | null> | null;
  factsPrefill: unknown;
  contentDigest: string | null;
};
```

Add `platformProducts` to `PublishRepositories` (after `publishJobs`):

```ts
  platformProducts: {
    getByListingId(listingId: string): Promise<PublishPlatformProductLink | null>;
    upsert(input: {
      connectionId: string;
      remoteProductId: string;
      origin: "import" | "created";
      listingId: string;
      sku: string | null;
      specVersion: string | null;
      rawRow: Record<string, string | null> | null;
      factsPrefill: unknown;
      contentDigest: string | null;
    }): Promise<void>;
  };
```

Add `existingLink` to `PublishProductInput` (required — every caller must be
explicit, matching how `expectedVersionId`/`leaseToken` already work):

```ts
export type PublishProductInput = {
  workspaceId: string;
  draftId: string;
  expectedVersionId: string;
  leaseToken: string;
  existingLink: PublishPlatformProductLink | null;
  connectionId?: string;
  persistRetryableFailure?: boolean;
};
```

Replace the idempotency key line (currently the first line inside the
function body, before the first `withWorkspace` call):

```ts
const action: "create" | "update" = input.existingLink ? "update" : "create";
const idempotencyKey = shoplinePublishIdempotencyKey(
  input.workspaceId,
  input.expectedVersionId,
  action,
);
```

Both `evaluateDeliveryPolicy({...})` call sites inside the first
`withWorkspace` callback (there are two — one for the early "binding" check,
one for the full "outcome" check after image URLs are resolved) need
`platformProductLink` added to their input object:

```ts
        platformProductLink: input.existingLink
          ? { remoteProductId: input.existingLink.remoteProductId }
          : null,
```

Add this field to both call sites' object literals, alongside the existing
`job: existing,` line each one already has.

In the connector-call loop (search for `dependencies.connector.createProduct`
inside the `for (let attempt = 0; attempt < 2; attempt += 1)` loop), replace
the try block's body:

```ts
    try {
      // Only the connector call belongs in this try. Anything else in here gets
      // laundered by normalizeConnectorError into `remote_unavailable`, which
      // does not break the loop -- so a failed database write after a successful
      // create would POST /products a second time.
      if (action === "update") {
        await dependencies.connector.updateProduct(
          input.existingLink!.remoteProductId,
          payload,
          idempotencyKey,
        );
        deliveredRemoteProductId = input.existingLink!.remoteProductId;
      } else {
        const created = await dependencies.connector.createProduct(
          payload,
          idempotencyKey,
        );
        deliveredRemoteProductId = created.remoteProductId;
      }
      break;
    } catch (error) {
```

(The `catch` block and everything else in the loop is unchanged — copy it
forward from what you read in Step 1.)

Finally, `complete()` needs to upsert `platform_products` alongside its
existing `publishJobs.markPublished`/`listings.markPublished` calls. Replace
`complete`'s body:

```ts
const complete = async (remoteProductId: string): Promise<PublishResult> => {
  await dependencies.withWorkspace(input.workspaceId, async (repositories) => {
    await repositories.publishJobs.markPublished(
      idempotencyKey,
      input.leaseToken,
      remoteProductId,
      payloadDigest,
    );
    await repositories.listings.markPublished(
      listing.id,
      versionId,
      remoteProductId,
      payloadDigest,
      auditContext,
      repositories.audit,
    );
    await repositories.platformProducts.upsert({
      connectionId,
      remoteProductId,
      origin: input.existingLink?.origin ?? "created",
      listingId: listing.id,
      sku: input.existingLink?.sku ?? null,
      specVersion: input.existingLink?.specVersion ?? null,
      rawRow: input.existingLink?.rawRow ?? null,
      factsPrefill: input.existingLink?.factsPrefill ?? null,
      contentDigest: input.existingLink?.contentDigest ?? null,
    });
  });
  return {
    status: "published",
    remoteProductId,
    payloadDigest,
    idempotencyKey,
  };
};
```

This is the exact application of this plan's hard constraint: for the update
path, every import-specific field is read back from `input.existingLink` and
passed through unchanged — nothing here can wipe a bulk-form-imported row's
data. For the create path, `input.existingLink` is `null`, so every field
correctly becomes `null` and `origin` correctly becomes `"created"`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/worker exec vitest run src/publish-product.test.ts`
Expected: PASS, all tests including the two new ones and every pre-existing
test (each pre-existing test's harness/input construction will need
`existingLink: null` added wherever it builds a `PublishProductInput` — fix
each one this way, since none of them were exercising an update scenario).

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/worker test && pnpm --filter @wukong/worker lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/publish-product.ts apps/worker/src/publish-product.test.ts
git commit -m "feat(worker): call updateProduct instead of createProduct when a platform product link exists"
```

---

### Task 6: `shopline-consumer.ts` — look up the link before claiming

**Files:**

- Modify: `apps/worker/src/shopline-consumer.ts`
- Modify: `apps/worker/src/shopline-consumer.test.ts`

- [ ] **Step 1: Read the current file in full**

Read `apps/worker/src/shopline-consumer.ts` in full (244 lines) before
editing — you need the exact surrounding structure of `consumeShoplineMessage`
and `publishRepositories`.

- [ ] **Step 2: Write the failing test**

Read `apps/worker/src/shopline-consumer.test.ts` in full first, including its
`makeHarness` factory. Add a test asserting: when a `platformProducts` fake
(added to the harness) returns a link for the message's `draftId`, the job is
claimed under the `:shopline:update` key (not `:shopline:create`), and
`publishApprovedProduct` (mock/spy it, following whatever mocking convention
this test file already uses for the worker's own dependencies) is called with
`existingLink` matching that link.

```ts
it("claims the update key and passes the existing link when platform_products has one", async () => {
  const link = {
    remoteProductId: "remote_existing_1",
    origin: "import" as const,
    sku: "SKU-1",
    specVersion: "opak-2026-05",
    rawRow: { productId: "remote_existing_1", sku: "SKU-1" },
    factsPrefill: null,
    contentDigest: "e".repeat(64),
  };
  const { env, dependencies, payload, repos } = makeHarness();
  repos.platformProducts = {
    async getByListingId() {
      return link;
    },
  };

  await consumeShoplineMessage(payload, env, dependencies);

  const claimedJob = await repos.publishJobs.getByIdempotencyKey(
    `${payload.workspaceId}:${payload.versionId}:shopline:update`,
  );
  expect(claimedJob).not.toBeNull();
});
```

Adapt this to the harness's actual shape — the exact mechanism for asserting
"claimed under this key" and "`publishApprovedProduct` received this
`existingLink`" depends on details not fully visible during planning (whether
this test file mocks `publishApprovedProduct` itself, or lets the real
in-memory fakes run it end-to-end like `makeHarness`'s existing tests appear
to). Match whichever pattern the file's other tests already use for
asserting what `publishApprovedProduct` was called with, or for asserting
job state after the fact.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @wukong/worker exec vitest run src/shopline-consumer.test.ts`
Expected: FAIL — the job is still claimed under the `:shopline:create` key regardless of any link.

- [ ] **Step 4: Look up the link and use the shared key helper**

In `apps/worker/src/shopline-consumer.ts`, add to the imports:

```ts
import {
  SHOPLINE_REQUEST_TIMEOUT_MS,
  shoplinePublishIdempotencyKey,
  type CommerceConnector,
} from "@wukong/shopline";
```

Replace the idempotency key line (currently `const idempotencyKey =
\`${parsed.data.workspaceId}:${parsed.data.versionId}:shopline:create\`;`)
with a lookup, moved inside the existing `runtime.database.forWorkspace(...)`call that immediately follows it (so the lookup shares the same
workspace-scoped transaction as the`claim()` call right after it):

```ts
  const claimNow = (dependencies.now ?? (() => new Date()))();
  try {
    const claimed = await runtime.database.forWorkspace(
      parsed.data.workspaceId,
      async (repositories) => {
        const existingLink = await repositories.platformProducts.getByListingId(
          parsed.data.draftId,
        );
        const action: "create" | "update" = existingLink ? "update" : "create";
        const idempotencyKey = shoplinePublishIdempotencyKey(
          parsed.data.workspaceId,
          parsed.data.versionId,
          action,
        );
        const claim = await repositories.publishJobs.claim({
          key: idempotencyKey,
          expectedVersionId: parsed.data.versionId,
          now: claimNow,
          leaseMs: dependencies.leaseMs ?? SHOPLINE_LEASE_MS,
        });
        if (!claim.claimed || !claim.leaseToken) {
          const authoritative =
            await repositories.publishJobs.getByIdempotencyKey(idempotencyKey);
          const busyLeaseExpiresAt =
            authoritative?.versionId === parsed.data.versionId &&
            authoritative.status === "running" &&
            authoritative.leaseExpiresAt instanceof Date &&
            authoritative.leaseExpiresAt.getTime() > claimNow.getTime()
              ? authoritative.leaseExpiresAt
              : null;
          return {
            claim,
            connection: null,
            terminalConnectionFailure: false,
            busyLeaseExpiresAt,
            idempotencyKey,
            existingLink,
          };
        }
        if (claim.job?.connectionId !== parsed.data.connectionId) {
          await repositories.publishJobs.markFailed(
            idempotencyKey,
            claim.leaseToken,
            "invalid_credentials_or_permission",
          );
          return {
            claim,
            connection: null,
            terminalConnectionFailure: true,
            busyLeaseExpiresAt: null,
            idempotencyKey,
            existingLink,
          };
        }
        const connection = await repositories.shoplineConnections.getById(
          parsed.data.connectionId,
        );
        return {
          claim,
          connection,
          terminalConnectionFailure: false,
          busyLeaseExpiresAt: null,
          idempotencyKey,
          existingLink,
        };
      },
    );
```

(`idempotencyKey` is removed from the standalone `const` before this block —
it now only exists inside the returned `claimed` object. The `!claim.claimed`
/ `claimed.terminalConnectionFailure` handling below this block is unchanged;
copy it forward from Step 1.)

Update the `publishApprovedProduct` call at the bottom of the function to
pass `existingLink`:

```ts
    await publishApprovedProduct(
      {
        workspaceId: parsed.data.workspaceId,
        draftId: parsed.data.draftId,
        expectedVersionId: parsed.data.versionId,
        connectionId: parsed.data.connectionId,
        leaseToken: claimed.claim.leaseToken,
        persistRetryableFailure: true,
        existingLink: claimed.existingLink,
      },
      {
```

`publishRepositories(...)` (the small mapper function near the top of the
file) needs `platformProducts: repositories.platformProducts,` added to its
returned object, alongside the existing `listings`/`publishJobs`/
`shoplineConnections`/`audit` entries.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @wukong/worker exec vitest run src/shopline-consumer.test.ts`
Expected: PASS, all tests including the new one and every pre-existing test
unchanged (a pre-existing test's harness may need a `platformProducts` fake
returning `null` added if `makeHarness` doesn't already provide one for every
test — add it there once, rather than per-test).

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/worker test && pnpm --filter @wukong/worker lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/shopline-consumer.ts apps/worker/src/shopline-consumer.test.ts
git commit -m "feat(worker): look up the platform product link before claiming a publish job"
```

---

### Task 7: `delivery-service.ts` — request-phase snapshot fetches the link

**Files:**

- Modify: `apps/web/lib/delivery-service.ts`
- Modify: `apps/web/lib/delivery-service.review-fix.test.ts`

- [ ] **Step 1: Read the current file in full**

Read `apps/web/lib/delivery-service.ts` in full (560 lines) — this task
touches `DeliveryDeps`, `DeliveryPolicySnapshot`, `createDeliverySnapshotReader`'s
`read()`, and both places that spread a snapshot into
`evaluateDeliveryPolicy(...)` (`prepareShoplineDelivery` and `deliverListing`).
`deliverBulkForm` is NOT touched by this task — it already handles a
create-origin link correctly via its existing `isBulkFormRawRow` guard.

- [ ] **Step 2: Write the failing test**

Read `apps/web/lib/delivery-service.review-fix.test.ts` in full first,
including its `vi.mock("@wukong/shopline", ...)` block (it wraps
`evaluateDeliveryPolicy` in a spy) — add `shoplinePublishIdempotencyKey` to
the `...actual` spread there if the new test needs to import the real
function rather than a mock. Add a test asserting that when a fake
`platformProducts.getByListingId` returns a link,
`prepareShoplineDelivery`'s resulting `ShoplinePublishRequest.idempotencyKey`
ends in `:shopline:update`, and when it returns `null`, the key ends in
`:shopline:create` — following this file's exact existing fake-dependency
construction style (read 2-3 of its existing tests for
`prepareShoplineDelivery` to match the pattern precisely, including how
`deps.existingDelivery`/`deps.listings`/`deps.connection` are already faked).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @wukong/web exec vitest run lib/delivery-service.review-fix.test.ts`
Expected: FAIL — the key is always `:shopline:create` regardless of any link, or a type error since `platformProductLink` isn't yet threaded through.

- [ ] **Step 4: Widen `DeliveryDeps`, the snapshot reader, and both policy call sites**

In `apps/web/lib/delivery-service.ts`, widen the existing `platformProducts`
field on `DeliveryDeps` (currently typed narrowly for `deliverBulkForm`'s use)
to also serve this task's need. This is a real type change, not just a doc
update: Task 2 made `platform_products.rawRow` nullable at the repository
level (`Record<string, string | null> | null`, not just nullable values
inside an always-present record), so this field's type must gain that same
`| null` on the whole `rawRow` property, or `apps/web/app/api/listings/[id]/deliver/route.ts`'s
existing `platformProducts: repositories.platformProducts` wiring (which
passes the real, now-widened `@wukong/db` repository straight through) stops
type-checking. Getting this exactly right in this task is what keeps that
route file compiling without needing a change of its own:

```ts
  /**
   * Read by both the `bulk_form` method (to build the export row) and, as of
   * this task, the `shopline_api` method's request-phase snapshot (to decide
   * create-vs-update and build the matching idempotency key). Optional so
   * every existing csv-only test that never touches this keeps compiling
   * unchanged.
   */
  platformProducts?: {
    getByListingId(listingId: string): Promise<{
      remoteProductId: string;
      rawRow: Record<string, string | null> | null;
    } | null>;
  };
```

(`rawRow`'s type gains `| null` here since Task 2 made it nullable — this is
a pure type-widening, `deliverBulkForm`'s existing `isBulkFormRawRow(link.rawRow)`
call already handles a `null` value correctly today, per this plan's Hard
Constraints section.)

Add `platformProductLink` to `DeliveryPolicySnapshot`:

```ts
export type DeliveryPolicySnapshot = {
  listing: DeliveryListingSnapshot;
  imageUrls: readonly string[];
  connection: DeliveryConnectionSnapshot | null;
  job: DeliveryJobSnapshot | null;
  platformProductLink: { remoteProductId: string } | null;
  existingDelivery: Awaited<
    ReturnType<NonNullable<DeliveryDeps["existingDelivery"]>>
  >;
};
```

In `createDeliverySnapshotReader`'s `read()` function, replace the section
from the `configuredConnection`/`connection` lines through the `existingDelivery`
lookup:

```ts
const configuredConnection = deps.connection ? await deps.connection() : null;
const connection = configuredConnection
  ? { ...configuredConnection, workspaceId: input.workspaceId }
  : null;
const platformProductLink =
  input.method === "shopline_api" && deps.platformProducts
    ? await deps.platformProducts.getByListingId(input.draftId)
    : null;
const publishAction: "create" | "update" = platformProductLink
  ? "update"
  : "create";
const existingDelivery =
  input.method === "shopline_api" &&
  listing.activeVersion &&
  deps.existingDelivery
    ? await deps.existingDelivery(
        shoplinePublishIdempotencyKey(
          input.workspaceId,
          listing.activeVersion.id,
          publishAction,
        ),
      )
    : null;
```

(everything before `configuredConnection` and everything from `const job =`
onward is unchanged — copy forward from Step 1). Update the function's final
`return` to include the new field:

```ts
return {
  listing,
  imageUrls,
  connection,
  job,
  platformProductLink,
  existingDelivery,
};
```

Add the import at the top of the file:

```ts
import {
  createBulkFormUpdate,
  createShoplineCsv,
  evaluateDeliveryPolicy,
  isBulkFormRawRow,
  shoplinePublishIdempotencyKey,
  ShoplineBulkFormError,
  SHOPLINE_CSV_SPEC_VERSION,
  type BulkFormExportRow,
  type DeliveryAuditFacts,
  type DeliveryConnectionSnapshot,
  type DeliveryJobSnapshot,
  type DeliveryListingSnapshot,
  type DeliveryPolicyOutcome,
} from "@wukong/shopline";
```

Both call sites that spread a snapshot into `evaluateDeliveryPolicy({...input,
method, phase: "request", ...snapshot})` (inside `prepareShoplineDelivery`
and `deliverListing`) already forward `platformProductLink` automatically via
the `...snapshot` spread, since it's now part of `DeliveryPolicySnapshot` and
`DeliveryPolicyInput` — no further edit needed at either call site itself.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @wukong/web exec vitest run lib/delivery-service.review-fix.test.ts`
Expected: PASS, all tests including the new one and every pre-existing test
unchanged.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/delivery-service.ts apps/web/lib/delivery-service.review-fix.test.ts
git commit -m "feat(web): resolve create-vs-update from the platform product link at request time"
```

---

### Task 8: Listing GET route — `shoplineLink` field

**Files:**

- Modify: `apps/web/app/api/listings/[id]/route.ts`
- Modify: `apps/web/app/api/listings/[id]/route.test.ts`

- [ ] **Step 1: Write the failing test**

Read `apps/web/app/api/listings/[id]/route.test.ts` in full first — reuse its
`handlerFor(role, hasConnection, overrides)` factory exactly. Add a
`platformProducts` entry to the fake repositories object inside `handlerFor`
(it doesn't have one today), defaulting to `async getByListingId() { return
null; }`, overridable via `overrides.platformProducts`. Add:

```ts
it("resolves shoplineLink from the platform product link when one exists", async () => {
  const response = await handlerFor("reviewer", true, {
    platformProducts: {
      async getByListingId() {
        return { remoteProductId: "remote_existing_1" };
      },
    },
  })(new Request("http://localhost"), {
    params: Promise.resolve({ id: listingId }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    shoplineLink: { remoteProductId: "remote_existing_1" },
  });
});

it("resolves shoplineLink as null when no platform product link exists", async () => {
  const response = await handlerFor("reviewer", true)(
    new Request("http://localhost"),
    { params: Promise.resolve({ id: listingId }) },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ shoplineLink: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/listings/\[id\]/route.test.ts"`
Expected: FAIL — `shoplineLink` is `undefined`, not present in the response at all.

- [ ] **Step 3: Add the field**

In `apps/web/app/api/listings/[id]/route.ts`, add the import:

```ts
import { shoplinePublishIdempotencyKey } from "@wukong/shopline";
```

Replace the read-only idempotency-key reconstruction:

```ts
const versionId = snapshot.activeVersion?.id ?? null;
const platformProductLink =
  await repositories.platformProducts.getByListingId(id);
const job = versionId
  ? await repositories.publishJobs.getByIdempotencyKey(
      shoplinePublishIdempotencyKey(
        session.workspaceId,
        versionId,
        platformProductLink ? "update" : "create",
      ),
    )
  : null;
```

Add `shoplineLink` to the returned response object, alongside `permissions`:

```ts
            shoplineLink: platformProductLink
              ? { remoteProductId: platformProductLink.remoteProductId }
              : null,
            permissions: listingPermissions(session.role),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/listings/\[id\]/route.test.ts"`
Expected: PASS, all tests including the two new ones and every pre-existing
test unchanged (each pre-existing test's fake repositories object now has a
default `platformProducts.getByListingId` returning `null` from Step 1's
`handlerFor` change, so none of them break).

- [ ] **Step 5: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/[id]/route.ts" "apps/web/app/api/listings/[id]/route.test.ts"
git commit -m "feat(web): resolve a listing's known SHOPLINE remote product link in the review GET route"
```

---

### Task 9: Reviewer-facing create-vs-update message

**Files:**

- Modify: `apps/web/components/listing-view-models.ts`
- Modify: `apps/web/components/delivery-panel.tsx`
- Modify: `apps/web/components/delivery-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Read `apps/web/components/delivery-panel.test.tsx` in full first, and read
`apps/web/components/listing-view-models.ts` around `DeliveryModel` (lines
66-72 per prior research) to confirm its exact current shape and where it's
constructed from the route's JSON response (search for wherever
`DeliveryModel` values are built, likely in the same file or a sibling
`*-view-models.ts`/mapper file — read whichever file does this mapping in
full before editing it in Step 3). Add tests asserting:

```tsx
it("shows a create message when shoplineLink is null", () => {
  render(
    <DeliveryPanel
      model={{
        connection: "connected",
        status: "approved",
        canReview: true,
        remoteProductUrl: null,
        remoteProductId: null,
        shoplineLink: null,
      }}
      // ...other required props, matching this file's existing render calls
    />,
  );

  expect(
    screen.getByText(/will create a new SHOPLINE product/i),
  ).toBeInTheDocument();
});

it("shows an update message naming the listing's sku when shoplineLink is present", () => {
  render(
    <DeliveryPanel
      model={{
        connection: "connected",
        status: "approved",
        canReview: true,
        remoteProductUrl: null,
        remoteProductId: null,
        shoplineLink: { remoteProductId: "remote_existing_1" },
      }}
      sku="OPAK-2024-RIES"
      // ...other required props
    />,
  );

  expect(
    screen.getByText(
      /will update the live SHOPLINE product for OPAK-2024-RIES/i,
    ),
  ).toBeInTheDocument();
});
```

Adapt prop names/shapes to exactly match `DeliveryPanelProps` and this test
file's existing render helper — the two assertions above are the acceptance
criteria; the exact prop plumbing (e.g. whether `sku` is a top-level prop or
nested inside `model`) depends on what Step 3 below decides once you're
looking at the real component, matching the file's existing conventions
rather than inventing a new shape.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/web exec vitest run components/delivery-panel.test.tsx`
Expected: FAIL — neither message renders; `shoplineLink` isn't a recognized prop yet.

- [ ] **Step 3: Add `shoplineLink` to `DeliveryModel` and render the message**

In `apps/web/components/listing-view-models.ts`, widen `DeliveryModel`:

```ts
export type DeliveryModel = {
  connection: "disconnected" | "error" | "connected";
  status: ListingReviewModel["status"];
  canReview: boolean;
  remoteProductUrl: string | null;
  remoteProductId: string | null;
  shoplineLink: { remoteProductId: string } | null;
};
```

Find wherever `DeliveryModel` values are actually constructed from the
listing GET route's JSON response (read the file first — this may be in this
same file or a sibling mapper) and add `shoplineLink: response.shoplineLink`
(or the equivalent field-access matching however the rest of the response is
already being mapped there).

In `apps/web/components/delivery-panel.tsx`, read the full file (107 lines)
before editing. `DeliveryPanelProps` needs a way to know the listing's own
`sku` for the update message's label (per the spec: the listing's own
canonical sku, not `platform_products.sku`, which is nullable) — check
whether this component already receives the listing's canonical content or
sku as a prop today (its existing use of `model.remoteProductId`/
`model.remoteProductUrl` suggests it might not); if not, add a `sku: string
| null` prop, threaded from wherever this component's parent already has
access to `activeVersion.content.sku`. Add the message, placed near the
existing `model.remoteProductId`/`model.remoteProductUrl` rendering (lines
93-104 per prior research) since it's answering the same "what will this
delivery do" question:

```tsx
{
  model.connection === "connected" && model.canReview && (
    <p className="delivery-panel-target">
      {model.shoplineLink
        ? `此操作將更新現有 SHOPLINE 商品${sku ? `「${sku}」` : ""}。`
        : "此操作將建立新的 SHOPLINE 商品。"}
    </p>
  );
}
```

Match this codebase's established bilingual/localized copy convention (check
2-3 other user-facing strings already in this file or its siblings — e.g.
`product-shot-panel.tsx`'s `商品照 PRODUCT SHOT` pattern — for whether an
English label/eyebrow accompanies the Chinese copy, and match that same
shape here rather than inventing a new bilingual presentation style). The
placement (`{model.connection === "connected" && model.canReview && ...}`)
should match whatever conditional guard the component's other delivery-status
messages already use — read the real file and match it exactly rather than
assuming this guard is correct.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/web exec vitest run components/delivery-panel.test.tsx`
Expected: PASS, all tests including the two new ones and every pre-existing test unchanged.

- [ ] **Step 5: Full package verification and manual check**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

Manually verify no regression: since `SHOPLINE_PUBLISH_ENABLED=false` in
every environment today and no real listing has a `platform_products` link
from the create path yet, confirm the delivery panel renders exactly as it
did before this task for every existing listing — only the create-path
message should ever actually show in any real environment right now, and it
should read naturally alongside the panel's existing content.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/listing-view-models.ts apps/web/components/delivery-panel.tsx apps/web/components/delivery-panel.test.tsx
git commit -m "feat(web): show whether a delivery will create or update the SHOPLINE product"
```

---

### Task 10: Enrichment batch cohort scan — filter to import-origin rows

**Files:**

- Modify: `apps/web/lib/enrichment-batch-service.ts`
- Modify: `apps/web/lib/enrichment-batch-service.test.ts`

This is the required regression fix named in this plan's Hard Constraints —
without it, this feature breaks enrichment batch creation the moment a
create-origin `platform_products` row exists.

- [ ] **Step 1: Write the failing test**

Read `apps/web/lib/enrichment-batch-service.test.ts` in full first, including
its `serviceWith(products)` fake-fixture builder (products are plain arrays
of `{remoteProductId, listingId, rawRow}` objects per prior research — none
have an `origin` field today). Update every existing fixture object in this
file to add `origin: "import"` (matching their existing role as import-origin
test data — this is a mechanical, non-behavioral addition required by the
type widening, do this across the whole file in one pass rather than leaving
some fixtures without it). Then add a new test:

```ts
it("excludes a created-origin product from gap-based cohort selection", async () => {
  const service = serviceWith([
    {
      remoteProductId: "remote_import_1",
      listingId: "listing-1",
      origin: "import",
      rawRow: { productId: "remote_import_1", summaryEn: "" },
    },
    {
      remoteProductId: "remote_created_1",
      listingId: "listing-2",
      origin: "created",
      rawRow: null,
    },
  ]);

  const batch = await service.createBatch({
    workspaceId: "ws_test",
    label: "test batch",
    budgetUsd: 10,
    waveSize: 5,
    gap: "summaryEn",
  });

  expect(batch).toBeDefined();
  // Only the import-origin listing should ever be considered -- if the
  // created-origin row's null rawRow reached bulkFormGaps unfiltered, this
  // call would throw instead of returning cleanly.
});
```

Adapt this to the file's exact existing `createBatch` call shape and
whatever assertion style its other passing tests already use (the critical
behavior under test is "does not throw when a created-origin row with a null
`rawRow` is present in the scan," not the specific batch contents — if the
file's convention is to assert on `listingIds`/cohort membership directly
rather than "doesn't throw," follow that instead).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts`
Expected: FAIL — `bulkFormGaps(null)` throws (or returns a wrong/crashing result), since the filter doesn't exist yet.

- [ ] **Step 3: Add the filter**

In `apps/web/lib/enrichment-batch-service.ts`, find the cohort-selection
chain inside `createBatch` (search for `bulkFormGaps`):

```ts
const listingIds = products
  .filter((product) => product.listingId !== null)
  .filter((product) => product.origin === "import")
  .filter((product) => bulkFormGaps(product.rawRow)[input.gap])
  .map((product) => product.listingId as string);
```

(Only the new `.filter((product) => product.origin === "import")` line is
added, placed before the `bulkFormGaps` call — the surrounding lines are
unchanged, copy them forward from the real current file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts`
Expected: PASS, all tests including the new one and every pre-existing test
(now with `origin: "import"` on their fixtures) still passing.

- [ ] **Step 5: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "fix(web): exclude created-origin platform products from gap-based enrichment cohorts"
```

---

### Task 11: Docs and full verification

**Files:**

- Modify: `docs/runbooks/shopline-pilot-onboarding.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Document the flow**

Read `docs/runbooks/shopline-pilot-onboarding.md` in full first, and find
wherever it currently documents the `shopline_api` delivery method (likely
near where CSV/bulk-form delivery are already documented, following the
bulk-form export plan's precedent of adding a runbook section for a new
delivery behavior). Add a short section explaining: a reviewer re-delivering
an already-published, edited listing via SHOPLINE API now correctly updates
the existing remote product instead of creating a duplicate; this applies to
both imported and Wukong-created listings; the delivery panel shows which
one will happen before the reviewer confirms. Match the runbook's existing
tone and heading style.

- [ ] **Step 2: Extend the domain-terms entry**

Read `CONTEXT.md` in full first, find the existing "Shopline bulk form"
domain-terms entry (or wherever `platform_products` is already documented as
a term), and add or extend an entry explaining that `platform_products` now
tracks two origins (`import`, `created`) and is the one place any listing's
known SHOPLINE remote-product link lives, not just an import-specific
mirror. Match the file's existing entry format exactly.

- [ ] **Step 3: Format check**

Run: `node scripts/check-runtime-format.mjs`
Expected: 0 hash-pinned format debt on any file this plan touched. If any
file needs formatting, run `npx prettier --write <file>` and re-check.

- [ ] **Step 4: Full monorepo verification**

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets --filter @wukong/shopline --filter @wukong/jobs build
pnpm test
pnpm test:integration
pnpm lint
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md CONTEXT.md
git commit -m "docs: document SHOPLINE update-after-publish"
```

---

## Verification

After all eleven tasks:

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets --filter @wukong/shopline --filter @wukong/jobs build
pnpm test
pnpm test:integration
pnpm lint
node scripts/check-runtime-format.mjs
```

Expected: all green. Since `SHOPLINE_PUBLISH_ENABLED=false` in every real
environment today, this feature has zero production impact regardless of
this plan landing — the same accepted-inert pattern the product-shot-flatten
work followed. The two real-world-visible checks worth doing manually once
this is deployable: (1) an enrichment batch can still be created without
error in a workspace that has a create-origin `platform_products` row, and
(2) the delivery panel's message matches whichever branch a given listing is
actually in.
