# `/listings/new` Bulk Update Import Tabs — Design

**Date:** 2026-08-30
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — this is the first half of that plan's Package E (§16), addressing §7 G11 and ADR-2 (§9).

## 1. What this builds

Today, `apps/web/app/(app)/listings/new/page.tsx` renders only `ListingIntakeClient` — the original photo/PDF wine-listing intake flow. `POST /api/listings/import` (backed by `apps/web/lib/bulk-form-import.ts`) is a complete, tested, operator-gated Bulk Update import endpoint, but no UI anywhere calls it.

This restructures `/listings/new` into one page with three tabs, matching the Site's confirmed IA (`wukonggpt`'s `IntakeWorkspace`, cloned and inspected read-only for this design):

1. **Existing products** (primary) — real file upload wired to the existing import API.
2. **Supporting evidence** — an honest, non-functional placeholder (no backend contract exists for this yet anywhere in the approved integration plan).
3. **New products** (blocked) — informational panel; the existing photo/PDF flow is unwired from this route but not deleted.

Explicitly out of scope for this design (deferred, not solved here): the freshness gate backend (`sourceImportId` entity, `assertExportFreshness`), which is the second, independent half of Package E; a real evidence-linking backend for tab 2; and deciding a permanent new home for `ListingIntakeClient`.

## 2. Architecture

`page.tsx` becomes a thin server component rendering one new client component, `ListingIntakeTabs` (`apps/web/components/listing-intake-tabs.tsx`), which owns tab-switching state and renders one of three panel components. This mirrors `admin-tabs.tsx`'s existing pattern exactly — same `role="tablist"`/`aria-selected`/`aria-controls` structure, same `useState` single-active-tab approach — rather than introducing a second tabbing convention.

```
apps/web/app/(app)/listings/new/page.tsx      (server component, unchanged shell)
  └─ ListingIntakeTabs                         (client, new — tab state + ARIA wiring)
       ├─ BulkImportPanel                      (client, new — tab 1, does real work)
       ├─ SupportingEvidencePanel              (client, new — tab 2, static placeholder)
       └─ NewProductBlockedPanel                (client, new — tab 3, static explanation)
```

`ListingIntakeClient` (the current photo/PDF flow) is untouched and unimported by this page after the change — it keeps compiling and keeps its own tests green, just isn't reachable from this route anymore.

## 3. Components

**`ListingIntakeTabs`** — holds `const [active, setActive] = useState<"bulk" | "evidence" | "create">("bulk")`, renders the tab list and the active panel, following `AdminTabs`'s exact JSX shape (three `<button role="tab">` elements, one `<div role="tabpanel">`).

**`BulkImportPanel`** — the real work:

- A hidden `<input type="file" accept=".xlsx">` behind a styled drop-zone button (matching the Site's visual pattern, translated to plain CSS).
- Client-side validation before any network call: file extension must end in `.xlsx` (matches the Site's own check), size must be ≤ 4 MiB (matches the API's actual `MAX_UPLOAD_BYTES = 4 * 1024 * 1024` in `apps/web/app/api/listings/import/route.ts:34`, not an invented number).
- On submit: `fetch("/api/listings/import", { method: "POST", body: file })` — the route reads raw bytes via `request.arrayBuffer()`, so no `FormData`/multipart wrapping is needed.
- Renders the real response: `parsedRows`, `createdDrafts`, `refreshedProducts` as three stat values, and the `issues` array (already capped at 100 by the route) as a list.
- Maps every real error code the route can return to a specific, honest message — no generic "something went wrong": `empty_upload` (400), `upload_too_large` (413), `upload_not_a_workbook` (400), `bulk_form_unreadable` (422), `bulk_form_too_many_rows` (413), `shopline_connection_missing` (409), `insufficient_role` (403).
- Does **not** show any freshness-gate messaging (no "≤24h fresh / 24–72h warning / >72h blocked" — that's the Site's hard-coded threshold the master instruction explicitly says not to ship, and the backend to support it doesn't exist yet).

**`SupportingEvidencePanel`** — static content stating this capability isn't available yet in this pilot; no form inputs, no fake submit button. Matches capability-truth discipline (§9 ADR-11 of the parent plan) — never show a fake success state.

**`NewProductBlockedPanel`** — static content explaining why, adapted from the Site's own reasoning (no Product Handle/Description/Images column in the real Opak export; keyed by an existing Product ID only). No functional form. A short note that new-product creation exists as a separate, tested flow elsewhere in the codebase, without claiming it's reachable from here.

## 4. Data flow

```
Operator picks .xlsx file
  → client validates extension + size (fail fast, no network call)
  → POST /api/listings/import (raw bytes)
      → requireSessionContext + requireWorkspaceRole("operator") [existing, unchanged]
      → readBulkFormSheet(bytes) [existing, unchanged — 400 upload_not_a_workbook on failure]
      → createBulkFormImporter(...)(...)  [existing, unchanged]
          → parseBulkForm [existing — 422 bulk_form_unreadable / 413 bulk_form_too_many_rows]
          → per-row: create or refresh a listing draft + upsert platform_products mirror
          → audit event per created/refreshed draft [existing, unchanged]
  ← 201 { specVersion, parsedRows, createdDrafts, refreshedProducts, issues }
  → BulkImportPanel renders the real counts and issues
```

No new backend code in this design — every step above already exists and is already tested (`app/api/listings/import/route.test.ts`, 6 tests, confirmed passing in the full suite run earlier this session). This design is UI-only: a new client surface calling an existing, correct API.

## 5. Error handling

Every error path is the route's existing, typed `ApiError(status, code, message)` shape (per `CLAUDE.md`'s documented convention). The panel keeps a `{ code, message } | null` error state and renders it verbatim (the route's messages are already operator-facing and safe — none of them leak internals, per the route's own comment about not leaking the zip-reader's internal error text). A network-level failure (fetch throws) gets one generic "couldn't reach the server, try again" message, distinct from any of the typed API errors.

## 6. Testing

Following the existing convention (e.g. `admin-tabs.test.tsx`, `listing-intake-client.test.ts`):

- `listing-intake-tabs.test.tsx` — tab switching renders the correct panel, ARIA attributes are correct (`aria-selected`, `role="tab"`/`"tabpanel"`).
- `bulk-import-panel.test.tsx` — client-side validation rejects a non-.xlsx file and an oversized file without calling `fetch`; a successful response renders the three counts and any issues; each of the seven named error codes renders its corresponding message; a network-level throw renders the generic fallback.
- `supporting-evidence-panel.test.tsx` / `new-product-blocked-panel.test.tsx` — thin render tests confirming no interactive form controls exist (guards against someone later adding a fake-functional element by accident).
- No changes needed to `app/api/listings/import/route.test.ts` — the backend is untouched.

## 7. CSS

New classes added to `apps/web/app/globals.css`, using the confirmed Site tokens already identified in the parent plan (§4/§8): navy `#17324d`, canvas `#f6f4ef`, border `#dfe2e1`, CTA `#b36a24`/hover `#8d4e17`, 16px card radius. Since `.admin-tab*` currently has zero CSS anywhere in the codebase (confirmed by direct search), this design adds one shared, reusable tab-list/tab/tab-panel style used by **both** `AdminTabs` and the new `ListingIntakeTabs`, rather than styling the new component in isolation and leaving the admin tabs unstyled. This is a small, low-risk opportunistic fix in the same file the design already needs to touch — not unrelated scope creep.

## 8. Self-review

- **Placeholder scan:** no TBD/TODO; every component's behavior is fully specified.
- **Internal consistency:** the "no freshness gate yet" decision in §3 matches §1's explicit scope boundary; the "don't touch ListingIntakeClient" decision in §1 matches §3's panel description.
- **Scope check:** focused — one route, three new small components, one CSS addition, zero backend changes. Fits a single implementation plan.
- **Ambiguity check:** the exact wording for `SupportingEvidencePanel`/`NewProductBlockedPanel` copy is left to implementation-time translation of the cited Site reasoning (zh-HK primary, English secondary, per the parent plan's i18n plan, §13) rather than fixed verbatim here, since exact copy is a details-level choice, not an architectural one.
