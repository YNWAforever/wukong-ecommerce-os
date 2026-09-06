# Operations Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution or superpowers:subagent-driven-development if the user selects that execution method. Steps use checkbox syntax for tracking.

**Goal:** Give operators a reliable home worklist with accurate attention/progress/completion counts and direct routes to existing workflow actions.

**Architecture:** Add a workspace-scoped read repository that classifies retained records in one SQL snapshot, expose it through an injected API route, and render it through a localized workbench client. Keep mutation services authoritative. Add only the destination filters needed to preserve exact task context.

**Tech Stack:** Node 24, pnpm 11.7.0, TypeScript, Next.js 16, React 19, plain CSS, Drizzle/Postgres, Vitest and Playwright.

## Global constraints

- Approved specification: `docs/superpowers/specs/2026-09-06-operations-workbench-design.md` (user approved after commit 0c03602).
- Source baseline: main `0a25e701e04238f24f3c73bf6761da0b01dcca00`; plan branch `codex/operations-workbench-design` in the existing isolated worktree.
- Before implementation, fetch main and compare changes since the baseline. Preserve unrelated work. Create a `codex/operations-workbench` execution branch from the approved planning branch; no force resets or worktree deletion.
- Graph discovery must be verified against active files. The graph has no current website/workbook repository entries; actual files are `website-catalog.ts` and `workbook-catalog.ts`.
- No migration, new task persistence, automatic mutation, source-to-draft conversion, provider call, paid provider, production seeding or real workbook upload. Real SHOPLINE writes stay disabled.
- Preserve review context, source binding, export receipts and existing role checks. Deployment requires a separate release approval.
- Page size defaults to 25 and is capped at 100. Counts use all retained history under the selected kind filter, not the returned page. Task count and product count are distinct.
- Use the locale cookie; Traditional Chinese or English copy, accessible keyboard controls and responsive CSS. No new styling framework or runtime dependency.
- Every task follows red test -> observed failure -> implementation -> green test -> explicit-path commit. Record actual command outcomes; do not describe planned checks as completed.

## Confirmed source map

| Existing path | Responsibility |
| --- | --- |
| `packages/db/src/client.ts` | `WorkspaceRepositories`, scoped repository construction |
| `packages/db/src/schema.ts` | listing, export, scan and workbook retained fields |
| `packages/db/src/repositories/workspace-reads.ts` | current paginated catalog and Jobs read patterns |
| `packages/db/src/repositories/website-catalog.ts` | queued/running/ready/partial/failed scan lifecycle |
| `packages/db/src/repositories/workbook-catalog.ts` | immutable successful imports; no preview-failure persistence |
| `apps/web/lib/export-reconciliation.ts` | exact included listing/version and latest revision receipt rules |
| `apps/web/lib/use-latest-request.ts` | cancellation and superseded-request protection; stale flag currently only covers loading |
| `apps/web/components/jobs-ledger-client.tsx` | existing Jobs filters, attempt inspection; no initial URL kind state yet |
| `apps/web/app/api/catalog/route.ts` | catalog query validation; no import ID filter yet |
| `apps/web/app/(app)/shell-nav-items.ts` | existing primary route list |
| `tests/e2e/real-stack-fixture.ts` | isolated authenticated browser fixtures |

## Contract decisions resolved during planning

- A website `ready` scan is Completed with "Preview ready". A `partial` scan is Completed with "Partial preview — inspect limitations"; it must not claim a full scan or saved products. `queued`/`running` are In progress; `failed` is Needs attention. Dispatch metadata does not independently reclassify terminal states.
- Export legacy null artifact status and impossible ready artifacts with no included members are Unclassified, not successful completion. Show a read-only history destination and a separate unavailable-status count.
- Export last update is the greatest of creation, artifact readiness and relevant receipt creation. A failure without a stored failure timestamp uses creation time labelled "Recorded", not an invented last-change time.
- Completed workbook timestamp is `created_at`, count is `eligible_products`, and source title is `filename`; do not serialize normalized sheets or product bindings in the workbench response.
- Listing display comes from the existing active-version title projection, falling back to a localized "Untitled listing". Product count is one. Jobs/pipeline/batch members do not generate duplicate listing tasks.

## Task 1: Define workbench states and the read contract

**Files:** Create `packages/db/src/repositories/workbench-contract.ts` and `workbench-contract.test.ts`; export types from `packages/db/src/index.ts`.

**Interfaces:** Produce these shared types; web code imports them as types from `@wukong/db`.

```ts
export type WorkbenchKind = 'listing' | 'export' | 'website_scan' | 'workbook_import';
export type WorkbenchState = 'attention' | 'progress' | 'completed' | 'unclassified';
export type WorkbenchQuery = {
  state: WorkbenchState;
  kind?: WorkbenchKind;
  page: number;
  pageSize: number;
};
export type WorkbenchReason =
  | 'failed' | 'needs_info' | 'review' | 'delivery' | 'result_needed'
  | 'processing' | 'published' | 'result_reported'
  | 'preview_ready' | 'preview_partial' | 'imported' | 'unknown';
export type WorkbenchItem = {
  key: string;
  id: string;
  kind: WorkbenchKind;
  state: WorkbenchState;
  reason: WorkbenchReason;
  title: string | null;
  sourceLabel: string | null;
  productCount: number | null;
  occurredAt: string;
  timestampKind: 'updated' | 'recorded';
};
export type WorkbenchPage = {
  items: WorkbenchItem[];
  counts: Record<WorkbenchState, number>;
  totalMatching: number;
  observedAt: string;
  page: number;
  pageSize: number;
};
export function classifyListing(status: string): WorkbenchReason {
  switch (status) {
    case 'failed': case 'publish_failed': return 'failed';
    case 'needs_info': return 'needs_info';
    case 'in_review': case 'reopened': return 'review';
    case 'approved': return 'delivery';
    case 'received': case 'processing': case 'publishing': return 'processing';
    case 'published': return 'published';
    default: return 'unknown';
  }
}
```

- [ ] Write table-driven tests for all 11 listing statuses plus an unknown string. Assert each reason maps to exactly one state, including approved -> attention and reopened -> review.

```ts
it('keeps approved work actionable and unknown states visible', () => {
  expect(classifyListing('approved')).toBe('delivery');
  expect(classifyListing('reopened')).toBe('review');
  expect(classifyListing('future_status')).toBe('unknown');
});
```

- [ ] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/db exec vitest run src/repositories/workbench-contract.test.ts`; observe red before adding the exported implementation above.
- [ ] Add the types and pure classifier. Keep this classifier a semantic oracle for database parity tests; the database applies its equivalent predicates before pagination, never to a truncated result page.
- [ ] Run the focused command to green and package typecheck. Commit explicit paths as `feat: define workbench read contract`.

## Task 2: Implement one-snapshot workbench reads

**Files:** Create `packages/db/src/repositories/workbench-reads.ts`, `workbench-reads.integration.test.ts`; modify `packages/db/src/client.ts` and `packages/db/src/index.ts`.

**Interfaces:** `createWorkbenchReadRepository(transaction: WorkspaceTransaction, workspaceId: string, scope: WorkspaceScope)` returns `{ page(query: WorkbenchQuery): Promise<WorkbenchPage> }`; register as `repositories.workbench` inside the existing workspace transaction.

- [ ] Build integration fixtures with explicit `TEST_DATABASE_ADMIN_URL` and `TEST_DATABASE_URL`, using the setup/cleanup conventions from `workbook-catalog.integration.test.ts`. Never require a developer-specific database suffix and never fall back to production URLs. Use synthetic UUIDs, `.test` email addresses and synthetic worksheets.
- [ ] Seed 31 listings covering every status, two workspaces, five scans, successful workbook imports, and pending/failed/ready/legacy exports. Attach pipeline rows to existing listings and prove those do not increase item counts. Add export corrections against exact included listing/version identities, plus wrong-version and manual receipts that must not affect reconciliation.
- [ ] Write assertions for pagination, exact totals, role-scoped tenant isolation, unknown legacy exports, state parity and no content-heavy fields in the response. Example required assertion shape:

```ts
const first = await db.forWorkspace(ws, r => r.workbench.page({
  state: 'attention', page: 1, pageSize: 25,
}));
const second = await db.forWorkspace(ws, r => r.workbench.page({
  state: 'attention', page: 2, pageSize: 25,
}));
expect(first.counts).toEqual(second.counts);
expect(new Set([...first.items, ...second.items].map(x => x.key)).size)
  .toBe(first.items.length + second.items.length);
expect(first.items.every(x => !('normalizedSheet' in x))).toBe(true);
```

- [ ] Run `corepack.cmd pnpm@11.7.0 exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/workbench-reads.integration.test.ts`; observe missing method red using only the isolated service environment.
- [ ] Implement a parameterized `WITH` query: workspace-filtered `listing_items`, `scan_items`, `workbook_items`, `export_members`, `export_items`, then `items UNION ALL`, `filtered`, `counts`, `selected`. `scope.assertOpen()` runs before SQL. Validate integer pagination and safe offset before calling SQL.
- [ ] In export member aggregation, expand only `manifest` entries whose outcome is `included`. Match receipts on workspace, mode=`export`, export attempt ID, listing ID AND version ID; take the highest revision. Manual/legacy receipts are excluded. Count accepted/rejected/unreported and compare the returned fixtures with `buildExportReconciliation` in the existing web tests.

```sql
SELECT r.outcome, r.created_at
FROM import_results r
WHERE r.workspace_id = e.workspace_id
  AND r.mode = 'export' AND r.export_attempt_id = e.id
  AND r.listing_id::text = member->>'listingId'
  AND r.version_id::text = member->>'versionId'
ORDER BY r.revision DESC
LIMIT 1
```

- [ ] Classify exports with failed before pending; ready with positive included count and zero rejected/unreported is result_reported, other ready positive-included records result_needed, remaining records unknown. Classify the five exact website states as described above. Aggregate workbook counts from retained scalar metadata. Do not select checkpoint/product/source-sheet blobs into response JSON.
- [ ] Compute counts and selected membership in the same statement, returning one JSON envelope even when the selected page is empty. Attention sort key: failed=0, needs_info=1, review=2, delivery/result_needed=3, then oldest occurredAt and key. Other states sort newest occurredAt then key. SQL parameters select kind/state; never interpolate untrusted sort fragments.
- [ ] Verify stable equal-timestamp ordering, empty/out-of-range pages retaining counts, classification parity and isolation. Run EXPLAIN on a synthetic multi-page population to verify no per-item query loop. No new index/migration is authorized by this task.
- [ ] Run focused integration and package typecheck to green; commit `feat: add workspace workbench projection`.

## Task 3: Add the authenticated read endpoint and safe destination mapping

**Files:** Create `apps/web/app/api/workbench/route.ts`, `route.test.ts`, `apps/web/lib/workbench-actions.ts`, `workbench-actions.test.ts`.

**Interfaces:** `createWorkbenchHandler(deps: {sessionContext: SessionContextPort; getDatabase(): Database})` exposes GET. `workbenchDestination(item: WorkbenchItem): string` is a pure allowlisted route mapping. Return `{...WorkbenchPage, capabilities: {canImport: boolean, canReview: boolean, canRecordImportResult: boolean}}` using existing role helpers.

- [ ] Write route tests injecting a fake database: anonymous ->401, invalid UUID-free filters/state/page ->400, viewer ->200 with no import/review/report capability, reviewer ->review capability, and session workspace used regardless of an unrecognized query workspaceId.
- [ ] Validate exactly these parameter domains with zod:

```ts
const querySchema = z.object({
  state: z.enum(['attention','progress','completed','unclassified']).default('attention'),
  kind: z.enum(['listing','export','website_scan','workbook_import']).optional(),
  page: z.coerce.number().int().min(1).max(21474836).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
```

- [ ] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run app/api/workbench/route.test.ts lib/workbench-actions.test.ts` red. Implement the existing `withRouteErrors`/`requireSessionContext` route pattern; use one `forWorkspace` call and `repositories.workbench.page(query)`. Return private no-store response headers.
- [ ] Define destination mapping with URLSearchParams; encode identifiers and never accept a caller-supplied external destination:

```ts
export function workbenchDestination(item: WorkbenchItem): string {
  switch (item.kind) {
    case 'listing': return `/listings/${encodeURIComponent(item.id)}`;
    case 'export': return `/jobs?${new URLSearchParams({kind:'export',attempt:item.id})}`;
    case 'website_scan': return `/listings/import?${new URLSearchParams({scan:item.id})}`;
    case 'workbook_import': return `/catalog?${new URLSearchParams({filter:'workbook',importId:item.id})}`;
  }
}
```

- [ ] Action labels use capability evidence: unauthorized review is View details with reviewer-required explanation; no mutation is made by any workbench link. Run focused tests to green and commit `feat: expose authorized workbench reads`.

## Task 4: Preserve exact export and workbook destination context

**Files:** Modify `apps/web/components/jobs-ledger-client.tsx`, `apps/web/components/catalog-control-center.tsx`, `apps/web/app/api/catalog/route.ts`, `packages/db/src/repositories/workspace-reads.ts`; create `apps/web/lib/workbench-navigation.ts` and `workbench-navigation.test.ts`; extend `apps/web/components/catalog-control-center.test.tsx` and the existing Jobs tests and `workspace-reads.integration.test.ts`.

**Interfaces:** Catalog accepts optional UUID `importId`; Jobs accepts initial `kind=export` and UUID `attempt` independent of ledger pagination. Add a `WorkbenchReturnLink` in `apps/web/components/workbench-return-link.tsx` taking only a validated dashboard return path.

- [ ] Write a regression proving a workbook import on page two opens only its products, not every workbook in the workspace. Query `importId` constrains items and matching totals before pagination; use explicit "This import" scope text. Global catalog summary stays explicitly workspace-scoped. Foreign import IDs return no matching rows without revealing ownership.
- [ ] Write a Jobs regression opening an older attempt absent from page one. Fetch its existing `/api/listings/export/:id` endpoint directly into the current attempt inspector/reconciliation components; do not scan pages. Invalid/foreign/missing IDs produce safe errors and preserve ledger navigation.
- [ ] Run focused tests red. Add optional importId to the route schema and repository input; constrain the workbook branch by `workbook_products.import_id`, exclude other source branches when importId is set, and propagate the parameter through client pagination/search requests.
- [ ] Initialize Jobs kind state from validated URL parameters and render the exact selected attempt separately from the paginated ledger. Keep all-Jobs access and existing attempt receipts and verification labels.
- [ ] Add a bounded internal return-path validator; reject external/protocol-relative URLs. Only `/dashboard` with whitelisted state/kind/page parameters can be used. Browser Back remains the primary restoration mechanism; a contextual return link uses the same validated parameters. Pass current workbench query context on row navigation, including website and listing destinations, without encoding sensitive content.
- [ ] Test return-path rejection and accepted normalization:

```ts
expect(normalizeWorkbenchReturn('//example.test')).toBe('/dashboard');
expect(normalizeWorkbenchReturn('/dashboard?state=attention&page=2'))
  .toBe('/dashboard?state=attention&page=2');
```

- [ ] Run modified Jobs/catalog unit tests plus `corepack.cmd pnpm@11.7.0 exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/workspace-reads.integration.test.ts`; commit `feat: preserve workbench destination context`.

## Task 5: Render the workbench with honest loading and counts

**Files:** Create `apps/web/components/workbench-client.tsx`, `workbench-summary.tsx`, `workbench-list.tsx`, `workbench-client.test.ts`, `apps/web/lib/workbench-copy.ts`, `workbench-query.ts`, `workbench-query.test.ts`; modify `apps/web/app/(app)/dashboard/page.tsx` and `apps/web/app/globals.css`.

**Interfaces:** `WorkbenchClient` reads URL query and `/api/workbench`; `WorkbenchSummary` consumes counts/selected state and renders navigation; `WorkbenchList` consumes returned items/capabilities/locale/return context. `workbench-copy.ts` contains complete zh/en keys for every WorkbenchReason and controls.

- [ ] Write tests for initial loading, first read failure, same-query failed refresh retaining data, different-query loading clearing old membership, reversed response ordering, empty filtered work, and exact page reset when kind/state changes.
- [ ] Use the existing request hook but wrap each result with its canonical query key; never display a returned page when its key differs from the current query. Set visible stale status when retained matching data has either loading OR error, because the current hook's `stale` value alone does not represent failed refresh.

```ts
const matching = response?.queryKey === queryKey ? response.page : null;
const retainedStale = matching !== null && (loading || error !== null);
```

- [ ] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run components/workbench-client.test.ts lib/workbench-query.test.ts` red.
- [ ] Implement the approved visual hierarchy with live data only: primary import link, three summaries, state/kind controls, 25-row list, pagination and optional guidance. Unknown count gets a separate accessible link to state=unclassified. Use `aria-pressed`, `aria-busy`, `role=status` and explicit observed-time/stale labels.
- [ ] Add a focus listener calling refresh, cleanup on unmount, and explicit Retry. Do not add polling. Preserve state/kind/page in the URL with browser history; protect data against late requests. Empty first load does not produce zero metrics on error.
- [ ] Replace dashboard's latest-five component with WorkbenchClient. Keep old component/tests until usage is checked; do not delete unrelated code. Import is primary for operator+; viewer receives explanatory read-only copy.
- [ ] CSS uses scoped `.workbench-*` selectors and existing tokens. Desktop has a secondary guidance panel; mobile stacks rows/actions and collapses guidance. Keep minimum 44px interactive targets, visible focus and no essential horizontal overflow. Production copy follows current locale, not the mockup's repeated bilingual labels.
- [ ] Run focused tests and web typecheck to green; commit `feat: build operator workbench interface`.

## Task 6: Group navigation without losing existing tools

**Files:** Modify `apps/web/app/(app)/shell-nav-items.ts`, `apps/web/components/app-shell-nav.tsx`, `apps/web/app/globals.css`, `apps/web/components/app-shell-nav.test.tsx`; extend `tests/e2e/catalog-usability-checks.ts` only if shared navigation assertions require the approved new labels.

**Interfaces:** Add optional `group: 'primary' | 'tools'` to NavItem; existing caller defaults to primary. Keep existing admin settings insertion and mobile drawer behavior.

- [ ] Write tests that Workbench/Catalog/Imports/Exports are primary while Queue/Batches/New listing/all Jobs/Quality/System map remain discoverable in Tools. Verify admin-only navigation is still omitted for lower roles.
- [ ] Represent Exports with `/jobs?kind=export`, all Jobs with `/jobs`. Active state compares pathname plus the relevant validated kind parameter so only one is selected. Deep attempt routes activate Exports. Do not use raw `startsWith` on a query-bearing href.
- [ ] Run the shell/nav tests red, implement grouping, preserve focus trap/Escape/focus return/skip-link and locale switching, then run them green.
- [ ] Commit `feat: organize operator workflow navigation`.

## Task 7: Verify the complete first slice and prepare review

**Files:** Create `tests/e2e/workbench.spec.ts` and `docs/superpowers/plans/2026-09-06-operations-workbench-results.md`; update `CONTEXT.md` only with implemented behavior and actual verification status.

- [ ] Use the existing real-stack fixture on isolated services with fake AI/mock SHOPLINE. Seed synthetic imports/listings/exports only in the test database. Make the first acceptance fail against the old dashboard before running against the completed slice.
- [ ] Exercise the journey: successful workbook import -> Completed item -> exact catalog source; reviewer attention -> exact listing; older ready export -> exact receipt screen; partial scan -> clearly labelled partial preview. Verify no UI action claims acceptance or enables workbook/website publish.
- [ ] Add 390px mobile and 1440px desktop browser checks, keyboard-only navigation, Chinese/English locale, counts beyond 25 records, filter/Back restoration, unavailable API and superseded responses. The browser tests must assert user-visible behavior, not class-name snapshots.

```ts
await page.goto('/dashboard?state=attention');
await expect(page.getByRole('heading', {name: '工作台', exact: true})).toBeVisible();
await page.getByRole('button', {name: /已完成/}).click();
await expect(page).toHaveURL(/state=completed/);
await page.goBack();
await expect(page).toHaveURL(/state=attention/);
```

- [ ] Run `corepack.cmd pnpm@11.7.0 exec playwright test tests/e2e/workbench.spec.ts` with `PLAYWRIGHT_E2E=1` and the established synthetic environment. Review screenshots for both widths. No production authentication bypass or real-file upload.
- [ ] Run root `test`, `test:integration`, `typecheck`, `lint`, `build`, `format:runtime:check` and `runtime:forbidden:check` through `corepack.cmd pnpm@11.7.0`. Ensure the local pnpm shim is on PATH for nested commands; use synthetic build environment. These are separate commands and results, not one success inferred from another.
- [ ] Request focused code review after all source changes; verify feedback against the checkout. Record exact counts, skips, command exits, screenshots, dataset scale and unresolved limitations in the results file. Stop only owned synthetic services and verify their ports are closed.
- [ ] Commit the verification report with explicit paths. Hand off a clean reviewable branch; do not push/merge/deploy without the user's release choice.

## Self-review and execution gates

Spec coverage: state populations/counts/snapshot -> Tasks 1–2; capabilities/read contract -> Task 3; exact context and safe return -> Task 4; layout/loading/locale/mobile -> Task 5; retained routes and access -> Task 6; regression/browser/runtime evidence -> Task 7.

Source limitations are explicit: stateless XLSX preview failures are not durable tasks; workbook quality cohorts are excluded; imports navigation is the existing flow; partial website results retain their meaning; legacy export state is unknown. No database field or migration is silently invented.

Execution is sequential through Tasks 1–4, then Tasks 5–6, followed by Task 7. A failure in classification/count parity or source authorization is a correctness blocker; do not hide it with UI fallback data. This document is a plan, not evidence that any implementation or check has run.
### Concrete return-path helper for Task 4

Export this function from `apps/web/lib/workbench-navigation.ts`. It avoids a free-form return URL and only retains the approved dashboard filters.

```ts
export function normalizeWorkbenchReturn(input: string | null): string {
  if (!input || !input.startsWith('/dashboard') || input.startsWith('//')) return '/dashboard';
  const url = new URL(input, 'http://workbench.invalid');
  if (url.origin !== 'http://workbench.invalid' || url.pathname !== '/dashboard') return '/dashboard';
  const out = new URLSearchParams();
  const state = url.searchParams.get('state');
  const kind = url.searchParams.get('kind');
  const page = url.searchParams.get('page');
  if (state && ['attention','progress','completed','unclassified'].includes(state)) out.set('state', state);
  if (kind && ['listing','export','website_scan','workbook_import'].includes(kind)) out.set('kind', kind);
  if (page && /^[1-9][0-9]*$/.test(page) && Number(page) <= 21474836) out.set('page', page);
  const query = out.toString();
  return query ? `/dashboard?${query}` : '/dashboard';
}
```

Add the return-link component to the existing listing detail and import page shells only when a valid return context is present. Preserve their current layouts and form state. The workbench page h1 is `工作台` / `Workbench`; the mockup's greeting becomes supporting copy so accessible page identification stays stable.