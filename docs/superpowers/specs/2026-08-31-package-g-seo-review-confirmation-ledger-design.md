# Package G — SEO Review Fields, Confirmation Ledger, Freshness-Bound Approval — Design

**Date:** 2026-08-31
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package G (§16), addressing §9 ADR-8 and §11's confirmation-ledger requirement.

## 1. What this builds

Today's review UI (`listing-fields-form.tsx`/`listing-review-client.tsx`) covers 3 of Opak's 8 AI-writable fields via the existing `title`/`description` fields (`nameZh`, `summaryEn`, `summaryZh`), but 5 remain unreviewed: `seoTitleEn/Zh`, `seoDescriptionEn/Zh`, `seoKeywords`. Separately, `POST /api/listings/[id]/approve` takes almost no body (`{background}` only, confirmed by reading the route directly) and trusts server-read state entirely — there is no caller-supplied assertion that the reviewer actually reviewed the version/content they think they're approving, and no confirmation record of which fields/negative-conditions were checked. This package closes both gaps: the 5 missing SEO fields get real review UI, and approval becomes an atomic, ledger-backed action bound to the same identity/content checks Package E's freshness gate already established.

## 2. SEO review fields

Extend `apps/web/components/listing-review-client.tsx`'s `mapListingView` with 5 new `field(...)` entries reading `content.seo.title.en`/`content.seo.title["zh-Hant"]`/`content.seo.description.en`/`content.seo.description["zh-Hant"]`/`content.tags.join(", ")` (mirroring the existing `titleEn`/`titleZhHant` pattern exactly, including `evidenceKey: "seo.title.en"` etc. so `FieldEvidence` rows for these fields — already producible by the AI pipeline, since `seo`/`tags` are already part of `CanonicalListing` — resolve correctly). `applyListingFields` gains the inverse mapping, with `tags` split on `/[,，]/` matching `grapeVarieties`'s existing convention. `listing-fields-form.tsx` gains a 4th field group, "SEO 與標籤 / SEO & tags", listing the 5 new keys — no new component, just new entries in the existing `groups` array and `keys` lists.

## 3. Confirmation ledger

**New table `review_confirmations`** (one row per listing version, matching this codebase's "approval is whole-listing, never per-field" rule):

```ts
export const reviewConfirmations = pgTable(
  "review_confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
    listingId: uuid("listing_id").notNull(),
    versionId: uuid("version_id").notNull(),
    fieldConfirmations: jsonb("field_confirmations").$type<Record<string, boolean>>().notNull(),
    negativeConfirmations: jsonb("negative_confirmations").$type<Record<string, boolean>>().notNull(),
    revision: integer("revision").notNull().default(0),
    sourceImportId: uuid("source_import_id"),
    rowDigest: text("row_digest"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("review_confirmations_workspace_version_uq").on(table.workspaceId, table.versionId),
    foreignKey({
      name: "review_confirmations_workspace_listing_fkey",
      columns: [table.workspaceId, table.listingId],
      foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
    }).onDelete("cascade"),
  ],
);
```

`fieldConfirmations` keys are the 8 AI-writable field names (`nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`); `negativeConfirmations` keys are the 7 from §11 (`priceUnchanged`, `membershipUnchanged`, `categoryUnchanged`, `statusUnchanged`, `supplierUnchanged`, `quantityDeltaNeutral`, `noImageChange`). A new `PATCH /api/listings/[id]/review-confirmations` route (reviewer-role-gated, same pattern as the existing flag-resolve route) upserts one confirmation at a time and increments `revision`; `GET /api/listings/[id]` (the existing snapshot route) grows a `reviewConfirmation` field in its response so the client can render current state and know the `revision` to send back at approval time.

**UI:** a new `ConfirmationChecklist` component (matching `ComplianceFlags`'s existing checklist-with-explicit-action pattern) rendered between `ListingFieldsForm` and `ComplianceFlags`, listing all 15 items as checkboxes; `ListingFieldsForm`'s `approvalDisabled` gains one more condition — not all items confirmed — alongside the existing blocking-flags check.

## 4. Approval binding to the freshness gate

`assertExportFreshness` (Package E)'s first check is `freshnessAttested` — an explicit human attestation meant for the *export* moment (Package H), not approval; passing `freshnessAttested: true` here would misuse that flag. Instead, extract checks 2–4 (remote-link exists, `sourceImportId` matches, content digest matches, active version matches) from `packages/core/src/assert-export-freshness.ts` into a shared internal helper, and add a new exported `assertApprovalFreshness(input, deps)` that calls only that shared core (no attestation check, no header-contract check — those are export-time-only concerns). `assertExportFreshness` itself is refactored to call the same shared helper before its own attestation/header-contract checks, so the two functions can never drift apart on what "the content still matches" means.

`POST /api/listings/[id]/approve`'s body schema grows: `expectedVersionId` (required, must equal `snapshot.activeVersion.id` or 409 `version_conflict`), `confirmationLedgerRevision` (required, must equal the ledger's current `revision` or 409 `confirmation_ledger_stale`), and — only for import-origin listings (checked via `platformProducts.getByListingId`) — `sourceImportId`/`expectedRowDigest` (required for those listings only; create-origin listings have no `platform_products` link to check against, so they skip `assertApprovalFreshness` entirely, matching how `deliverBulkForm`'s existing origin-based branching already treats the two kinds of listings differently). `ListingReviewClient`'s `approve()` function grows its request body accordingly, reading `model.versionId` and the ledger snapshot already present in the loaded `ListingViewResponse`.

**Invalidation:** any successful `PUT /api/listings/[id]/review` (draft save) already creates a new version via `appendVersion`; since `review_confirmations` is keyed by `versionId`, a new version simply has no confirmation row yet — the checklist resets to unconfirmed automatically, no explicit invalidation logic needed beyond what version-scoping already provides. A same-digest re-import (an unchanged bulk-form row re-imported) does not create a new listing version, so an existing confirmation survives it, matching §11's "a same-digest re-import may preserve approval only with a fresh freshness attestation" — the *content* freshness check still runs at approval time regardless of when the confirmation itself was recorded.

## 5. Testing

- `listing-review-client.test.tsx` (or wherever `mapListingView`/`applyListingFields` are already tested — confirm before assuming): extend with the 5 new fields' round-trip.
- New `review-confirmations` repository + integration test (cross-workspace RLS, matching this session's established pattern).
- New `PATCH /api/listings/[id]/review-confirmations` route test: reviewer success, viewer 403, revision increments.
- `packages/core/src/assert-export-freshness.test.ts`: extend to prove the shared helper is genuinely shared (a test that breaks the shared logic breaks both functions' tests).
- New `assert-approval-freshness.test.ts`: same 4 failure-reason tests as `assertExportFreshness`'s checks 2–4, minus `not_attested`/`header_contract_stale`, plus a success test.
- `approve/route.test.ts`: extend with `version_conflict` (409), `confirmation_ledger_stale` (409), and the import-origin-vs-create-origin branching (create-origin approval succeeds without a `sourceImportId` in the body; import-origin approval without one is rejected).

## 6. Self-review

- **Placeholder scan:** none.
- **Internal consistency:** §4's shared-helper extraction keeps §3's `revision`/`sourceImportId`/`rowDigest` fields meaningful (they're exactly what the approval route checks against) without duplicating Package E's matching logic.
- **Scope check:** UI (SEO fields, checklist) + schema (one new table) + one refactored + one new pure function + one extended route — comparable in shape to Package F, though the approval-route change touches a more central, higher-traffic path and deserves proportionally careful review.
- **Ambiguity check:** "does approval call the same freshness function as export" is resolved explicitly (no — a shared core, two distinct call sites with different top-level checks) rather than left for the implementer to guess; "what invalidates a confirmation" is resolved explicitly (version-scoping alone, no new invalidation code needed).
