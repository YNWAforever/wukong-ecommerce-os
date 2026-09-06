# Workbook Base Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Select a SHOPLINE XLSX, automatically preview it, then import its eligible products into the Wukong catalog without typed fields or SHOPLINE credentials.

**Architecture:** Keep the connected importer unchanged. Add a deterministic workbook-base projection, two immutable workspace-scoped tables, stateless preview and save endpoints that reparse the original file, and catalog/read UI support for sourceType workbook. No listing drafts or remote-platform links are created by this slice, so existing review/export authority cannot be accidentally inherited.

**Tech Stack:** Node 24, pnpm 11.7, TypeScript, Next.js 16/React 19/plain CSS, Drizzle/Postgres, existing SHOPLINE XLSX reader, Vitest and Playwright.

## Global Constraints

- This path needs no SHOPLINE account, connection, token, store URL, manually entered export date, catalog name, or column mapping.
- The first slice supports the existing recognized SHOPLINE workbook contract, its 4 MiB upload limit and 5,000 parsed-row limit.
- Do not populate merchantAttestedExportAt from inferred metadata or set any freshness-attestation boolean automatically.
- No automatic AI enrichment, SHOPLINE writes, website crawl, remote image download or paid provider call is triggered by file selection or import.
- Do not upload the supplied merchant workbook for tests. No production migration, deployment, provider activation or merchant-data seeding is included in this design approval.
- All reads/mutations use server session workspace identity, scoped repositories, existing RLS/audit conventions and operator role checks. Preserve connected import, existing source bindings and unrelated work.
- Use synthetic fixtures and isolated localhost services. Never hardcode a task-specific database-name requirement in committed tests; use the repository TEST_DATABASE_URL/TEST_DATABASE_ADMIN_URL contract.
- Base SHA is 49e84a3b21c9d384dd5b6f1019441322931fbb48. Existing isolated worktree is C:/Users/laich/Documents/WukongEommerce/worktrees/attempt-evidence-packet, branch codex/workbook-base-import.

## Shared decisions

The existing parser intentionally rejects variant rows, duplicate Product IDs, missing IDs and missing SKUs. Reuse these classifications rather than silently relaxing the connected export contract. Retain the entire normalized source sheet including excluded variant rows in immutable import evidence, and show their blocking reasons/counts in preview. Only parser-eligible rows become catalog products. This preserves variant evidence without claiming newly validated variant support.

Do not add per-row selection in the first slice: import all eligible rows after displaying exact eligible/excluded counts. Show at most 20 eligible preview rows with an explicit sample label; the save includes every eligible row, up to 5,000. Changed files create separate source imports; identical bytes in one workspace return the existing result. Filename, SKU, title and unbound remote IDs never merge different sources.

### Task 1: Deterministic workbook-base projection

**Files:** Create packages/shopline/src/workbook-base.ts and workbook-base.test.ts; export from packages/shopline/src/index.ts. Existing bulk-form.ts and its connected parser remain unchanged.

**Interfaces:**

```ts
import type {
  BulkFormSheet,
  BulkFormRawRow,
  BulkFormIssue,
  BulkFormText,
} from "./bulk-form.js";
export type WorkbookBaseProduct = {
  rowNumber: number;
  productId: string;
  sku: string;
  title: BulkFormText;
  priceHkd: number | null;
  raw: BulkFormRawRow;
};
export type InferredWorkbookTime = {
  value: string;
  source: "filename";
  timeZone: null;
};
export type PreparedWorkbookBase = {
  specVersion: string;
  sheet: BulkFormSheet;
  products: WorkbookBaseProduct[];
  totalRows: number;
  excludedRows: number;
  issues: BulkFormIssue[];
  inferredExportTime: InferredWorkbookTime | null;
};
export function inferWorkbookExportTime(
  filename: string,
): InferredWorkbookTime | null;
export function prepareWorkbookBase(
  sheet: BulkFormSheet,
  filename: string,
): PreparedWorkbookBase;
```

- [x] Write failing tests with actual synthetic 71-column headers/rows. Cover a recognized dated filename, renamed/missing date, impossible calendar dates, future-looking dates retained only as inference, exact original local timestamp with no timezone conversion; supported rows with both language titles/prices; all raw cells preserved; blank/header rows not counted; missing IDs/SKUs, duplicate IDs and variants explicitly excluded but retained in sheet; malformed headers yield issues and zero products.

```ts
expect(
  inferWorkbookExportTime("synthetic-BulkUpdateForm-2026-05-21-15-50_0.xlsx"),
).toEqual({ value: "2026-05-21T15:50", source: "filename", timeZone: null });
expect(inferWorkbookExportTime("renamed.xlsx")).toBeNull();
expect(
  inferWorkbookExportTime("x-BulkUpdateForm-2026-02-30-15-50.xlsx"),
).toBeNull();
```

- [x] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/shopline exec vitest run src/workbook-base.test.ts` and record expected RED assertions.
- [x] Implement strict regex/date validation and projection through parseBulkForm. TotalRows counts nonblank data rows after recognized headers, never leading instructions/header cells. Preserve raw input sheet and original row numbers. Do not coerce an inferred date into Date or attestation.

```ts
const parsed = parseBulkForm(sheet);
const products = parsed.rows.map((row) => ({
  rowNumber: row.rowNumber,
  productId: row.productId,
  sku: row.sku,
  title: row.content.name,
  priceHkd: row.facts.priceHkd,
  raw: row.raw,
}));
// Count actual nonblank data rows after parsed.localeHeaderRow ?? parsed.headerRow.
// Return parser issues and totalRows - products.length as explicit exclusions.
```

- [x] Run focused tests, the SHOPLINE package unit suite and typecheck; format changed files; commit explicit paths. Report RED/GREEN evidence and exact final exported interfaces.

### Task 2: Immutable storage and credential-free preview/save APIs

**Files:** Create packages/db/drizzle/0020_workbook_catalog.sql; add schema exports in packages/db/src/schema.ts; create repositories/workbook-catalog.ts and workbook-catalog.integration.test.ts; register in client.ts/index.ts. Create apps/web/lib/workbook-import.ts and workbook-import.test.ts; apps/web/app/api/workbook-imports/preview/route.ts and route.test.ts; apps/web/app/api/workbook-imports/route.ts and route.test.ts.

**Interfaces:** Consumes Task 1. Produces repositories.workbookCatalog.save({filename,workbookSha256,headerContractSha256,sheetName,prepared,actorId}) -> {importId,importedProducts,alreadyImportedProducts,excludedRows}; and getProduct(id) -> null or {id,sourceType:'workbook',product:WorkbookBaseProduct,source:{id,filename,sheetName,inferredExportTime,createdAt},canExport:false}.

Preview response: {workbookSha256,headerContractSha256,specVersion,filename,sheetName,inferredExportTime,totalRows,eligibleProducts,excludedRows,products:WorkbookBaseProduct[],issues:BulkFormIssue[],totalIssues}. products contains first 20 eligible rows only; issues are bounded to 100 with totalIssues. Preview projection excludes raw sheet and raw row objects from the public response; use Pick<WorkbookBaseProduct,'rowNumber'|'productId'|'sku'|'title'|'priceHkd'>[] publicly.

- [x] Write failing route/service tests: no connection/date/key required; unauthenticated/insufficient role cannot parse or persist; preview has zero DB writes; malformed/empty/oversized workbook or sheet returns a safe actionable code; more than 5,000 data rows fails before DB; zero eligible rows remain a visible preview with issues and cannot save; all 21 eligible rows save although preview samples 20; excluded source rows retained; save hash/header mismatch returns 409; untrusted JSON/URL cannot provide workspace/product records or attestation.

```ts
const request = new Request(
  "https://app.test/api/workbook-imports/preview?filename=synthetic.xlsx",
  { method: "POST", body: syntheticBytes },
);
// injected session operator; real synthetic XLSX reader; persistence spy untouched.
expect((await handler(request)).status).toBe(200);
```

- [x] Run focused tests and record RED. Add additive immutable tables workbook_imports (workspace+file digest unique, original filename, sheet name, header digest, normalized sheet, spec version, inferred time JSON nullable, counts, actor/server creation time) and workbook_products (workspace+import FK, original row number, normalized product JSON, unique workspace/import/row). RLS+FORCE RLS, tenant-composite FK, SELECT/INSERT only for wukong_app, UPDATE/DELETE guards. No fake connections, listing drafts or platform products. Save is one transaction, uses conflict-safe insert/on-conflict-do-nothing and returns existing result on replay; audit once per new import including counts only. Require operator membership at repository mutation boundary. Bound source JSON to 16 MiB, each product JSON to 1 MiB, data rows to 5,000. Retain full normalized sheet including excluded rows.
- [x] Implement a shared injected Node workbook parsing service using relationship-bound readDefaultBulkFormSheet with matching Default source name, byte SHA-256 and hashBulkFormHeaderContract. Read request body with a 4 MiB streaming cap; enforce it even without Content-Length. Reject filename over 255 chars or not .xlsx. Explicit maxDuration=300 on saving route. All responses no-store; same role/session/error pattern as existing routes. On save reparse bytes and compare x-workbook-sha256 and x-workbook-header-sha256 against server-computed values before persisting. Never trust a client preview as records.
- [x] Integration tests with explicit TEST_DATABASE_*: successful save with no connection; concurrent/idempotent retry produces one source, one product per eligible row and one import audit; cross-tenant reads and FK writes rejected; update/delete denied; original variant raw row and exact IDs preserved; no platform/draft rows; rollback on invalid evidence. Use isolated services provided by controller, no production access.
- [x] Run all affected unit/integration suites, typecheck DB/web and format. Commit explicit paths and report evidence. Controller owns starting/stopping shared synthetic services.

### Task 3: Automatic preview, one-click save and catalog visibility

**Files:** Create apps/web/components/workbook-import-panel.tsx and tests, workbook-product-detail.tsx and tests. Modify listing-intake-tabs.tsx/test, catalog-control-center.tsx/test, catalog-view-models.ts/test, apps/web/lib/catalog-contract.ts/test, apps/web/app/api/catalog/route.ts/test; create apps/web/app/api/workbook-products/[id]/route.ts and tests. Extend packages/db/src/repositories/workspace-reads.ts and its integration tests. Add focused plain CSS as needed to apps/web/app/globals.css or colocated module.

**Interfaces:** Consumes Task 2 API and repository. Extend CatalogItem/CatalogReadItem with {sourceType:'workbook',id,title,sku,sourceProductId,createdAt,updatedAt,canExport:false}; summary.workbook and filter workbook. Match source product ID, title and SKU; share existing page ordering/count snapshot with platform and website rows. No workflow cohort or export checkbox for workbook rows. Detail API uses workbookCatalog.getProduct inside authenticated workspace; uuid validation, 404 foreign ID, no-store.

- [x] Write failing mounted component tests: selecting file immediately calls preview and shows Reading workbook; no date/connection/text fields; all eligible count reflected in Import N products, even >20 sample; no save until click; save sends retained file bytes + exact preview hashes; status/counts/catalog link on success and replay; errors retain file and preview; retry correct failed stage; race after changing file ignores old success/error; duplicate clicks issue one save; missing operator capability blocks both preview/save; keyboard/tab navigation retains selected file state.
- [x] Keep BulkImportPanel and legacy connected API behavior/test contract intact. Replace the default Workbook tab contents with WorkbookImportPanel and provide a collapsed Connected SHOPLINE update option for users who need the existing connection-bound refresh workflow. Pass role capability from the intake page, retain first-mounted workbook state across tabs, and keep the website tab behavior unchanged.
- [x] Implement state flow with generation IDs and AbortController around preview/save. No date guessing into API attestation. Render bilingual supported-field preview table, exact totals/exclusions and human-readable issue reasons; show source-date inference under optional source details only. Unknown dates do not affect actions. Reset save result on new file; safe error copy, retry preview/save distinctly. New file invalidates old actionable preview; no late response can re-enable saving it.
- [x] Add catalog SQL union arm scoped to workspace and extend filter/count/map. Only platform items call source readiness or have export actions. Detail view renders stored title, price, source IDs/SKU and raw source fields as text; no script/HTML execution or image fetching. Add bilingual Workbook source badge and View details control.
- [x] Add regression tests for mixed-source pagination, filters/counts, workbook detail auth/tenant isolation, all API selection filters excluding workbook from platform enrichment/review. Verify direct existing export/delivery requests with a real saved workbook ID return rejection and create no export/job: use existing injected entry-point factories and isolated DB where meaningful.
- [x] Run focused UI/API and integration tests; web/DB typecheck and format. Commit explicit paths and report evidence.

### Task 4: End-to-end acceptance and source-bound regression gates

**Files:** Add tests/e2e/workbook-import.spec.ts (use existing isolated E2E auth/data fixture); update CONTEXT.md and create docs/superpowers/plans/2026-09-06-workbook-base-import-results.md. Only add supporting test hooks if existing dependency injection cannot exercise real application routes with synthetic fixtures.

- [x] Reproduce existing selected-file/no-import gate against the baseline evidence, then run browser acceptance against the implementation: no connection, select synthetic dated and renamed workbook, preview automatically, import >20 valid products with explicit excluded row, browse catalog and detail, replay same bytes without duplication, switch tabs without losing file, failed request retry, English/Traditional Chinese and 375px/1440px layouts.
- [x] Run `pnpm test`, `pnpm test:integration` with isolated explicit TEST_DATABASE_* plus synthetic asset services, `pnpm typecheck`, `pnpm lint`, `pnpm build`, runtime-format/forbidden gates and affected Playwright tests. Distinguish baseline/environment failures from regressions. Never source production envs or invoke paid providers.
- [x] Review full branch for source/tenant/idempotency boundaries and record exact checks, schema deployment prerequisite, any remaining source-binding limitations and browser evidence. Update spec status as implemented only after tests/review pass; stop isolated services owned by this task. Stage only focused files and leave production unchanged.

## Progress

- [x] Task 1 projection
- [x] Task 2 persistence and APIs
- [x] Task 3 UI and catalog
- [x] Task 4 acceptance and review
