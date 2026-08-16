# Bulk Form Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer export an approved, imported, enriched listing as a re-importable bulk update form, downloadable through the existing delivery route.

**Architecture:** One new repository lookup (`platform_products.getByListingId`), one type narrowing on the already-built `createBulkFormUpdate` so it accepts what `platform_products` actually stores, and one new branch in the existing `deliverListing` service function that maps a listing's canonical content onto the eight writable bulk-form columns and writes an `.xlsx` file. No new route, no new table, no change to `createBulkFormUpdate`'s or `writeBulkFormWorkbook`'s behavior.

**Tech Stack:** TypeScript 7 (5.9 in `apps/web`), Drizzle ORM, Postgres, Next.js App Router route handlers, Vitest, zod v4.

---

## Prerequisites

Read `docs/superpowers/specs/2026-08-16-bulk-form-export-design.md` before starting — every decision below cites it. In particular:

- Bulk-form export is **update-only**. A listing with no `platform_products` link uses the existing create path (`csv` / `shopline_api`), unchanged.
- The **staleness hazard** is real and not fixed by this plan: exported rows echo every non-enriched column from the row's last-imported snapshot, so a SHOPLINE-side price or stock change since import is silently reverted on re-upload. Task 5 documents this in the runbook; no task here attempts to solve it.

### Local services

Task 1's test needs Postgres on port 54329 with the `wukong_app` role, same as prior work on this repo. `docker exec wukong-postgres pg_isready -U wukong` should report accepting connections; if not, `docker compose up -d postgres` or the equivalent `docker run` from `docs/runbooks/local-development.md`.

## Hard constraints

- **Do not change `createBulkFormUpdate`'s or `writeBulkFormWorkbook`'s validation, neutralization, or write logic.** Task 2 narrows a parameter _type_; it does not touch the function body beyond the signature line.
- **Do not reuse `evaluateDeliveryPolicy`** for the bulk-form eligibility check. It is shaped around `ShoplineProductPayload` and is orthogonal here — see spec's "Chosen design → Status gate."
- **Audit metadata carries identifiers only** — `specVersion`, `versionId`, `remoteProductId`. Never a column value, never product content.
- **`packages/shopline/src/bulk-form-xlsx.ts` stays out of the main barrel.** It uses `node:zlib` and is imported only via the `@wukong/shopline/bulk-form-xlsx` subpath, exactly as the importer already does — this is what keeps `node:zlib` out of the Cloudflare Worker bundle.

## File Structure

| File                                                                 | Change | Responsibility                                                                                         |
| -------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `packages/db/src/repositories/platform-products.ts`                  | Modify | Add `getByListingId`                                                                                   |
| `packages/db/src/repositories/platform-products.integration.test.ts` | Modify | Prove it against real Postgres                                                                         |
| `packages/shopline/src/bulk-form.ts`                                 | Modify | `BulkFormExportRow`, `isBulkFormRawRow`, narrow `createBulkFormUpdate`'s row parameter                 |
| `packages/shopline/src/bulk-form.test.ts`                            | Modify | Prove the guard and the narrowed signature                                                             |
| `packages/shopline/src/index.ts`                                     | Modify | Export the two new symbols                                                                             |
| `apps/web/lib/delivery-service.ts`                                   | Modify | Widen `DeliverInput.method`/`DeliveryResult`; add the bulk-form branch                                 |
| `apps/web/lib/delivery-service.review-fix.test.ts`                   | Modify | Unit-test the bulk-form branch against fakes (this is the module's primary test file despite its name) |
| `apps/web/app/api/listings/[id]/deliver/route.ts`                    | Modify | Widen the body schema, add the response case, wire `platformProducts` into `defaultDelivery`           |
| `apps/web/app/api/listings/[id]/deliver/route.test.ts`               | Modify | Route-level test against the real handler                                                              |
| `docs/runbooks/shopline-pilot-onboarding.md`                         | Modify | Document the flow and the staleness hazard                                                             |
| `CONTEXT.md`                                                         | Modify | Extend the "Shopline bulk form" domain entry                                                           |

---

### Task 1: `platform_products.getByListingId`

**Files:**

- Modify: `packages/db/src/repositories/platform-products.ts`
- Test: `packages/db/src/repositories/platform-products.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Read `packages/db/src/repositories/platform-products.integration.test.ts` first. It already defines module-level `workspaceId` and `connectionId` constants, seeded once in `beforeAll` via raw admin SQL (`shopline_connections` has no repository `upsert` — only `getDefault`/`getById` — so every existing test in this file reuses that pre-seeded `connectionId` rather than creating a connection itself). It also defines a `factsFixture: ListingFacts` constant. Reuse both rather than inventing new ones. Append this test inside the existing `describe` block:

```ts
it("finds a platform product by its linked listing", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const draft = await repositories.listings.create({
      target: "shopline",
      note: null,
    });

    const created = await repositories.platformProducts.upsert({
      connectionId,
      remoteProductId: "remote_lookup_1",
      sku: "SKU-1",
      listingId: draft.id,
      specVersion: "opak-2026-05",
      rawRow: { productId: "remote_lookup_1", sku: "SKU-1" },
      factsPrefill: factsFixture,
      contentDigest: "b".repeat(64),
    });

    const found = await repositories.platformProducts.getByListingId(draft.id);
    expect(found?.id).toBe(created.id);
    expect(found?.remoteProductId).toBe("remote_lookup_1");
  });
});

it("returns null when no platform product links to the listing", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const draft = await repositories.listings.create({
      target: "shopline",
      note: null,
    });

    expect(
      await repositories.platformProducts.getByListingId(draft.id),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/platform-products.integration.test.ts
```

Expected: FAIL — TypeScript reports `getByListingId` does not exist on `PlatformProductRepository`.

- [ ] **Step 3: Add the method to the repository type**

In `packages/db/src/repositories/platform-products.ts`, find:

```ts
export type PlatformProductRepository = {
  upsert(input: UpsertPlatformProductInput): Promise<PlatformProduct>;
  upsertMany(
    inputs: readonly UpsertPlatformProductInput[],
  ): Promise<PlatformProduct[]>;
  listByRemoteProductIds(
    connectionId: string,
    remoteProductIds: readonly string[],
  ): Promise<PlatformProduct[]>;
  listRecent(limit?: number): Promise<PlatformProduct[]>;
```

Replace with (adding one line):

```ts
export type PlatformProductRepository = {
  upsert(input: UpsertPlatformProductInput): Promise<PlatformProduct>;
  upsertMany(
    inputs: readonly UpsertPlatformProductInput[],
  ): Promise<PlatformProduct[]>;
  listByRemoteProductIds(
    connectionId: string,
    remoteProductIds: readonly string[],
  ): Promise<PlatformProduct[]>;
  listRecent(limit?: number): Promise<PlatformProduct[]>;
  /**
   * The link the exporter reads: does this listing have a known remote
   * product at all. `listingId` has no unique constraint on the table, so a
   * listing could in principle link to more than one row; this returns the
   * most recently updated one, matching `listRecent`'s own ordering.
   */
  getByListingId(listingId: string): Promise<PlatformProduct | null>;
```

- [ ] **Step 4: Implement it**

In the same file, find the `unlinkListing` implementation (it's the last method before `listByRemoteProductIds`) and add `getByListingId` immediately after `upsertMany`'s closing brace and before `unlinkListing`:

```ts
    async getByListingId(listingId) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(platformProducts)
        .where(
          and(
            eq(platformProducts.workspaceId, workspaceId),
            eq(platformProducts.listingId, listingId),
          ),
        )
        .orderBy(desc(platformProducts.updatedAt))
        .limit(1);
      return row ? toPlatformProduct(row) : null;
    },
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/platform-products.integration.test.ts
```

Expected: PASS, every test in the file.

- [ ] **Step 6: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write packages/db/src/repositories/platform-products.ts packages/db/src/repositories/platform-products.integration.test.ts
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/platform-products.ts packages/db/src/repositories/platform-products.integration.test.ts
git commit -m "feat(db): look up a platform product by its linked listing"
```

---

### Task 2: Narrow `createBulkFormUpdate`'s row parameter

`createBulkFormUpdate` reads only `row.productId`, `row.raw`, and `row.rowNumber` at runtime (verified by reading its body — the loop never touches `categories`, `pricing`, `inventory`, `gaps`, or `facts`), but its signature demands the full `BulkFormProductRow` shape that only `parseBulkForm` produces. `platform_products` stores none of the unused fields. This task narrows the parameter type to exactly what the function reads, and adds a runtime guard for reading a stored `rawRow` back safely.

**Files:**

- Modify: `packages/shopline/src/bulk-form.ts`
- Modify: `packages/shopline/src/index.ts`
- Test: `packages/shopline/src/bulk-form.test.ts`

- [ ] **Step 1: Write the failing tests**

Read `packages/shopline/src/bulk-form.test.ts` first to find where `BulkFormRawRow`/`BULK_FORM_COLUMNS` are imported and how existing tests build a raw row fixture, so the new tests use the same import list and match the file's style. Append these tests (adjust the `describe` block name to match the file's existing top-level structure if it groups by concern — place these near any existing `createBulkFormUpdate` tests):

```ts
describe("isBulkFormRawRow", () => {
  it("accepts a row with every bulk-form column present", () => {
    const raw: Record<string, string | null> = {};
    for (const column of BULK_FORM_COLUMNS) raw[column.key] = null;
    expect(isBulkFormRawRow(raw)).toBe(true);
  });

  it("rejects a row missing a column", () => {
    const raw: Record<string, string | null> = {};
    for (const column of BULK_FORM_COLUMNS) raw[column.key] = null;
    delete raw[BULK_FORM_COLUMNS[0].key];
    expect(isBulkFormRawRow(raw)).toBe(false);
  });
});

describe("createBulkFormUpdate with a minimal export row", () => {
  it("accepts a BulkFormExportRow that carries only productId, raw, and rowNumber", () => {
    const raw: Record<BulkFormColumnKey, string | null> = Object.fromEntries(
      BULK_FORM_COLUMNS.map((column) => [column.key, ""]),
    ) as Record<BulkFormColumnKey, string | null>;
    raw.nameEn = "Demo Estate Riesling 2024";
    raw.nameZh = "Demo Estate Riesling 2024";

    // Deliberately NOT a BulkFormProductRow: no categories, pricing,
    // inventory, gaps, or facts. If createBulkFormUpdate's signature still
    // demanded the full parsed shape, this would fail to compile.
    const row: BulkFormExportRow = {
      productId: "remote_1",
      raw,
      rowNumber: 1,
    };

    const update = createBulkFormUpdate(
      [row],
      [{ productId: "remote_1", values: { nameZh: "示範莊園麗絲玲 2024" } }],
    );

    expect(update.changes).toEqual([
      {
        rowNumber: 1,
        productId: "remote_1",
        column: "nameZh",
        from: "Demo Estate Riesling 2024",
        to: "示範莊園麗絲玲 2024",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/shopline && npx vitest run src/bulk-form.test.ts
```

Expected: FAIL — `isBulkFormRawRow` and `BulkFormExportRow` are not exported yet, and `createBulkFormUpdate`'s first parameter still rejects the minimal row's type.

- [ ] **Step 3: Add `BulkFormExportRow` and narrow `createBulkFormUpdate`'s signature**

In `packages/shopline/src/bulk-form.ts`, find the `BulkFormProductRow` type definition (it starts with `export type BulkFormProductRow = {` and its first fields are `rowNumber`, `productId`, `sku`, `raw`). Immediately after its closing `};`, add:

```ts
/**
 * The only fields `createBulkFormUpdate` reads at runtime. Export builds this
 * directly from a stored `platform_products` row, which carries none of
 * `BulkFormProductRow`'s other fields (categories, pricing, inventory, gaps,
 * facts) — those exist only because `parseBulkForm` derives them from a fresh
 * upload, and the writer never needed them.
 */
export type BulkFormExportRow = Pick<
  BulkFormProductRow,
  "productId" | "raw" | "rowNumber"
>;
```

Then find the `createBulkFormUpdate` signature:

```ts
export function createBulkFormUpdate(
  rows: readonly BulkFormProductRow[],
  enrichments: readonly BulkFormEnrichment[],
  options: BulkFormUpdateOptions = {},
): BulkFormUpdate {
```

Replace the first parameter's type:

```ts
export function createBulkFormUpdate(
  rows: readonly BulkFormExportRow[],
  enrichments: readonly BulkFormEnrichment[],
  options: BulkFormUpdateOptions = {},
): BulkFormUpdate {
```

`BulkFormProductRow` structurally satisfies `BulkFormExportRow` (it has strictly more fields), so `parseBulkForm`'s existing output keeps compiling with no change at any existing call site.

- [ ] **Step 4: Add the runtime guard**

Find `export type BulkFormRawRow = Readonly<Record<BulkFormColumnKey, string | null>>;` and add immediately after it:

```ts
/**
 * `platform_products.rawRow` is stored as `Record<string, string | null>` —
 * looser than `BulkFormRawRow`, because the database column has no way to
 * enforce that all 71 `BulkFormColumnKey`s are present. The importer always
 * writes a full row, so this should never fail in practice; it exists so a
 * malformed stored row is reported as unexportable instead of producing
 * `undefined` cells `createBulkFormUpdate` wasn't written to expect.
 */
export function isBulkFormRawRow(
  value: Record<string, string | null>,
): value is BulkFormRawRow {
  return BULK_FORM_COLUMNS.every((column) => column.key in value);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/shopline && npx vitest run src/bulk-form.test.ts
```

Expected: PASS, every test in the file, including every pre-existing `createBulkFormUpdate` test — those still pass `parseBulkForm`'s full output, which the narrowed type still accepts.

- [ ] **Step 6: Export the new symbols**

In `packages/shopline/src/index.ts`, find:

```ts
  ShoplineBulkFormError,
```

and the block of `export type { ... } from "./bulk-form.js";` below it. Add `isBulkFormRawRow` to the value-export list alongside `ShoplineBulkFormError`:

```ts
  ShoplineBulkFormError,
  isBulkFormRawRow,
```

Add `BulkFormExportRow` to the type-export list, alphabetically next to `BulkFormEnrichmentIssueCode`/`BulkFormGapsInput`:

```ts
  BulkFormEnrichmentIssueCode,
  BulkFormExportRow,
  BulkFormGapsInput,
```

- [ ] **Step 7: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write packages/shopline/src/bulk-form.ts packages/shopline/src/bulk-form.test.ts packages/shopline/src/index.ts
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 8: Commit**

```bash
git add packages/shopline/src/bulk-form.ts packages/shopline/src/bulk-form.test.ts packages/shopline/src/index.ts
git commit -m "feat(shopline): narrow the bulk-form update row to what export can supply"
```

---

### Task 3: The bulk-form branch in `deliverListing`

This is the service-layer logic: reading the listing and its platform-product link, checking eligibility, mapping enriched content onto the eight writable columns, and calling the two already-tested functions from Task 2. No database, no route — everything here runs against fakes.

**Files:**

- Modify: `apps/web/lib/delivery-service.ts`
- Test: `apps/web/lib/delivery-service.review-fix.test.ts`

- [ ] **Step 1: Read the current file structure**

Read `apps/web/lib/delivery-service.ts` in full — it's 380 lines — before editing. Confirm `DeliverInput`, `DeliveryResult`, and `DeliveryDeps` are exactly as described below; if a prior change on this branch has shifted them, adapt the edits to the real current text rather than assuming this snapshot.

- [ ] **Step 2: Write the failing tests**

Read `apps/web/lib/delivery-service.review-fix.test.ts` first — reuse its existing `content` fixture (the `CanonicalListing` object near the top of the file) and its `deps(audits, jobs)` helper's shape rather than rebuilding either. Append these tests after the existing `describe("delivery audit and queue context", ...)` block, in a new `describe`:

```ts
describe("bulk-form export", () => {
  const platformProduct = {
    remoteProductId: "remote_1",
    rawRow: Object.fromEntries(
      BULK_FORM_COLUMNS.map((column) => [
        column.key,
        column.key === "nameEn" || column.key === "nameZh"
          ? "Demo Estate Riesling 2024"
          : "",
      ]),
    ),
  };

  function bulkFormDeps(
    options: {
      status?: "approved" | "published" | "in_review";
      hasLink?: boolean;
    } = {},
  ) {
    const audits: unknown[] = [];
    return {
      audits,
      deps: {
        listings: {
          async requireForPublish() {
            return {
              id: "listing_1",
              target: "shopline" as const,
              status: options.status ?? "approved",
              activeVersion: { id: "version_1", sequence: 1, content },
              flags: [],
            };
          },
        },
        imageUrls: async () => [],
        audit: {
          async write(event: unknown) {
            audits.push(event);
          },
        },
        publisher: {
          async enqueue() {
            throw new Error("bulk_form must not enqueue a publish job");
          },
        },
        platformProducts: {
          async getByListingId() {
            return options.hasLink === false ? null : platformProduct;
          },
        },
      },
    };
  }

  it("exports an .xlsx workbook for an approved, linked listing", async () => {
    const { deps, audits } = bulkFormDeps();

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result.kind).toBe("bulk_form");
    if (result.kind !== "bulk_form") throw new Error("expected bulk_form");
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.specVersion).toBe(SHOPLINE_BULK_FORM_SPEC_VERSION);
    expect(audits).toEqual([
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        action: "listing.bulk_form_exported",
        entityId: "listing_1",
        metadata: {
          specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
          versionId: "version_1",
          remoteProductId: "remote_1",
        },
      },
    ]);
  });

  it("maps the canonical listing onto the eight enrichable columns", async () => {
    const { deps } = bulkFormDeps();

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    if (result.kind !== "bulk_form") throw new Error("expected bulk_form");
    const sheet = readBulkFormSheet(result.body);
    const header = sheet[0];
    const dataRow = sheet[2];
    const nameZhIndex = header.indexOf("Product Name (Traditional Chinese)");
    expect(dataRow[nameZhIndex]).toBe(content.title["zh-Hant"]);
  });

  it("refuses an unapproved listing", async () => {
    const { deps, audits } = bulkFormDeps({ status: "in_review" });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result).toEqual({ kind: "approval_required" });
    expect(audits).toEqual([]);
  });

  it("refuses a listing with no linked platform product", async () => {
    const { deps, audits } = bulkFormDeps({ hasLink: false });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result).toEqual({ kind: "no_remote_link" });
    expect(audits).toEqual([]);
  });
});
```

Add the new imports this test needs at the top of the file, alongside the existing `import { evaluateDeliveryPolicy } from "@wukong/shopline";`:

```ts
import {
  BULK_FORM_COLUMNS,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
} from "@wukong/shopline";
import { readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
```

`readBulkFormSheet` lives in `bulk-form-xlsx.ts`, not the main barrel — it's Node-only (parses a real zip), same reason `writeBulkFormWorkbook` needs its own subpath. Reusing it to assert on the written output is more honest than hand-parsing the xlsx bytes in the test, and confirms the round trip actually works, not just that some bytes were produced.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run lib/delivery-service.review-fix.test.ts
```

Expected: several failures — `method: "bulk_form"` doesn't typecheck against `DeliverInput` yet, `platformProducts` isn't a recognized `DeliveryDeps` field, and `deliverListing` doesn't branch on it.

- [ ] **Step 4: Widen the types**

In `apps/web/lib/delivery-service.ts`, find:

```ts
export type DeliverInput = {
  workspaceId: string;
  actorId: string;
  draftId: string;
  method: "csv" | "shopline_api";
};
```

Replace with:

```ts
export type DeliverInput = {
  workspaceId: string;
  actorId: string;
  draftId: string;
  method: "csv" | "shopline_api" | "bulk_form";
};
```

Find:

```ts
export type DeliveryResult =
  | { kind: "csv"; body: string; specVersion: string; versionId: string }
  | { kind: "queued"; jobId: string; versionId: string }
  | { kind: "retry_required"; jobId: string; versionId: string }
  | { kind: "approval_required" }
  | { kind: "blocking_flags"; issues: string[] }
  | { kind: "validation_error"; issues: string[] }
  | { kind: "disconnected"; csvFallback: { method: "csv"; path: string } }
  | { kind: "already_published"; remoteProductId: string | null };
```

Replace with:

```ts
export type DeliveryResult =
  | { kind: "csv"; body: string; specVersion: string; versionId: string }
  | {
      kind: "bulk_form";
      body: Uint8Array;
      specVersion: string;
      versionId: string;
    }
  | { kind: "queued"; jobId: string; versionId: string }
  | { kind: "retry_required"; jobId: string; versionId: string }
  | { kind: "approval_required" }
  | { kind: "blocking_flags"; issues: string[] }
  | { kind: "validation_error"; issues: string[] }
  | { kind: "disconnected"; csvFallback: { method: "csv"; path: string } }
  | { kind: "already_published"; remoteProductId: string | null }
  | { kind: "no_remote_link" };
```

Find the `DeliveryDeps` type (starts `export type DeliveryDeps = {`) and its `connection?:` / `existingDelivery?:` optional fields near the end. Add a third optional field after `existingDelivery`:

```ts
  /**
   * Only read by the `bulk_form` method. Optional so every existing csv and
   * shopline_api test — which never touches this — keeps compiling unchanged.
   * A caller that reaches the bulk_form branch without supplying it has a
   * wiring bug, not a business outcome, so that path throws rather than
   * returning a DeliveryResult variant for it.
   */
  platformProducts?: {
    getByListingId(
      listingId: string,
    ): Promise<{ remoteProductId: string; rawRow: Record<string, string | null> } | null>;
  };
```

- [ ] **Step 5: Run the tests to verify the type errors are gone and the branch is missing**

```bash
cd apps/web && npx vitest run lib/delivery-service.review-fix.test.ts
```

Expected: still failing, but now at runtime — `deliverListing` calls `evaluateDeliveryPolicy` unconditionally today, which doesn't understand `method: "bulk_form"` and will reject it as `approval_required` for the wrong reason (`unsupported_method`), not implement the real branch yet.

- [ ] **Step 6: Implement the branch**

In `apps/web/lib/delivery-service.ts`, find the start of `deliverListing`:

```ts
export async function deliverListing(
  input: DeliverInput,
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
  const reader = createDeliverySnapshotReader(deps);
```

Replace with:

```ts
export async function deliverListing(
  input: DeliverInput,
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
  if (input.method === "bulk_form") return deliverBulkForm(input, deps);

  const reader = createDeliverySnapshotReader(deps);
```

Then, after `deliverListing`'s closing brace (the function ends with `return { kind: "queued", jobId, versionId: plan.versionId };\n}`), add the new function:

```ts
/**
 * Bulk-form export does not go through `evaluateDeliveryPolicy` — that
 * function is shaped around `ShoplineProductPayload` projection and
 * validation, neither of which applies to a bulk-form row. The review-state
 * gate is deliberately the same one the create path enforces (`approved` or
 * `published`, matching `isEligibleStatus`'s request-phase check in
 * `@wukong/shopline`'s delivery policy) — bulk-form export must not be an
 * easier way to ship unreviewed AI content than CSV or the API path is.
 */
async function deliverBulkForm(
  input: DeliverInput,
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
  const source = await deps.listings.requireForPublish(input.draftId);
  if (
    !source.activeVersion ||
    !(source.status === "approved" || source.status === "published")
  ) {
    return { kind: "approval_required" };
  }

  const link = await deps.platformProducts?.getByListingId(input.draftId);
  if (!link) return { kind: "no_remote_link" };
  if (!isBulkFormRawRow(link.rawRow)) {
    return {
      kind: "validation_error",
      issues: ["stored bulk-form row is missing one or more columns"],
    };
  }

  const { content } = source.activeVersion;
  const row: BulkFormExportRow = {
    productId: link.remoteProductId,
    raw: link.rawRow,
    rowNumber: 1,
  };

  let update: ReturnType<typeof createBulkFormUpdate>;
  try {
    update = createBulkFormUpdate(
      [row],
      [
        {
          productId: link.remoteProductId,
          values: {
            nameZh: content.title["zh-Hant"],
            summaryEn: content.description.en,
            summaryZh: content.description["zh-Hant"],
            seoTitleEn: content.seo.title.en,
            seoTitleZh: content.seo.title["zh-Hant"],
            seoDescriptionEn: content.seo.description.en,
            seoDescriptionZh: content.seo.description["zh-Hant"],
            // No delimiter convention exists elsewhere in the codebase for
            // this field — chosen as the plain, human-editable form an
            // operator reviewing the file by eye would expect.
            seoKeywords: content.tags.join(", "),
          },
        },
      ],
    );
  } catch (error) {
    if (error instanceof ShoplineBulkFormError) {
      return {
        kind: "validation_error",
        issues: error.issues.map((issue) => issue.message),
      };
    }
    throw error;
  }

  const body = writeBulkFormWorkbook(update.sheet);
  await deps.audit.write({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: "listing.bulk_form_exported",
    entityId: input.draftId,
    metadata: {
      specVersion: update.specVersion,
      versionId: source.activeVersion.id,
      remoteProductId: link.remoteProductId,
    },
  });
  return {
    kind: "bulk_form",
    body,
    specVersion: update.specVersion,
    versionId: source.activeVersion.id,
  };
}
```

Add the imports this needs at the top of the file, alongside the existing `@wukong/shopline` import:

```ts
import {
  createBulkFormUpdate,
  isBulkFormRawRow,
  ShoplineBulkFormError,
  type BulkFormExportRow,
} from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run lib/delivery-service.review-fix.test.ts
```

Expected: PASS, every test in the file — the four new tests and every pre-existing one.

- [ ] **Step 8: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful. If this fails because `apps/web` cannot resolve `@wukong/shopline/bulk-form-xlsx`'s types, check that package's `exports` map (`packages/shopline/package.json`) already has a `"development"`/`"types"` condition for that subpath — the importer route already imports from it successfully, so this should already work; if it doesn't, that's a real gap to fix, not something to route around.

```bash
npx prettier --write apps/web/lib/delivery-service.ts apps/web/lib/delivery-service.review-fix.test.ts
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/delivery-service.ts apps/web/lib/delivery-service.review-fix.test.ts
git commit -m "feat(web): export a listing as a bulk-form update"
```

---

### Task 4: Wire the route

**Files:**

- Modify: `apps/web/app/api/listings/[id]/deliver/route.ts`
- Test: `apps/web/app/api/listings/[id]/deliver/route.test.ts`

- [ ] **Step 1: Read the current route file in full**

`apps/web/app/api/listings/[id]/deliver/route.ts` is 247 lines. Confirm `bodySchema`, `responseFor`, and `defaultDelivery` match what's described below before editing.

- [ ] **Step 2: Write the failing test**

Read `apps/web/app/api/listings/[id]/deliver/route.test.ts` first — reuse its existing `deliveryContent`, `listingId`, `context`, and mock-runtime pattern (`vi.hoisted`/`vi.mock("../../../../../lib/intake-runtime", ...)`) rather than rebuilding them. Append this test inside the existing `describe("POST /api/listings/[id]/deliver", ...)` block:

```ts
it("delivers a bulk-form export for an approved, linked listing", async () => {
  const database = {
    forWorkspace: vi.fn(
      async (_workspaceId: string, work: (repos: any) => unknown) =>
        work({
          listings: {
            async requireForPublish() {
              return {
                id: listingId,
                target: "shopline" as const,
                status: "approved" as const,
                activeVersion: {
                  id: versionId,
                  sequence: 1,
                  content: deliveryContent,
                },
                flags: [],
              };
            },
          },
          sourceAssets: { listForListing: async () => [] },
          audit: { write: vi.fn(async () => undefined) },
          platformProducts: {
            async getByListingId() {
              return {
                remoteProductId: "remote_1",
                rawRow: Object.fromEntries(
                  BULK_FORM_COLUMNS.map((column) => [
                    column.key,
                    column.key === "nameEn" ? "Demo Estate Riesling" : "",
                  ]),
                ),
              };
            },
          },
        }),
    ),
  };
  runtimeMocks.getDatabase.mockReturnValue(database);
  runtimeMocks.getAssetStore.mockReturnValue({});

  const handler = createDeliverListingHandler({
    sessionContext: {
      async resolve() {
        return context;
      },
    },
    delivery: defaultDelivery(),
  });

  const response = await handler(
    new Request(`https://wukong.test/api/listings/${listingId}/deliver`, {
      method: "POST",
      body: JSON.stringify({ method: "bulk_form" }),
    }),
    { params: Promise.resolve({ id: listingId }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  expect(response.headers.get("content-disposition")).toContain(".xlsx");
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body.length).toBeGreaterThan(0);
});

it("refuses a bulk-form export with no linked platform product", async () => {
  const database = {
    forWorkspace: vi.fn(
      async (_workspaceId: string, work: (repos: any) => unknown) =>
        work({
          listings: {
            async requireForPublish() {
              return {
                id: listingId,
                target: "shopline" as const,
                status: "approved" as const,
                activeVersion: {
                  id: versionId,
                  sequence: 1,
                  content: deliveryContent,
                },
                flags: [],
              };
            },
          },
          sourceAssets: { listForListing: async () => [] },
          audit: { write: vi.fn(async () => undefined) },
          platformProducts: {
            async getByListingId() {
              return null;
            },
          },
        }),
    ),
  };
  runtimeMocks.getDatabase.mockReturnValue(database);
  runtimeMocks.getAssetStore.mockReturnValue({});

  const handler = createDeliverListingHandler({
    sessionContext: {
      async resolve() {
        return context;
      },
    },
    delivery: defaultDelivery(),
  });

  const response = await handler(
    new Request(`https://wukong.test/api/listings/${listingId}/deliver`, {
      method: "POST",
      body: JSON.stringify({ method: "bulk_form" }),
    }),
    { params: Promise.resolve({ id: listingId }) },
  );

  expect(response.status).toBe(409);
  const json = await response.json();
  expect(json.code).toBe("no_remote_link");
});
```

Add the import this test needs, alongside the existing `ASSET_EXPORT_READ_TTL_MS` import:

```ts
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
```

Check whether `database` in the existing tests in this file is built with a real or partial `forWorkspace` mock shaped differently from what's shown here — the file already has a `runtimeMocks`/`getDatabase` pattern from other tests; match its exact existing shape for `resolveListingImageUrls`'s dependencies (`sourceAssets`, `assetStore`) if the csv/shopline_api tests already had to supply more than what's shown above. The bulk-form path never resolves images, so it should need less than those tests, but confirm rather than assume.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run "app/api/listings/[id]/deliver/route.test.ts"
```

Expected: FAIL — `{"method": "bulk_form"}` is rejected by `bodySchema` before it ever reaches the handler logic (a zod validation error), and there is no `"bulk_form"` case in `responseFor`'s switch yet.

- [ ] **Step 4: Widen the body schema**

In `apps/web/app/api/listings/[id]/deliver/route.ts`, find:

```ts
const bodySchema = z
  .object({ method: z.enum(["csv", "shopline_api"]) })
  .strict();
```

Replace with:

```ts
const bodySchema = z
  .object({ method: z.enum(["csv", "shopline_api", "bulk_form"]) })
  .strict();
```

- [ ] **Step 5: Add the response case**

Find the `responseFor` function's `switch (result.kind)` block. It currently starts with `case "csv":` and its response construction is:

```ts
    case "csv":
      return new Response(result.body, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${listingId}-${result.specVersion}.csv"`,
        },
      });
```

Add a case immediately after it:

```ts
    case "bulk_form":
      return new Response(result.body, {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${listingId}-${result.specVersion}.xlsx"`,
        },
      });
```

Find the `case "disconnected":` block near the end of the same switch (it's the last case, returning a 409 with `code: "shopline_disconnected"`). Add a new case immediately after it, before the switch's closing brace:

```ts
    case "no_remote_link":
      return jsonResponse(409, {
        code: "no_remote_link",
        message:
          "This listing has no linked SHOPLINE product; bulk-form export does not apply.",
      });
```

Confirm `jsonResponse` is already imported in this file (it's used by several existing cases) — it should be, no new import needed.

- [ ] **Step 6: Wire `platformProducts` into `defaultDelivery`**

Find `defaultDelivery`'s `if (input.method === "csv")` block:

```ts
if (input.method === "csv") {
  return database.forWorkspace(input.workspaceId, async (repositories) => {
    return deliverListing(input, {
      listings: repositories.listings,
      imageUrls: (workspaceId, draftId, imageAssetIds) =>
        resolveListingImageUrls({
          workspaceId,
          draftId,
          imageAssetIds,
          sourceAssets: repositories.sourceAssets,
          assetStore,
          // The operator downloads this file and uploads it to SHOPLINE
          // by hand. Ten minutes expires before SHOPLINE ever fetches
          // the images.
          readTtlMs: ASSET_EXPORT_READ_TTL_MS,
        }),
      audit: repositories.audit,
      publisher: {
        async enqueue() {
          throw new Error("SHOPLINE API must use two-phase enqueue");
        },
      },
      connection: async () => {
        const connection = await repositories.shoplineConnections.getDefault();
        return connection ? { id: connection.id, verified: true } : null;
      },
      existingDelivery: (key) =>
        repositories.publishJobs.getByIdempotencyKey(key),
    });
  });
}
```

Replace the condition and add `platformProducts` to the deps object — `bulk_form` needs the exact same wrapping (`database.forWorkspace`, same `audit`, same `listings`) and never touches `imageUrls`/`connection`/`existingDelivery`, but `DeliveryDeps` still requires `imageUrls` and `publisher` to be present, so it reuses the same values csv already supplies rather than inventing a second wrapping block:

```ts
if (input.method === "csv" || input.method === "bulk_form") {
  return database.forWorkspace(input.workspaceId, async (repositories) => {
    return deliverListing(input, {
      listings: repositories.listings,
      imageUrls: (workspaceId, draftId, imageAssetIds) =>
        resolveListingImageUrls({
          workspaceId,
          draftId,
          imageAssetIds,
          sourceAssets: repositories.sourceAssets,
          assetStore,
          // The operator downloads this file and uploads it to SHOPLINE
          // by hand. Ten minutes expires before SHOPLINE ever fetches
          // the images.
          readTtlMs: ASSET_EXPORT_READ_TTL_MS,
        }),
      audit: repositories.audit,
      publisher: {
        async enqueue() {
          throw new Error("SHOPLINE API must use two-phase enqueue");
        },
      },
      connection: async () => {
        const connection = await repositories.shoplineConnections.getDefault();
        return connection ? { id: connection.id, verified: true } : null;
      },
      existingDelivery: (key) =>
        repositories.publishJobs.getByIdempotencyKey(key),
      platformProducts: repositories.platformProducts,
    });
  });
}
```

- [ ] **Step 7: Declare the Node runtime explicitly**

`writeBulkFormWorkbook` uses `node:zlib`. The route currently has no `export const runtime` declaration, which already defaults to Node.js in the Next.js App Router — but the import route (which uses the same xlsx code) declares it explicitly, and this route should match that precedent rather than depend on an implicit default. Find the top-level exports near `bodySchema` (before `type RouteContext`) and add:

```ts
export const runtime = "nodejs";
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run "app/api/listings/[id]/deliver/route.test.ts"
```

Expected: PASS, every test in the file.

- [ ] **Step 9: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write "apps/web/app/api/listings/[id]/deliver/route.ts" "apps/web/app/api/listings/[id]/deliver/route.test.ts"
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 10: Full regression check**

```bash
pnpm test
```

Expected: 14/14 tasks successful — this is the first point in the plan where every previously-passing csv/shopline_api test in both test files has run against the widened types; confirm nothing regressed.

- [ ] **Step 11: Commit**

```bash
git add "apps/web/app/api/listings/[id]/deliver/route.ts" "apps/web/app/api/listings/[id]/deliver/route.test.ts"
git commit -m "feat(web): add bulk-form export to the deliver route"
```

---

### Task 5: Runbook, domain context, and full verification

**Files:**

- Modify: `docs/runbooks/shopline-pilot-onboarding.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Document the flow and the staleness hazard**

Read `docs/runbooks/shopline-pilot-onboarding.md` in full first — find its numbered sections (the existing ones cover Developer Center installation, merchant enablement, the hidden test product, importing a catalog, and enriching an imported catalog). Add a new section after the enrichment section (§5), keeping the existing numbering scheme:

````markdown
## 6. Exporting enrichment back to SHOPLINE

Once an enriched draft is approved, export it as a bulk update form and
re-import that file into SHOPLINE by hand — the same download-then-upload
shape as CSV delivery, using the same route:

```bash
curl -X POST "$WUKONG_BASE_URL/api/listings/<draft-uuid>/deliver" \
  -H "Cookie: $WUKONG_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"method":"bulk_form"}' \
  -o export.xlsx
```
````

This only applies to a listing imported from an existing SHOPLINE product —
one with a linked `platform_products` row. A listing authored fresh in
Wukong has no known remote product ID, so there is nothing for a bulk-form
row to update; use `shopline_api` or `csv` for those, unchanged. Requesting
`bulk_form` for an unlinked listing returns `409 no_remote_link`.

Requires the listing to be `approved` (or `published`), the same review gate
CSV and API delivery already enforce.

**Re-import the catalog immediately before exporting.** The exported file
carries every non-enriched column exactly as it stood at the listing's last
import — price, stock, everything except the eight fields Wukong enriched.
If the merchant changed a price or stock level directly in SHOPLINE since
that import, uploading this export will silently revert it. This is not
validated or warned about automatically; re-importing right before exporting
is the operator's responsibility for now.

````

- [ ] **Step 2: Extend the domain context entry**

In `CONTEXT.md`, find the "Shopline bulk form" section (starts `## Shopline bulk form`). Its last paragraph currently ends: "...and stock delta columns are always reset to `+0` so a re-import never moves inventory." Add a new paragraph immediately after it:

```markdown
Export writes back only through a listing's `platform_products` link — the
join the importer records between a listing and the remote product it came
from. A listing with no such link has no known remote product ID, so there is
no bulk-form row to update; it is not a bulk-form case at all. Every
non-enriched column in an exported row is exactly what the last import saw,
not SHOPLINE's current state, so a merchant-side change since import is
silently reverted on re-upload unless the catalog is re-imported first.
````

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md CONTEXT.md
git commit -m "docs: describe bulk-form export and its staleness hazard"
```

- [ ] **Step 4: Run the full gate**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
pnpm test
```

Expected: 14/14 tasks successful.

```bash
pnpm test:integration
```

Expected: PASS, including Task 1's two new tests. Needs the Postgres container from Prerequisites.

```bash
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

---

## Out of scope

Named so a reviewer does not read their absence as an oversight:

- **Fixing the staleness hazard.** The spec's follow-up #1 (a staleness bound on `platform_products`) and #3 (auto-re-import before export) are real fixes; this plan documents the risk and stops there.
- **Multi-listing bulk-form export.** One file, one listing, matching CSV's existing shape. A cohort-based export (spec follow-up #2) is a separate plan once this has been used once.
- **A dedicated eligibility-policy module for bulk-form export.** The status gate here is three lines inline in `deliverBulkForm`, not a reusable policy function — there is exactly one caller, and `evaluateDeliveryPolicy` itself only became a shared module because two callers (web and worker) needed the same create-eligibility decision. Extracting one here would be premature.
