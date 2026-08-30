# Bulk Update Freshness Gate — Design

**Date:** 2026-08-30
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — second half of Package E (§16), addressing §7 G4 and §11's "Immutable source-import and freshness gate" requirement.

## 1. What this builds

Today, `platform_products` stores each imported product's raw row and content digest, but there is no durable record of the _import event itself_ (which file, whose export, when), and no function enforcing the master instruction's freshness/identity conditions before an export is allowed to proceed. This package builds that missing entity and gate function — not the export flow that will eventually call it (that's Package H, not yet built).

Confirmed via direct schema inspection: no `sourceImportId`-like entity exists anywhere in `packages/db/src/schema.ts` today.

## 2. Schema changes

**New table `source_imports`:**

```ts
export const sourceImports = pgTable(
  "source_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id)
      .notNull(),
    connectionId: uuid("connection_id")
      .references(() => shoplineConnections.id)
      .notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("source_imports_workspace_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);
```

RLS: same `FORCE ROW LEVEL SECURITY` + workspace policy pattern already applied to every other tenant table (`packages/db/drizzle/0000_initial.sql`'s loop) — this table is added to that loop, not a new pattern.

**`platform_products` gets one new nullable column:** `sourceImportId: uuid("source_import_id").references(() => sourceImports.id)`. Nullable because existing rows (imported before this migration) have no import record to point to — expand/contract: add nullable, backfill nothing (no reliable data to backfill from), new imports always set it.

No new "row snapshot" table — `platform_products.rawRow`/`contentDigest` already are the per-product snapshot; the FK just attributes them to the import batch they came from.

## 3. Import-path wiring

`createBulkFormImporter` (`apps/web/lib/bulk-form-import.ts`) gains one step: before processing rows, compute `workbookSha256` (hash of the raw uploaded bytes — the route already has these before calling the importer) and `headerContractSha256` (hash of `BULK_FORM_COLUMNS`'s ordered header cells — already computed once per process, not per-row), insert one `source_imports` row, then pass its `id` into every `platform_products` upsert as `sourceImportId`. `merchantAttestedExportAt` and `importerId` come from the caller (route handler), not invented by the importer — this requires the route's request shape to grow one required field (the merchant-attested export timestamp), which the eventual import UI will need to collect. For this package, the route/API contract change is in scope; the UI to collect that timestamp is not (the existing `BulkImportPanel` doesn't ask for it yet — that's a follow-up, tracked but not blocking this package, since the API can be built and tested with an assumed/passed value before the UI catches up).

## 4. `assertExportFreshness` service

New pure function (with injected repository deps, matching the codebase's existing ports-and-adapters convention):

```ts
type AssertExportFreshnessInput = {
  workspaceId: string;
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
  freshnessAttested: boolean;
};
type FreshnessFailure =
  | { ok: false; reason: "not_attested" }
  | { ok: false; reason: "no_remote_link" }
  | { ok: false; reason: "source_import_mismatch" }
  | { ok: false; reason: "row_digest_mismatch" }
  | { ok: false; reason: "version_mismatch" }
  | { ok: false; reason: "header_contract_stale" };
type FreshnessResult = { ok: true } | FreshnessFailure;
```

Checks, in order (fail fast, one reason per call — matches the existing `ApiError` single-code convention elsewhere in this codebase):

1. `freshnessAttested` must be `true` — **no timestamp/threshold comparison of any kind**, per the master instruction's explicit directive not to hard-code 24/72h until Opak approves a policy. This is the whole "gate": a human must have explicitly confirmed freshness before calling this function with `true`.
2. The listing's `platform_products` link exists and its `sourceImportId` equals `expectedSourceImportId`.
3. Its `contentDigest` equals `expectedRowDigest`.
4. The listing's `activeVersionId` equals `expectedVersionId`.
5. The `source_imports` row's `headerContractSha256` equals a freshly-computed hash of the _current_ `BULK_FORM_COLUMNS` contract (catches the case where the runtime's column contract changed since import — a code-level drift check, not a data-freshness check).

## 5. Testing

- Migration: cross-workspace RLS negative test for `source_imports`, matching the existing pattern (e.g. `memberships.integration.test.ts`'s style).
- `createBulkFormImporter`: extend existing tests to assert a `source_imports` row is created and `sourceImportId` is stamped on every upserted `platform_products` row in a batch.
- `assertExportFreshness`: one test per failure reason (6 total) plus one success-path test — pure function, dependency-injected repo, no DB needed for the unit tests (integration test for the real repository query is separate, matching the existing `*.integration.test.ts` convention).

## 6. Self-review

- **Placeholder scan:** none.
- **Internal consistency:** §3's route-contract growth (merchant-attested timestamp becomes required) is consistent with §4's check needing that value to exist on the `source_imports` row.
- **Scope check:** backend-only, no UI, no wiring into `deliverBulkForm` — matches Package E's original boundary in the integration plan; wiring into an actual export call is explicitly Package H's job.
- **Ambiguity check:** "who provides `merchantAttestedExportAt`" is resolved explicitly — the route caller, not the importer; the UI gap this creates is named, not hidden.
