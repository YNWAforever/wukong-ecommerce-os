# Package D — Read-only Dashboard, Catalog, Queue — Design

**Date:** 2026-09-02
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package D (§16). Dependency graph: `A → B → {C, D}`. Package B is done (PR #60, CI-green, pending merge) and this branch is built directly on top of it — Package D needs to extend Package B's own `SHELL_NAV_ITEMS` array with its `/queue` entry, so it makes more sense to build on Package B's actual committed code than to duplicate that data structure against bare `main`.

## 1. What this builds

`/catalog` gets real server-side pagination and search (replacing a hardcoded 100-row fetch and client-only JS filtering that silently misses matches beyond that window). `/dashboard` gets workspace-accurate status counts (replacing the same 100-row cap) and a smaller queue teaser. A new `/queue` route gets built by extracting the runtime's own, already-working `ListingQueue` component out of `/dashboard`, where it's currently embedded.

Two findings from direct verification meaningfully changed this package's scope from what the master plan's prose alone suggested:

- **`listing-queue.tsx` is not unused** — the master plan flagged this as needing "direct confirmation... before assuming the component is unused vs. simply unwired." Confirmed: it's already fully wired into `dashboard-listings-client.tsx`, receiving real props (`items`, `selected`, `eligibleIds`) and handling bulk-selection. The work here is extraction to its own route, not building from scratch.
- **The reference Site's real `/queue` page is far richer than the runtime's existing component** — directly browsed and read: it groups by 5 specific risk lanes (source-blocked, raw-value import alerts, content-diff review, summary-gap cohorts, export/UAT state), synthesizing data this session built as separate features (the freshness gate, `/quality`'s content-gap signals, export state) — not the runtime's simpler generic `ListingStatus` grouping. Matching the Site's version exactly would be a much larger, cross-cutting effort. **Decision:** extract and ship the existing, working component as `/queue`, accepting partial visual parity with the Site's richer reference — matching the master plan's own literal instruction ("wiring the existing... component") and this session's established discipline against unscoped expansion.

## 2. `/queue` — extraction, not a rebuild

New `apps/web/app/(app)/queue/page.tsx` renders `ListingQueue`, sourced from a new endpoint (or the existing `/api/listings` response, reused as-is — an implementation-plan decision, not a design-level one, since both are viable and the choice doesn't affect behavior). `dashboard-listings-client.tsx` drops its full `<ListingQueue>` render and replaces it with a small teaser: the highest-priority handful of items (however "priority" is already defined by the existing `queueGroups`/status ordering) plus a link to `/queue`, matching the Site's own confirmed Overview-page structure (4 example priority items, "查看完整工作佇列" link out — verified via direct browse this session).

`shell-nav-items.ts`'s `SHELL_NAV_ITEMS` gains the `/queue` entry Package B deliberately omitted, using the Site's confirmed label ("工作佇列" / "Work Queue").

## 3. Accurate counts — a real aggregate query

New `repositories.listings.countByStatus(): Promise<Record<ListingStatus, number>>` — a genuine `COUNT(*) GROUP BY status` SQL query, correct regardless of workspace size (unlike the current approach, which counts whatever fit in a 100-row fetch and silently undercounts beyond that). Both `/dashboard`'s summary tiles and `/queue`'s per-lane counts use this. Item *lists* rendered on screen still cap at a reasonable limit for practicality (e.g. 200) — only the counts need to be exact.

## 4. `/catalog` — real server-side pagination and search

`GET /api/catalog` gains query params: `page`/`pageSize` (offset-based, matching the existing `updatedAt DESC` ordering already used by `listRecent`) and `q` (a search term). `platform-products.ts`'s `listRecent` becomes a genuinely paginated, optionally-filtered query — the search term is pushed into the SQL query (e.g. `ILIKE` against title/SKU columns) rather than filtering an already-fetched, capped array in JS, which is what `catalog-control-center.tsx` does today and which silently misses any match outside the first 100 most-recently-updated rows.

`catalog-contract.ts`'s `CatalogItem` gains `createdAt`, `updatedAt`, `contentDigest` (ADR-7) — the database already has these columns; the view model just never surfaced them. Purely additive; no existing consumer breaks.

## 5. Small adjacent fix: dashboard's hard-coded merchant name

`apps/web/app/(app)/dashboard/page.tsx` hard-codes `"Opak Cellar"` in its header — a page-content instance outside Package B's shell-only ADR-6 scope. Since this task is already touching this exact file (to shrink the queue section into a teaser), it also reads the workspace name from `workspaces.profile.name`, the same pattern Package B already established for the shell.

## 6. Testing

- `countByStatus`: exact per-status totals against a fixture with more rows than any prior cap, proving correctness isn't dependent on fetch size.
- `/api/catalog` pagination: page 2 returns different rows than page 1 (no overlap, no gap); a search term matches a row that would fall outside page 1's default window; existing non-paginated consumers of the response shape don't break (additive query params, unchanged default behavior when omitted).
- New `/queue` route + page tests, mirroring the extraction (same `ListingQueue` component, same prop shapes, now served by its own endpoint/page).
- `dashboard-listings-client.test.ts`-style coverage for the new teaser (shows N items, links to `/queue`, no longer renders the full multi-lane queue inline).
- Existing `catalog-control-center.test.ts`-style tests updated for server-driven search/filter instead of the current client-only filtering.

## 7. Explicitly out of scope

- The Site's richer risk-categorized `/queue` (source-blocked/import-alerts/content-review/summary-gaps/export-UAT lanes) — a separate, much larger future effort, per §1's decision.
- Any change to `/listings/new`, `/listings/import`, or any route outside `/dashboard`/`/catalog`/`/queue`.
- The root layout's `metadata.title` hard-coded "Opak Cellar" (a Package B-flagged, still-unaddressed follow-up — unrelated file, not touched here).

## 8. Self-review

- **Placeholder scan:** none — every new method, query param, and file target named above is concrete, not a TBD.
- **Internal consistency:** §1's "extract, don't rebuild" decision for `/queue` is referenced consistently in §2 and §7; no section quietly assumes the richer Site-matching queue.
- **Scope check:** four related, cohesive deliverables (queue extraction, count accuracy, catalog pagination/search, one small adjacent hardcode fix) touching a bounded, related file set — comparable to this session's other M-sized packages.
- **Ambiguity check:** "extract vs. rebuild the queue" resolved explicitly (extract, with reasoning); "how to fix count accuracy" resolved explicitly (real aggregate query, with reasoning); whether the dashboard hardcode fix is in scope resolved explicitly (yes, since the file is already being touched).
