# Package D — Dashboard, Catalog, Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/catalog` gets real server-side pagination and search across the whole workspace (not just the first 100 rows); `/dashboard` gets workspace-accurate status counts and a small queue teaser; a new `/queue` route is built by extracting the already-working `ListingQueue` component out of `/dashboard`.

**Architecture:** Two new repository methods (`countByStatus`, `getByIds`) close two real correctness gaps: dashboard counts and `/queue` lane counts currently silently under-report past 100 rows, and catalog titles/flag-counts silently degrade for any product whose linked listing isn't among the 100 globally-most-recently-updated listings (a latent bug independent of pagination, found while reading the real route code). `/api/catalog` gains `page`/`pageSize`/`q`/`filter` query params, computing the full derived `CatalogItem[]` server-side (reusing the existing fetch-then-derive shape, just fetching by the right IDs instead of an unrelated global "most recent" cap) before paginating in the route handler — matching this codebase's established fetch-then-filter-in-JS convention at pilot scale, just moved from the client to the server so it considers the whole dataset.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle ORM, Vitest, plain CSS.

---

## Environment note for every `Run:` step

`pnpm` is not reliably on PATH in this environment. Prefix every command with `corepack`:

```powershell
corepack pnpm --filter @wukong/web test -- <file>
corepack pnpm --filter @wukong/db test -- <file>
```

If `corepack pnpm typecheck`/`test` (turbo-orchestrated) hits `Unable to find package manager binary`, run `corepack enable --install-directory <a scratch dir>` and prepend that directory to PATH for the rest of that session's commands.

---

## Baseline facts confirmed during planning (read this before Task 1)

- **`listing-queue.tsx` is already wired**, not unused — confirmed by reading `dashboard-listings-client.tsx`, which renders `<ListingQueue items={queueItems} selected={selected} eligibleIds={eligibleIds} onToggle={toggleSelected} onSelectAllEligible={...} />` today. Extraction, not a rebuild.
- **`packages/db/src/repositories/listings.ts`'s real `listRecent`** (confirmed by direct read): `listRecent(limit = 100)` **throws** if `limit > 100` — it has a hard ceiling, unlike `platform-products.ts`'s `listRecent` (ceiling 5000). This repository has no existing bulk-by-ids or count-by-status method.
- **The real, previously-unknown bug in `GET /api/catalog`** (`apps/web/app/api/catalog/route.ts`, confirmed by direct read):

```ts
const products = await repositories.platformProducts.listRecent(100);
const listingIds = [
  ...new Set(
    products.map((p) => p.listingId).filter((id): id is string => id !== null),
  ),
];
const statuses = await repositories.listings.statusesByIds(listingIds);
const recentListings = await repositories.listings.listRecent(100);
const recentListingById = new Map(
  recentListings.map((listing) => [listing.id, listing]),
);
```

`recentListings` is fetched via `listRecent(100)` — the 100 _globally most-recently-updated listings_, unrelated to `listingIds` (the specific listings this page's products actually link to). Any product whose linked listing isn't among those 100 gets `recentListingById.get(product.listingId) === undefined`, and its `title`/`openBlockingFlagCount` silently fall back to less-accurate values (`product.sku ?? product.remoteProductId` instead of the real listing title; `null` flag count). This bug is independent of pagination and is fixed here by replacing that lookup with a proper bulk-by-ids fetch (Task 2).

- **`catalog-control-center.tsx`'s existing search/filter is 100% client-side JS**, operating only on whatever the capped fetch returned (confirmed: `filterCatalogItems(response.items, query, filter)` in `catalog-view-models.ts`, called from a `useMemo` in the component — no query params sent to the server at all). The status `filter` values (`attention`/`review`/`unlinked`/`published`) and the search `query` (matched against `title`/`sku`/`remoteProductId`/`specVersion`) both need to move server-side.
- **The component already has a stale, self-aware placeholder note** (`catalog-control-center.tsx`, confirmed by direct read): `此控制中心顯示最近 100 個平台商品。下一階段會加入分頁、平台差異偵測、批量修正及庫存／價格同步。` ("This control center shows the most recent 100 platform products. The next phase will add pagination..."). This note gets removed once pagination lands (Task 4) — it was already anticipating this exact work.
- **`apps/web/app/(app)/dashboard/page.tsx`'s real current content** (confirmed by direct read):

```tsx
import Link from "next/link";

import { DashboardListingsClient } from "../../../components/dashboard-listings-client";

export default function DashboardPage() {
  return (
    <div className="page-wrap">
      <div className="page-header dashboard-header">
        <div>
          <p className="eyebrow">
            Opak Cellar <span>OPAK PILOT WORKSPACE</span>
          </p>
          <h1>早上好，今天先處理最接近上架的酒款。</h1>
          <p className="lede">AI 只提出有來源的建議；你保留最後的審核權。</p>
        </div>
        <Link className="primary-button" href="/listings/new">
          建立上架草稿 <span>Create draft</span>
        </Link>
      </div>
      <DashboardListingsClient />
    </div>
  );
}
```

- **`apps/web/app/api/listings/route.ts`'s real `createListListingsHandler`** (confirmed by direct read): fetches `repositories.listings.listRecent(100)`, maps each item to `{id, status, target, title, sku, updatedAt, openBlockingFlagCount}`, returns `jsonResponse(200, { items })`. `GET`/`POST` are both exported and bound at the bottom of the file (`sessionContext: authSessionContext, getDatabase`). This is the endpoint both `/dashboard` and the new `/queue` route will use.
- **`apps/web/app/(app)/shell-nav-items.ts`'s real current content** (from Package B, already committed on this branch's own base):

```ts
import type { NavItem } from "../../components/app-shell-nav";
import type { WorkspaceRole } from "../../lib/session-context";

export const SHELL_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "總覽", labelEn: "Overview" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/listings/new", labelZh: "建立草稿", labelEn: "New listing" },
  {
    href: "/listings/import",
    labelZh: "SHOPLINE 匯入",
    labelEn: "Bulk import",
  },
  { href: "/batches", labelZh: "批次", labelEn: "Batches" },
];

export const ROLE_LABELS: Record<WorkspaceRole, { zh: string; en: string }> = {
  viewer: { zh: "檢視者", en: "Viewer" },
  operator: { zh: "操作員", en: "Operator" },
  reviewer: { zh: "審閱者", en: "Reviewer" },
  admin: { zh: "管理員", en: "Admin" },
  owner: { zh: "擁有者", en: "Owner" },
};
```

- **`apps/web/components/listing-queue.tsx`'s real, full, already-working implementation** (confirmed by direct read — this component is NOT modified by this plan, only re-hosted under `/queue`):

```tsx
import Link from "next/link";

import { queueGroups, type QueueItem } from "./listing-view-models";

type ListingQueueProps = {
  items: QueueItem[];
  selected: Set<string>;
  eligibleIds: string[];
  onToggle: (id: string) => void;
  onSelectAllEligible: () => void;
};

export function ListingQueue({
  items,
  selected,
  eligibleIds,
  onToggle,
  onSelectAllEligible,
}: ListingQueueProps) {
  const eligibleSet = new Set(eligibleIds);
  return (
    <section className="queue" aria-labelledby="queue-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            工作佇列 <span>WORK QUEUE</span>
          </p>
          <h2 id="queue-heading">下一步工作</h2>
        </div>
        <Link className="text-link" href="/listings/new">
          建立上架草稿<span aria-hidden="true"> →</span>
        </Link>
      </div>
      <div className="queue-groups">
        {queueGroups.map((group) => {
          const groupItems = items.filter(
            (item) => item.status === group.status,
          );
          const groupEligibleCount = groupItems.filter((item) =>
            eligibleSet.has(item.id),
          ).length;
          return (
            <section
              className="queue-group"
              key={group.status}
              aria-labelledby={`queue-${group.status}`}
            >
              <div className="queue-group-heading">
                <div>
                  <h3 id={`queue-${group.status}`}>{group.label}</h3>
                  <p>{group.englishLabel}</p>
                </div>
                {group.status === "in_review" && groupEligibleCount > 0 ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onSelectAllEligible}
                  >
                    全選可批准項目 Select all eligible
                  </button>
                ) : null}
                <span
                  className="count-badge"
                  aria-label={`${groupItems.length} items`}
                >
                  {groupItems.length}
                </span>
              </div>
              {groupItems.length > 0 ? (
                <ul className="queue-list">
                  {groupItems.map((item) => {
                    const eligible = eligibleSet.has(item.id);
                    return (
                      <li key={item.id} className="queue-item">
                        {item.status === "in_review" ? (
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            disabled={!eligible}
                            aria-label={
                              eligible
                                ? `選取 ${item.title}`
                                : `${item.openBlockingFlagCount} 個未解決的合規標記`
                            }
                            title={
                              eligible
                                ? undefined
                                : `${item.openBlockingFlagCount} 個未解決的合規標記 · ${item.openBlockingFlagCount} unresolved compliance flags`
                            }
                            onChange={() => onToggle(item.id)}
                          />
                        ) : null}
                        <div>
                          <Link
                            className="queue-item-title"
                            href={`/listings/${item.id}`}
                          >
                            {item.title}
                          </Link>
                          <p>{item.subtitle}</p>
                          <time dateTime={item.updatedAt}>
                            {item.updatedAt}
                          </time>
                        </div>
                        <Link
                          className="secondary-button queue-action"
                          href={`/listings/${item.id}`}
                        >
                          {item.nextAction}
                          <span aria-hidden="true"> →</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty-state">
                  目前沒有項目 <span>No items</span>
                </p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
```

- **Real `ListingStatus` union** (`packages/core/src/workflow.ts`): `"received" | "processing" | "needs_info" | "in_review" | "approved" | "reopened" | "publishing" | "published" | "publish_failed" | "failed"` — 10 values. `countByStatus` (Task 1) must return a count for every one of these.
- **`WorkspaceProfile.name`**: already used by Package B's `apps/web/app/(app)/workspace-chrome.ts` (`resolveWorkspaceChrome`) to derive the shell's workspace name — this exact same function can be reused by `dashboard/page.tsx` (Task 6) rather than duplicating the profile-fetch/fallback logic.

---

### Task 1: `countByStatus` on the listings repository

**Files:**

- Modify: `packages/db/src/repositories/listings.ts`
- Modify: `packages/db/src/repositories/listings.integration.test.ts`

- [ ] **Step 1: Read the existing `ListingRepository` type and its real implementation in full**

Read `packages/db/src/repositories/listings.ts` in full before editing — confirm the exact imports available (e.g. `sql`, `eq`, `and`, `inArray` from `drizzle-orm`), the exact `listingDrafts`/`listingVersions`/`complianceFlags` schema references, and `listRecent`'s real final row-mapping block, since this plan's own sketches must match the real file's current shape exactly, not a paraphrase from earlier research.

- [ ] **Step 2: Write the failing integration test**

Read `packages/db/src/repositories/listings.integration.test.ts` in full first to match its existing fixture/workspace-setup conventions exactly (how it inserts a workspace row, how it calls `database.forWorkspace`). Then add:

```ts
it("counts listings by status across the whole workspace, not just a capped fetch", async () => {
  const countWorkspaceId = "ws_listings_count";
  await admin.unsafe(
    `INSERT INTO workspaces (id, name, profile) VALUES ('${countWorkspaceId}', '${countWorkspaceId}', '{}'::jsonb)`,
  );

  await database.forWorkspace(countWorkspaceId, async (repositories) => {
    for (let index = 0; index < 3; index += 1) {
      await repositories.listings.create({ target: "shopline" });
    }
  });

  const counts = await database.forWorkspace(countWorkspaceId, (repositories) =>
    repositories.listings.countByStatus(),
  );

  expect(counts.received).toBe(3);
  expect(counts.processing).toBe(0);
  expect(counts.needs_info).toBe(0);
  expect(counts.in_review).toBe(0);
  expect(counts.approved).toBe(0);
  expect(counts.reopened).toBe(0);
  expect(counts.publishing).toBe(0);
  expect(counts.published).toBe(0);
  expect(counts.publish_failed).toBe(0);
  expect(counts.failed).toBe(0);
});

it("isolates counts per workspace", async () => {
  const workspaceA = "ws_listings_count_a";
  const workspaceB = "ws_listings_count_b";
  await admin.unsafe(`
    INSERT INTO workspaces (id, name, profile) VALUES
      ('${workspaceA}', '${workspaceA}', '{}'::jsonb),
      ('${workspaceB}', '${workspaceB}', '{}'::jsonb);
  `);

  await database.forWorkspace(workspaceA, (repositories) =>
    repositories.listings.create({ target: "shopline" }),
  );

  const countsB = await database.forWorkspace(workspaceB, (repositories) =>
    repositories.listings.countByStatus(),
  );
  expect(countsB.received).toBe(0);
});
```

Adjust the exact `admin.unsafe`/`database.forWorkspace` calling convention to match whatever the real file's other tests actually use.

- [ ] **Step 3: Run it, confirm it fails**

Requires live Postgres (`docker compose up -d postgres` first; if Docker is unreachable in this environment, state that explicitly and treat this step as BLOCKED rather than skipping it silently). Run:

```powershell
corepack pnpm --filter @wukong/db exec vitest run listings.integration.test.ts
```

Expected: FAIL — `countByStatus is not a function`.

- [ ] **Step 4: Add `countByStatus` to the `ListingRepository` type and implementation**

In `packages/db/src/repositories/listings.ts`, add to the `ListingRepository` type (alongside `statusesByIds`/`listRecent`):

```ts
countByStatus(): Promise<Record<ListingStatus, number>>;
```

Add the implementation (alongside `statusesByIds`/`listRecent` in the returned object), reusing the `sql`/`eq` imports already present in the file:

```ts
async countByStatus() {
  scope.assertOpen();
  const rows = await transaction
    .select({
      status: listingDrafts.status,
      count: sql<number>`count(*)::int`,
    })
    .from(listingDrafts)
    .where(eq(listingDrafts.workspaceId, workspaceId))
    .groupBy(listingDrafts.status);

  const counts: Record<ListingStatus, number> = {
    received: 0,
    processing: 0,
    needs_info: 0,
    in_review: 0,
    approved: 0,
    reopened: 0,
    publishing: 0,
    published: 0,
    publish_failed: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts[row.status as ListingStatus] = row.count;
  }
  return counts;
},
```

- [ ] **Step 5: Run the tests, confirm they pass**

Run:

```powershell
corepack pnpm --filter @wukong/db exec vitest run listings.integration.test.ts
```

Expected: PASS, including the 2 new tests.

- [ ] **Step 6: Typecheck and format**

Run:

```powershell
corepack pnpm --filter @wukong/db exec tsc --noEmit
corepack pnpm exec prettier --check packages/db/src/repositories/listings.ts packages/db/src/repositories/listings.integration.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/listings.ts packages/db/src/repositories/listings.integration.test.ts
git commit -m "$(cat <<'EOF'
feat: add countByStatus to the listings repository

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `getByIds` on the listings repository

**Files:**

- Modify: `packages/db/src/repositories/listings.ts`
- Modify: `packages/db/src/repositories/listings.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add to `packages/db/src/repositories/listings.integration.test.ts`:

```ts
it("fetches exactly the listings requested by id, regardless of update recency", async () => {
  const getByIdsWorkspaceId = "ws_listings_getbyids";
  await admin.unsafe(
    `INSERT INTO workspaces (id, name, profile) VALUES ('${getByIdsWorkspaceId}', '${getByIdsWorkspaceId}', '{}'::jsonb)`,
  );

  const { targetId, otherIds } = await database.forWorkspace(
    getByIdsWorkspaceId,
    async (repositories) => {
      const target = await repositories.listings.create({ target: "shopline" });
      // 100 more-recently-touched listings, so `target` would fall outside
      // any listRecent(100)-style "most recent" window -- proving getByIds
      // fetches by id, not by recency.
      const others: string[] = [];
      for (let index = 0; index < 100; index += 1) {
        const created = await repositories.listings.create({
          target: "shopline",
        });
        others.push(created.id);
      }
      return { targetId: target.id, otherIds: others };
    },
  );

  const fetched = await database.forWorkspace(
    getByIdsWorkspaceId,
    (repositories) => repositories.listings.getByIds([targetId]),
  );

  expect(fetched.map((listing) => listing.id)).toEqual([targetId]);
  expect(otherIds).toHaveLength(100);
});

it("returns an empty array for an empty id list without querying", async () => {
  const emptyWorkspaceId = "ws_listings_getbyids_empty";
  await admin.unsafe(
    `INSERT INTO workspaces (id, name, profile) VALUES ('${emptyWorkspaceId}', '${emptyWorkspaceId}', '{}'::jsonb)`,
  );
  const fetched = await database.forWorkspace(
    emptyWorkspaceId,
    (repositories) => repositories.listings.getByIds([]),
  );
  expect(fetched).toEqual([]);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run:

```powershell
corepack pnpm --filter @wukong/db exec vitest run listings.integration.test.ts
```

Expected: FAIL — `getByIds is not a function`.

- [ ] **Step 3: Add `getByIds` to the `ListingRepository` type and implementation**

Add to the type:

```ts
getByIds(ids: readonly string[]): Promise<ListingSummary[]>;
```

**Copy `listRecent`'s real final query-and-mapping block from the file you read in Task 1 Step 1** (the `canonicalListingSchema.safeParse`/flag-count-join/`rows.map(...)` shape) and adapt only the `where`/`orderBy`/`limit` clauses — do not reimplement the mapping logic from memory. The shape to adapt it to:

```ts
async getByIds(ids) {
  scope.assertOpen();
  if (ids.length === 0) return [];

  // Same base select as listRecent, but filtered by the given ids instead
  // of ordered-and-limited by recency -- no orderBy, no limit.
  const rows = await transaction
    .select({ /* identical to listRecent's select */ })
    .from(listingDrafts)
    .leftJoin(listingVersions, /* identical join condition to listRecent */)
    .where(
      and(
        eq(listingDrafts.workspaceId, workspaceId),
        inArray(listingDrafts.id, [...ids]),
      ),
    );

  // From here on, reuse listRecent's exact flag-count-fetch and
  // rows.map(...) mapping logic verbatim -- same shape, same fields.
},
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run:

```powershell
corepack pnpm --filter @wukong/db exec vitest run listings.integration.test.ts
```

Expected: PASS, including the 2 new tests (4 total new tests from Tasks 1-2).

- [ ] **Step 5: Typecheck and format**

Run:

```powershell
corepack pnpm --filter @wukong/db exec tsc --noEmit
corepack pnpm exec prettier --check packages/db/src/repositories/listings.ts packages/db/src/repositories/listings.integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/listings.ts packages/db/src/repositories/listings.integration.test.ts
git commit -m "$(cat <<'EOF'
feat: add getByIds to the listings repository, fixing catalog's recency-capped listing lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `GET /api/catalog` — real pagination and search

**Files:**

- Modify: `apps/web/lib/catalog-contract.ts`
- Modify: `apps/web/app/api/catalog/route.ts`
- Modify: `apps/web/app/api/catalog/route.test.ts`

- [ ] **Step 1: Read the current route and its test file in full**

Re-read `apps/web/app/api/catalog/route.ts` (shown above in "Baseline facts" — reconfirm nothing changed since) and read `apps/web/app/api/catalog/route.test.ts` in full to match its existing fake-`db`/fake-`repositories` mocking conventions exactly before extending it.

- [ ] **Step 2: Extend `catalog-contract.ts` (ADR-7 fields)**

In `apps/web/lib/catalog-contract.ts`, add three fields to `CatalogItem`:

```ts
export type CatalogItem = {
  id: string;
  remoteProductId: string;
  origin: CatalogOrigin;
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  title: string;
  listingStatus: ListingStatus | null;
  openBlockingFlagCount: number | null;
  needsReview: boolean;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  contentDigest: string | null;
};
```

Add a `CatalogPage` type for the paginated response shape:

```ts
export type CatalogPage = {
  items: CatalogItem[];
  summary: CatalogSummary;
  page: number;
  pageSize: number;
  totalMatching: number;
};
```

Before deciding whether to keep the existing `CatalogResponse` type alongside `CatalogPage` or fold it into one type, run `grep -rn "CatalogResponse" apps/web` — if `catalog-control-center.tsx` is its only consumer, replace it with `CatalogPage` everywhere rather than keeping two overlapping types.

- [ ] **Step 3: Write the failing route tests**

Extend `apps/web/app/api/catalog/route.test.ts`, matching its existing mocking conventions exactly (read them in Step 1 — this plan does not repeat that boilerplate since it depends on the file's real, current fake-database helper). Cover:

- No query params returns page 1 at a sensible default page size (25).
- `page=2` returns different items than `page=1` for a fixture with more rows than one page.
- A `q` search term matches an item that would fall outside page 1's default window.
- A `filter` value (e.g. `attention`) only returns matching items.
- `createdAt`/`updatedAt`/`contentDigest` are present on every returned item.
- A product whose linked listing is NOT among any "most recent" set still gets its real title (regression test for the bug this task fixes) — construct a fixture where the fake `listings.getByIds` returns a listing that a naive `listRecent(100)`-based implementation would have missed.

- [ ] **Step 4: Run the tests, confirm they fail**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run "app/api/catalog/route.test.ts"
```

Expected: FAIL — new fields/params not yet implemented.

- [ ] **Step 5: Add `filterCatalogItemsServer` to `catalog-contract.ts`**

Add this function (moving `catalog-view-models.ts`'s existing client-side `filterCatalogItems` predicate logic server-side unchanged — only WHERE it runs changes, not the matching rules):

```ts
export function filterCatalogItemsServer(
  items: readonly CatalogItem[],
  query: string | undefined,
  filter: "all" | "attention" | "review" | "unlinked" | "published",
): CatalogItem[] {
  const normalizedQuery = (query ?? "").trim().toLocaleLowerCase();

  return items.filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "attention" && item.needsAttention) ||
      (filter === "review" && item.needsReview) ||
      (filter === "unlinked" && item.listingId === null) ||
      (filter === "published" && item.listingStatus === "published");
    if (!matchesFilter) return false;
    if (!normalizedQuery) return true;

    return [item.title, item.sku, item.remoteProductId, item.specVersion]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}
```

Before writing this, read `apps/web/components/catalog-view-models.ts`'s real `filterCatalogItems` function and match its matching rules exactly (this plan's version above is a best-effort reconstruction from research, not a verbatim transcript).

- [ ] **Step 6: Rewrite the route handler**

Replace `createCatalogHandler`'s body in `apps/web/app/api/catalog/route.ts`:

```ts
import { z } from "zod";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().optional(),
  filter: z
    .enum(["all", "attention", "review", "unlinked", "published"])
    .default("all"),
});

export function createCatalogHandler(deps: CatalogRouteDeps) {
  return async function catalog(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const url = new URL(request.url);
      const query = querySchema.parse(Object.fromEntries(url.searchParams));

      const allItems = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const products = await repositories.platformProducts.listRecent(5000);
          const listingIds = [
            ...new Set(
              products
                .map((product) => product.listingId)
                .filter((id): id is string => id !== null),
            ),
          ];
          const statuses =
            await repositories.listings.statusesByIds(listingIds);
          const linkedListings =
            await repositories.listings.getByIds(listingIds);
          const linkedListingById = new Map(
            linkedListings.map((listing) => [listing.id, listing]),
          );

          return products.map((product): CatalogItem => {
            const recentListing = product.listingId
              ? linkedListingById.get(product.listingId)
              : undefined;
            const listingStatus = product.listingId
              ? (statuses[product.listingId] ?? null)
              : null;
            const openBlockingFlagCount =
              recentListing?.openBlockingFlagCount ?? null;
            const title =
              recentListing?.activeVersion?.content.title["zh-Hant"] ??
              recentListing?.activeVersion?.content.title.en ??
              product.sku ??
              product.remoteProductId;
            const needsReview =
              listingStatus !== null && REVIEW_STATUSES.has(listingStatus);
            const needsAttention =
              product.listingId === null ||
              listingStatus === null ||
              ATTENTION_STATUSES.has(listingStatus) ||
              (openBlockingFlagCount ?? 0) > 0;

            return {
              id: product.id,
              remoteProductId: product.remoteProductId,
              origin: product.origin,
              sku: product.sku,
              listingId: product.listingId,
              specVersion: product.specVersion,
              title,
              listingStatus,
              openBlockingFlagCount,
              needsReview,
              needsAttention,
              createdAt: product.createdAt.toISOString(),
              updatedAt: product.updatedAt.toISOString(),
              contentDigest: product.contentDigest,
            };
          });
        });

      const filtered = filterCatalogItemsServer(
        allItems,
        query.q,
        query.filter,
      );
      const start = (query.page - 1) * query.pageSize;
      const pageItems = filtered.slice(start, start + query.pageSize);

      return jsonResponse(200, {
        items: pageItems,
        summary: summarizeCatalog(allItems),
        page: query.page,
        pageSize: query.pageSize,
        totalMatching: filtered.length,
      });
    });
  };
}
```

Before trusting this verbatim: (1) confirm `product.createdAt`/`product.updatedAt` are real fields returned by `platformProducts.listRecent` by reading `packages/db/src/repositories/platform-products.ts`'s `COLUMNS`/row-mapping — `contentDigest` was already confirmed present during design research, `createdAt`/`updatedAt` were not explicitly re-checked; (2) `linkedListings`/`getByIds` depends on Task 2's method — confirm its real signature (`Promise<ListingSummary[]>`, keyed by `.id`) matches before wiring this route to it.

- [ ] **Step 7: Run the tests, iterate until they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run "app/api/catalog/route.test.ts"
```

Expected: PASS, all tests including the new ones.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/catalog-contract.ts "apps/web/app/api/catalog/route.ts" "apps/web/app/api/catalog/route.test.ts"
git commit -m "$(cat <<'EOF'
feat: add real pagination and workspace-wide search to GET /api/catalog

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `catalog-control-center.tsx` — wire to server-side pagination/search

**Files:**

- Modify: `apps/web/components/catalog-control-center.tsx`
- Modify: `apps/web/components/catalog-view-models.ts`
- Modify or create: `apps/web/components/catalog-control-center.test.tsx` (or `.test.ts` — check which, if either, already exists)

- [ ] **Step 1: Search for an existing test file and read the component + its module CSS in full**

Run:

```powershell
corepack pnpm exec node -e "console.log(require('fs').existsSync('apps/web/components/catalog-control-center.test.tsx'), require('fs').existsSync('apps/web/components/catalog-control-center.test.ts'))"
```

If a test file already exists, read it in full and extend it rather than creating a new one. Also read `apps/web/components/catalog-control-center.tsx` and `apps/web/components/catalog-control-center.module.css` in full to confirm the file's existing class-naming convention (e.g. `styles.filterButton`) before adding new pagination-control markup/CSS that matches it.

- [ ] **Step 2: Write/extend the failing test**

Cover: the component's `fetch` call includes `page`/`pageSize`/`q`/`filter` as query params (not just a bare `/api/catalog` call); typing in the search box triggers a re-fetch with the new `q` param; clicking a filter button triggers a re-fetch with the new `filter` param instead of re-filtering client-side; a "next page" control triggers a re-fetch with `page` incremented; changing the query or filter resets `page` to `1`. Use this repo's established DOM-testing pattern (`// @vitest-environment happy-dom`, `globalThis.IS_REACT_ACT_ENVIRONMENT = true`, `createRoot`/`act`) and mock `fetch` matching whatever convention the file identified in Step 1 already uses (or, if none exists, the convention used by another client-component test in this codebase, e.g. `dashboard-listings-client.test.ts` if it exists).

- [ ] **Step 3: Run it, confirm it fails**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run components/catalog-control-center.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Rewrite `catalog-control-center.tsx`**

Read the current full file (from Step 1) side-by-side while making this targeted rewrite — not every line changes. Key changes:

- State: add `page` (default `1`); keep `query`/`filter` as-is, but they now drive the fetch URL, not client-side filtering.
- The `fetch` effect depends on `[page, query, filter]` and builds the URL: `` `/api/catalog?page=${page}&pageSize=25&q=${encodeURIComponent(query)}&filter=${filter}` ``.
- Remove the `useMemo`-based `filterCatalogItems(...)` call entirely — `response.items` IS the already-filtered, already-paginated page; render it directly.
- Add pagination controls (prev/next buttons) below the table, using new `styles.paginationControls`/`styles.pageButton` classes in `catalog-control-center.module.css`, mirroring the file's existing `.filterButton`/`.filterButtonActive` styling pattern. Derive "has next page" from `totalMatching > page * pageSize`; disable "prev" when `page === 1`.
- `filter`/`query` `onChange` handlers also reset `page` to `1`.
- Update the result-count line to reflect the paginated response, e.g. `顯示第 {page} 頁 · 符合 {response.totalMatching} / {response.summary.total} 個商品`.
- **Remove** the stale placeholder note (`此控制中心顯示最近 100 個平台商品。下一階段會加入分頁...`) — this task IS that next phase.

- [ ] **Step 5: Update `catalog-view-models.ts`**

`filterCatalogItems` (the client-side version) is no longer called by `catalog-control-center.tsx` after Step 4. Run `grep -rn "filterCatalogItems\b" apps/web` — if genuinely unused elsewhere, delete it rather than leaving a dead export; if another consumer still needs it, leave it as-is.

- [ ] **Step 6: Run the tests, iterate until they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run components/catalog-control-center.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Typecheck and format**

Run:

```powershell
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check apps/web/components/catalog-control-center.tsx apps/web/components/catalog-view-models.ts apps/web/components/catalog-control-center.module.css
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/catalog-control-center.tsx apps/web/components/catalog-view-models.ts apps/web/components/catalog-control-center.module.css apps/web/components/catalog-control-center.test.tsx
git commit -m "$(cat <<'EOF'
feat: wire the catalog control center to server-side pagination and search

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `/queue` — extract `ListingQueue` into its own route

**Files:**

- Create: `apps/web/app/(app)/queue/page.tsx`
- Create: `apps/web/components/queue-client.tsx`
- Create: `apps/web/components/queue-client.test.tsx`
- Modify: `apps/web/app/(app)/shell-nav-items.ts`
- Modify: `apps/web/app/(app)/layout.test.tsx`
- Possibly create: `apps/web/lib/dashboard-queue-shared.ts` (see Step 4)

- [ ] **Step 1: Read `apps/web/components/dashboard-listings-client.tsx` in full**

Identify exactly what to extract: the `load`/`toggleSelected`/`selectAllEligible`/`clearSelection`/`runBulkApprove` logic, the `<ListingQueue>` render, and the `eligibleIds`/`queueItems` derivations — everything except the `metric-strip` summary tiles and the page header (those stay on `/dashboard`, shrunk in Task 6). Also note the exact exported helpers (`ListingCollectionItem`, `mapDashboardItems`, `queueStatus`, etc.) and their real signatures.

- [ ] **Step 2: Write the failing test for the new `QueueClient` component**

Create `apps/web/components/queue-client.test.tsx`. First check whether `apps/web/components/dashboard-listings-client.test.ts(x)` exists and read it to mirror its exact fetch-mocking/DOM-testing conventions. Cover: renders `ListingQueue` with fetched items; bulk-approve flow works (select eligible items, approve, list reloads); error state; loading state.

- [ ] **Step 3: Run it, confirm it fails**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run components/queue-client.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Create `apps/web/components/queue-client.tsx`**

Move the full data-fetching + bulk-approve + `ListingQueue` render out of `dashboard-listings-client.tsx` into this new component, fetching `/api/listings` (same endpoint dashboard already uses, confirmed in "Baseline facts" — no new API route needed for this task). Run `grep -rn "mapDashboardItems\|ListingCollectionItem\|queueStatus\b" apps/web` first: if these are only used by `dashboard-listings-client.tsx` today and will now be needed by BOTH `dashboard-listings-client.tsx` and `queue-client.tsx`, extract them into a new `apps/web/lib/dashboard-queue-shared.ts` module that both import from, rather than having `queue-client.tsx` reach into `dashboard-listings-client.tsx`'s internals. This component renders `<ListingQueue>` with NO summary metric-strip (that's dashboard's job, kept in Task 6).

- [ ] **Step 5: Create `apps/web/app/(app)/queue/page.tsx`**

```tsx
import { QueueClient } from "../../../components/queue-client";

export default function QueuePage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            工作佇列 <span>WORK QUEUE</span>
          </p>
          <h1>依狀態排序的完整工作佇列</h1>
          <p className="lede">
            檢視所有進行中商品，並批量批准已符合條件的項目。
          </p>
        </div>
      </div>
      <QueueClient />
    </div>
  );
}
```

- [ ] **Step 6: Add `/queue` to `SHELL_NAV_ITEMS`**

In `apps/web/app/(app)/shell-nav-items.ts`, insert the Work Queue item between Catalog and New Listing (matching Package B's design doc's confirmed nav order — "Overview, Catalog, Work Queue, New Listing, Bulk Import, Batches"):

```ts
export const SHELL_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "總覽", labelEn: "Overview" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/queue", labelZh: "工作佇列", labelEn: "Work Queue" },
  { href: "/listings/new", labelZh: "建立草稿", labelEn: "New listing" },
  {
    href: "/listings/import",
    labelZh: "SHOPLINE 匯入",
    labelEn: "Bulk import",
  },
  { href: "/batches", labelZh: "批次", labelEn: "Batches" },
];
```

- [ ] **Step 7: Update `apps/web/app/(app)/layout.test.tsx`**

Read this file in full first. It has a test asserting `SHELL_NAV_ITEMS.map((item) => item.href)` equals a specific 5-item array (from Package B, before `/queue` existed), and likely a separate test asserting `/queue` is absent (Package B deliberately omitted it). Update the first test's expected array to include `"/queue"` at the correct position (index 2). Remove or repurpose the absence test — replace it with an assertion of the full, exact 6-item order (position matters, not just presence).

- [ ] **Step 8: Run the tests, iterate until they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run components/queue-client.test.tsx "apps/web/app/(app)/layout.test.tsx"
```

Expected: PASS.

- [ ] **Step 9: Typecheck and format**

Run:

```powershell
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check "apps/web/app/(app)/queue/page.tsx" apps/web/components/queue-client.tsx apps/web/components/queue-client.test.tsx "apps/web/app/(app)/shell-nav-items.ts" "apps/web/app/(app)/layout.test.tsx"
```

- [ ] **Step 10: Commit**

```bash
git add "apps/web/app/(app)/queue" apps/web/components/queue-client.tsx apps/web/components/queue-client.test.tsx "apps/web/app/(app)/shell-nav-items.ts" "apps/web/app/(app)/layout.test.tsx" apps/web/lib/dashboard-queue-shared.ts
git commit -m "$(cat <<'EOF'
feat: extract ListingQueue into its own /queue route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

(Omit `dashboard-queue-shared.ts` from the `add` if Step 4 didn't create it.)

---

### Task 6: Dashboard — accurate counts, queue teaser, workspace-derived name

**Files:**

- Modify: `apps/web/app/(app)/dashboard/page.tsx`
- Modify: `apps/web/components/dashboard-listings-client.tsx`
- Modify: `apps/web/app/api/listings/route.ts`
- Modify: `apps/web/app/api/listings/route.test.ts`
- Modify: `apps/web/components/dashboard-listings-client.test.ts` (or `.test.tsx` — check which extension the existing file uses)

- [ ] **Step 1: Read the existing `dashboard-listings-client` and `listings/route` test files in full**

Understand current coverage before changing the components/route underneath them.

- [ ] **Step 2: Write the failing tests**

In `apps/web/app/api/listings/route.test.ts`: assert the response includes a `counts: Record<ListingStatus, number>` field reflecting `countByStatus`'s real per-status totals (via the test's fake-repository convention), not derived from `items`.

In the `dashboard-listings-client` test file: assert the metric-strip values come from `response.counts` (not from `items.length`-style derivation); assert the component renders only a small teaser (the first 3-5 priority queue items) plus a link to `/queue`, not the full `<ListingQueue>` grouped view.

- [ ] **Step 3: Run them, confirm they fail**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run "apps/web/app/api/listings/route.test.ts" components/dashboard-listings-client.test.ts
```

(adjust the second path's extension to match the real file)
Expected: FAIL.

- [ ] **Step 4: Add `counts` to `GET /api/listings`**

In `apps/web/app/api/listings/route.ts`'s `createListListingsHandler`, extend the existing `forWorkspace` callback to also fetch counts (read `apps/web/app/api/quality/route.ts` first for this codebase's established pattern of fetching two things inside one `forWorkspace` call, if it does so — otherwise two sequential awaits inside the same callback is fine):

```ts
const context = await requireSessionContext(deps.sessionContext);
const { items, counts } = await deps
  .getDatabase()
  .forWorkspace(context.workspaceId, async (repositories) => {
    const items = await repositories.listings.listRecent(100);
    const counts = await repositories.listings.countByStatus();
    return { items, counts };
  });

return jsonResponse(200, {
  items: items.map((item) => {
    /* unchanged mapping from the existing handler */
  }),
  counts,
});
```

This is additive — existing consumers reading only `.items` are unaffected.

- [ ] **Step 5: Rewrite `dashboard-listings-client.tsx`**

- Fetch response type gains `counts: Record<ListingStatus, number>`.
- Add a new pure function computing the three summary metrics from `counts` instead of from the capped `items` array:

```ts
export function dashboardMetricsFromCounts(
  counts: Record<ListingStatus, number>,
): { active: number; inReview: number; blocked: number } {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    active: total - counts.published,
    inReview: counts.in_review + counts.reopened,
    blocked: counts.failed + counts.publish_failed,
  };
}
```

Run `grep -rn "dashboardMetrics\b" apps/web` before deciding whether the old `dashboardMetrics` function (computed from `items`) can be deleted — delete it if nothing else imports it.

- Replace the full `<ListingQueue ... />` render with a small teaser: the first 3-5 items from `queueItems` (prioritizing `in_review`/`needs_info` items, matching `queueGroups`' existing priority ordering) plus a `<Link href="/queue">查看完整工作佇列 View full queue</Link>`. If Task 5 Step 4 extracted shared helpers into `apps/web/lib/dashboard-queue-shared.ts`, import them from there instead of duplicating.

- [ ] **Step 6: Update `apps/web/app/(app)/dashboard/page.tsx`**

Replace the hard-coded `"Opak Cellar"` header with the workspace name, reusing Package B's existing `resolveWorkspaceChrome` (from `apps/web/app/(app)/workspace-chrome.ts`) rather than duplicating its profile-fetch/fallback logic. Read `apps/web/app/(app)/workspace-chrome.ts` and `apps/web/app/(app)/layout.tsx` in full first to confirm `resolveWorkspaceChrome`'s real exported signature and what `authSessionContext.resolve()` actually returns — do not trust the sketch below verbatim until confirmed:

```tsx
import Link from "next/link";

import { DashboardListingsClient } from "../../../components/dashboard-listings-client";
import { authSessionContext } from "../../../lib/session-context";
import { resolveWorkspaceChrome } from "../workspace-chrome";

export default async function DashboardPage() {
  const session = await authSessionContext.resolve();
  const { workspaceName } = await resolveWorkspaceChrome(session);

  return (
    <div className="page-wrap">
      <div className="page-header dashboard-header">
        <div>
          <p className="eyebrow">
            {workspaceName} <span>OPAK PILOT WORKSPACE</span>
          </p>
          <h1>早上好，今天先處理最接近上架的酒款。</h1>
          <p className="lede">AI 只提出有來源的建議；你保留最後的審核權。</p>
        </div>
        <Link className="primary-button" href="/listings/new">
          建立上架草稿 <span>Create draft</span>
        </Link>
      </div>
      <DashboardListingsClient />
    </div>
  );
}
```

- [ ] **Step 7: Run the tests, iterate until they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web exec vitest run "apps/web/app/api/listings/route.test.ts" components/dashboard-listings-client.test.ts
```

(adjust paths/extensions to match the real files)
Expected: PASS.

- [ ] **Step 8: Typecheck and format**

Run:

```powershell
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check "apps/web/app/(app)/dashboard/page.tsx" apps/web/components/dashboard-listings-client.tsx "apps/web/app/api/listings/route.ts"
```

- [ ] **Step 9: Commit**

```bash
git add "apps/web/app/(app)/dashboard/page.tsx" apps/web/components/dashboard-listings-client.tsx "apps/web/app/api/listings/route.ts" "apps/web/app/api/listings/route.test.ts" apps/web/components/dashboard-listings-client.test.ts
git commit -m "$(cat <<'EOF'
feat: give dashboard accurate status counts, a queue teaser, and the workspace-derived name

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Delete stale `.next` cache, then typecheck everything**

Run:

```powershell
rm -rf apps/web/.next
corepack pnpm typecheck
```

Expected: PASS across every package (this session repeatedly found a stale, gitignored `.next/types` cache produces spurious `tsc` errors when run directly inside `apps/web` without clearing it first — always clear it before the real verification pass).

- [ ] **Step 2: Format check**

Run:

```powershell
corepack pnpm format:runtime:check
```

Expected: PASS, or fix flagged files with `corepack pnpm exec prettier --write <files>` and re-check.

- [ ] **Step 3: Full unit suite**

Run:

```powershell
corepack pnpm test
```

Expected: PASS, all packages.

- [ ] **Step 4: Integration suite (requires live Postgres)**

Run:

```powershell
docker compose up -d postgres
corepack pnpm test:integration
```

This package adds two new repository methods (Tasks 1-2) with real integration test coverage — these tests are NOT expected to pass without live Postgres. If Docker is unreachable, state that explicitly and report this step as BLOCKED, not skipped or assumed-passing.

- [ ] **Step 5: `pnpm runtime:forbidden:check`**

Run:

```powershell
corepack pnpm runtime:forbidden:check
```

Expected: PASS.

- [ ] **Step 6: Verify the real Turbopack production build**

This session found real Vercel deployment failures (twice) that only `next build --turbopack` catches, not `tsc --noEmit` or Vitest — both prior incidents were `.js`-suffixed relative imports that resolve fine under Vitest but fail under Turbopack's production build. Run the actual build before considering this plan done:

```powershell
corepack pnpm --filter @wukong/web exec next build --turbopack
```

Expected: completes and prints the full route table with `/queue` included, zero "Module not found" errors. If any new file this plan created (`queue-client.tsx`, `queue/page.tsx`, any new shared module from Task 5 Step 4) uses a `.js`-suffixed relative import for a real value import (not `import type`), drop the extension — this codebase's established, working convention for `apps/web` source files is no extension on relative imports; `.js` suffixes only work in `*.test.ts(x)` files, which Vitest (not Turbopack) resolves.

- [ ] **Step 7: Manual smoke check**

Start the dev server (`corepack pnpm --filter @wukong/web dev`) and confirm: `/catalog` shows pagination controls and search/filter that trigger new fetches (visible in network requests) rather than instant client-side filtering; `/queue` renders the full grouped queue with working bulk-approve; `/dashboard` shows a small teaser linking to `/queue`, accurate-looking counts, and the real workspace name (not "Opak Cellar") in the header.

---

## Self-Review

**Spec coverage:** §2 (`/queue` extraction) → Task 5. §3 (accurate counts) → Tasks 1, 6. §4 (`/catalog` pagination/search) → Tasks 2, 3, 4. §5 (dashboard workspace-name fix) → Task 6. §7's out-of-scope items (the Site's richer queue, other routes, root `metadata.title`) are not touched by any task, consistent with the design.

**Placeholder scan:** Task 2's Step 3, Task 3's Step 6, Task 4's Step 2/5, Task 5's Step 2/4, Task 6's Step 6 each explicitly flag a specific detail to re-verify against real code before trusting the sketch verbatim (the exact `listRecent` mapping logic, `platformProducts`' `createdAt`/`updatedAt` field presence, the existing test-mocking convention, `resolveWorkspaceChrome`'s real signature) — deliberate "read and confirm" instructions given known gaps in this plan's own research, not unresolved requirements.

**Type consistency:** `CatalogItem` (Task 3) gains the three ADR-7 fields once and every later reference (Task 3's route, Task 4's component) uses that same shape. `countByStatus`'s `Record<ListingStatus, number>` return type (Task 1) is reused identically by Task 6's `dashboardMetricsFromCounts` and the `/api/listings` route's `counts` field. `getByIds`'s `ListingSummary[]` return type (Task 2) matches `listRecent`'s own return type exactly, since Task 2 explicitly reuses `listRecent`'s real mapping logic rather than inventing a new shape.

**Scope check:** seven tasks — two small repository additions, one route rewrite, one component rewrite, one new-route extraction, one dashboard update, one verification pass. Comparable in size to Package B; the two repository-method tasks are small and low-risk, the route/component tasks are the bulk of the real work, matching this package's own "M" sizing from the master plan.
