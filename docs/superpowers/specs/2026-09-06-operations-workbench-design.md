# Operations Workbench — first-slice design

Date: 2026-09-06
Status: Approved direction and behavior; written specification awaiting user review.
Source baseline: main 0a25e701e04238f24f3c73bf6761da0b01dcca00.

## Problem and outcome

Operators currently move between Overview, Catalog, Work Queue, import, batches and Jobs to determine what needs attention. The dashboard promotes new-listing creation and shows only the latest five listings. Existing XLSX-first catalog work is difficult to follow across these entry points.

Make /dashboard an Operations Workbench that answers: what needs attention, what is progressing, and what action is available next? Keep source identity, permissions and review/export evidence intact. Reduce navigation and repeated inputs without introducing automatic approvals or merchant writes.

## Approved direction

The user selected management of the whole operation, chose an action worklist over a workflow board or batch wizard, and approved the visual layout and first-slice behavior. The visual reference is the local operations-workbench-v1.html mockup. Its filenames, counts and activities are synthetic. The specification below governs behavior where the mockup is illustrative.

Layout: a compact left navigation, a primary Import products action, three selectable work-state summaries, an action list and a contextual help panel. Use the existing plain CSS stack, restrained blue primary actions, amber attention accents, clear typography and generous row spacing. Color always has a text equivalent. Use the current locale cookie to choose Traditional Chinese or English; do not duplicate every production label in both languages as the concept mockup does.

## First-slice scope

- Refresh the existing /dashboard and shared navigation.
- Add a workspace-scoped, read-only workbench projection over existing retained records where current APIs cannot supply accurate classification and pagination.
- Support attention, in-progress and completed views, exact matching counts, stable pagination, source context, last update and permission-aware destination actions.
- Preserve all existing detailed screens. Changes to destination screens are limited to accepting an exact record or filter context and providing a return link where necessary.
- No schema migration, new task persistence, new source-to-draft conversion, new approval/export behavior, bulk actions from the workbench, or broad catalog/review/editor redesign.

## Navigation and destinations

Primary navigation:

| Label | Destination and behavior |
| --- | --- |
| Workbench / 工作台 | /dashboard; retains existing route |
| Catalog / 商品目錄 | /catalog; preserves existing filters and source labels |
| Imports / 匯入 | /listings/import; existing import flow, not a newly promised global import-history screen |
| Exports & results / 匯出與結果 | /jobs with export filtering; results remain attached to exact export attempts |

Keep Work Queue (/queue), Batches (/batches), New listing (/listings/new), all Jobs (/jobs), Quality (/quality) and System map (/system-map) accessible in a secondary Tools group. Keep the existing admin-only settings destination and role gates. Do not remove URLs or reduce the ability to discover existing functionality. The mockup's Imports history label is replaced by Imports because a complete cross-source history screen is outside this slice.

The primary Import products button uses /listings/import for operator and higher roles. Viewers receive a read-only explanation rather than an enabled mutation control. Direct URLs remain protected by the server.

## Work-item contract

One item represents one retained listing, one export attempt, one website scan, or one successful workbook import. Use a namespaced identity such as listing:<id>; a product count is supplementary and never substituted for the work-item count. A listing's pipeline/publish activity is folded into that listing item, not repeated as additional tasks. Batches remain a secondary destination in this slice, avoiding double-counting their member listings.

Each item exposes identity, kind, state, title, source label when available, affected product count when known, last update, reason code, and one primary destination action. Missing counts render as unavailable rather than zero. Source labels distinguish independent workbook products, website observations and platform-linked listings. Do not expose raw internal errors or credentials.

Classification is mutually exclusive, with attention taking precedence:

| Record | Needs attention | In progress | Completed |
| --- | --- | --- | --- |
| Listing | failed/publish_failed; needs_info; in_review/reopened; approved awaiting its existing delivery action | received/processing/publishing | published according to the existing domain status |
| Export attempt | failed artifact; ready artifact with rejected or unreported included members | pending artifact | ready artifact with all included members operator-reported accepted; retain the unverified report label |
| Website scan | retained failed scan | retained queued/running scan | retained completed scan; completion means the scan finished, not that observations were saved or products published |
| Workbook import | no synthetic failure task | no synthetic processing task | successful retained import; completion means catalog records were saved |

Use actual domain enums and existing reconciliation logic to implement these semantic categories. Unknown future statuses must surface as unclassified/unavailable with a read-only destination, never silently appear completed. They are excluded from the three state totals and accompanied by an explicit unclassified count.

Completed export wording is "Result reported", with "Operator reported; not independently verified". A ready file with outstanding results is "Ready — result needed". Never equate download, report or scan completion with SHOPLINE acceptance. An import may be completed while subsequent listing tasks need attention; these are separate operations with separate labels.

### Evidence limits

XLSX preview is stateless. Failed previews are not retained and cannot populate historical workbench tasks. Preserve their retry experience on the existing import page. The mockup's failed-preview task illustrates error presentation only and is not a first-slice persisted item.

The current independent workbook catalog contract does not expose per-product quality-warning cohorts. Do not invent the mockup's "12 products missing category" task or infer it from a partial page. Saved workbook imports can link to existing catalog records without implying edit, approve or export capability. New durable preview-failure tracking and workbook-quality tasks require a later design.

## Counts, filtering and ordering

The three summaries count work items across the workspace and all retained history under the current kind filter. Never calculate workspace totals from the latest five or first page. Default to Needs attention and 25 items per page; allow at most 100 through the read API. Filter by all sources, listings, exports, website scans or workbook imports. Keep state, kind and page in validated URL parameters; changing state or kind resets page to one.

Order attention by failure first, missing information next, pending review next, then delivery/result follow-up; within a category use oldest update first, then namespaced identity. In-progress and completed order by newest update, then identity. These rules are deterministic and match the count predicates. Do not mix item populations with different scopes under one unlabeled total.

## Actions and context

Rows navigate; they do not approve, retry, import, publish or report directly. A user opens the existing authoritative screen to perform its supported action. Reviewers may see "Review" where operators/viewers see "View details — reviewer required". Resolve actions with the same server role/capability helpers used by their destinations.

Listing items open the exact listing or current supported review destination. Export items open the exact attempt in Jobs and preserve its reconciliation context. Website items use the retained scan URL on import. Workbook items use a supported import/source filter in Catalog; if an exact filter is absent, add only that bounded read filter rather than sending users to an unrelated unfiltered result set.

Browser Back restores workbench view, page and filters. Detail links carry only identifiers and validated return context; no workbook bytes, sensitive query values or stale approval assumptions. Existing selection, observed version, checklist, source binding and retry idempotency rules remain authoritative on destination screens. No extra confirmation is introduced for navigation or read-only filtering.

## Data and component boundaries

- A dedicated workbench read repository projects the retained tables through db.forWorkspace; never issue one request per row or fetch all history into the browser.
- A pure classification/action mapping module owns state precedence, stable item identity and localized reason keys. It takes explicit role/capability evidence and does not perform writes.
- A thin injected route factory resolves the session, validates filters and calls the read service. Additive read queries may be necessary; reuse existing export reconciliation semantics rather than duplicating receipt rules.
- Return counts and page membership from one consistent database snapshot. Include observedAt. Fetch bounded detail enrichment for returned identifiers only. Do not claim atomic evidence across later navigation or remote merchant state.
- Workbench client owns URL state, loading/retry behavior and stale-request cancellation. Presentational components render summary selectors, rows and contextual guidance.
- Shared shell changes own navigation grouping and active states. Existing routes and domain mutation modules remain unchanged.

Do not reconstruct the workbench by combining capped dashboard/catalog/jobs pages; those endpoints have different populations. Inspect actual table/status definitions in the active checkout during planning. Any source that cannot be projected within these existing retention and security constraints is an explicit scope adjustment for review, not permission to add persistence or invent events.

## Loading, errors and accessibility

First load uses labelled skeletons. A failed first read shows a concise localized error and retry; totals show unavailable, never zero. Failed refresh retains previous content with a stale label and observed time. Filter changes cannot display old data as if it belongs to the new filter. Abort superseded requests and ignore late responses. Refresh on focus and on explicit retry; no new background polling infrastructure.

Empty states distinguish no work from no matching work and offer an appropriate existing destination. Keep keyboard-visible focus, semantic headings and links, accessible pressed states on summary filters, polite loading announcements and the shell's skip link. At narrow widths stack rows with their actions, collapse navigation using the existing accessible drawer, and keep essential status/action text visible without horizontal scrolling. Contextual guidance is secondary and may collapse on mobile.

## Verification and rollout boundaries

Use synthetic fixtures and isolated services only. Verify:

1. Exclusive classification, unknown-state handling and exact counts with more than one page of mixed record kinds; no listing/job double count.
2. Export pending/failed/ready and accepted/rejected/unreported evidence using existing reconciliation fixtures.
3. Workspace isolation and server role authorization; unsupported source actions absent.
4. Stable sort, page boundaries, invalid URL parameters and exact destination context.
5. Initial error, stale refresh, filter races, empty results, Back navigation and retained destination selections.
6. Keyboard navigation, locale switching and narrow/desktop layouts in browser acceptance.
7. Existing review/export/source-binding regression suites, project typecheck/build and relevant formatting/runtime checks.

Only the specification is being committed now. Implementation follows written-spec approval and an implementation plan. Publishing or deployment is a later explicit release decision. Keep real SHOPLINE writes disabled; do not use paid providers, production migrations, merchant seeding or real workbook uploads for verification.

## Self-review

Checked against current shell, dashboard, catalog and Jobs contracts. Corrected the visual concept's unsupported persisted preview failures, workbook quality counts and import-history naming. Scope is workbench plus navigation and necessary read-only projection/context support. No production or domain-write authority is implied.