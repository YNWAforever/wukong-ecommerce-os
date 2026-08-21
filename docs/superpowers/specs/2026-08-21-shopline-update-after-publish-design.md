# SHOPLINE Update-After-Publish Design

**Date:** 2026-08-21
**Status:** Approved for implementation planning; source implementation has not started.

## Context

`CommerceConnector.updateProduct` (`packages/shopline/src/connector.ts`) has been
fully implemented and tested against the real SHOPLINE HTTP client since it was
built — `shopline-connector.ts`'s `updateProduct` issues a `PUT
/products/{id}` with an idempotency-key header, exercised by a real test
(`shopline-connector.test.ts`). Nothing calls it. `apps/worker/src/publish-product.ts`
unconditionally calls `createProduct`, every time, even for a listing that was
already published once, edited, and re-approved. The mock connector's
`updateProduct` is a genuine no-op stub, correctly matching the fact that
nothing exercises it.

Investigation for this spec found the reason this gap is real, not just an
oversight: **there is no first-class, listing-scoped signal today for "this
listing already has a known SHOPLINE remote product ID," for a listing that
went through Wukong's own create path.** `platform_products` — the table that
answers exactly this question — is written only by the bulk-form catalog
importer (`apps/web/lib/bulk-form-import.ts`, the sole production call site of
`platformProducts.upsert`/`upsertMany`). A listing created fresh in Wukong and
published via `createProduct` leaves its remote product ID stranded in two
places that don't serve this purpose: `publish_jobs.remote_product_id`
(scoped to one specific version's idempotency key — a re-approval mints a new
version and a new key, so a fresh publish attempt never looks at the old
job's row) and the `listing.published` audit event's metadata (durable, but
not queryable for this).

Separately: the idempotency key
`${workspaceId}:${versionId}:shopline:create` is independently reconstructed
as a literal string in five places (`delivery-policy.ts`, `delivery-service.ts`,
`shopline-consumer.ts`, `publish-product.ts`, and a read-only reconstruction
in the listing GET route). This spec's second key variant makes hand-editing
five call sites identically an active risk, not just existing debt.

## Goals

- Let a reviewer re-deliver an already-published, since-edited, re-approved
  listing via `shopline_api` and have the system correctly call
  `updateProduct` against the same remote product, instead of creating a
  duplicate.
- Cover both listing origins under one signal: a listing imported from
  SHOPLINE (already linked via `platform_products`) and a listing Wukong
  created and published itself (not linked today) both resolve through the
  same lookup.
- Show the reviewer, before they confirm delivery, whether this action will
  create a new SHOPLINE product or update an existing live one — updating a
  merchant's live listing is a more consequential action than creating a new
  draft-linked one.
- Fix the duplicated idempotency-key-string risk as part of adding the second
  variant, since extending it by hand across five call sites is how a
  divergence would actually happen.
- Preserve every existing safety property: `updateProduct` runs through the
  same connector error classification, retry loop, lease/claim idempotency,
  and audit trail shape the create path already has. This feature adds a
  branch to proven machinery; it does not build new machinery.

## Non-goals

- No UI to unlink a listing from its remote product. `platformProducts.unlinkListing`
  already exists, unused by any route; stays that way. A mistaken link is an
  operator/DB fix, not a feature in this slice.
- No pre-flight check (via `connector.getProductStatus`) for whether the
  remote product still exists before attempting an update. A failed update
  (e.g. the product was deleted on SHOPLINE's side) surfaces as a normal
  connector error through the existing classification and retry path — no
  new special case.
- No change to `createBulkFormUpdate`'s, `writeBulkFormWorkbook`'s, or the
  bulk-form export delivery method's behavior. That is a separate, already-
  shipped delivery path (`method: "bulk_form"`) with its own update mechanism
  (a downloaded, re-imported `.xlsx`); this spec is about the `shopline_api`
  method's live-API delivery specifically.
- No cross-connection re-linking (a listing changing which SHOPLINE store/connection
  it's linked to). One listing, one connection, for the life of its
  `platform_products` link, exactly as today.
- Production impact: none. `SHOPLINE_PUBLISH_ENABLED=false` in production
  (per `CLAUDE.md`'s existing gating) means this feature cannot touch Opak's
  real store regardless of this slice; that gate is unrelated to this change
  and stays exactly as it is.

## Chosen design

### 1. Data model: `platform_products` becomes the one signal, for both origins

`platform_products` gains one new required column and five existing columns
become nullable:

```
origin: text("origin").notNull()   -- "import" | "created"
```

Now nullable (were `.notNull()`): `sku`, `specVersion`, `rawRow`,
`factsPrefill`, `contentDigest`. Each of these is an artifact of the bulk-form
import process specifically — `contentDigest`'s own existing doc comment ties
it to `hashBulkFormRow(rawRow)`, so a create-origin row (no `rawRow` at all)
has no honest value to put there. Making it nullable rather than fabricating
a placeholder digest keeps the field's documented meaning intact for the rows
that actually have one.

Required for every row regardless of origin, unchanged: `id`, `workspaceId`,
`connectionId`, `remoteProductId`, and the new `origin`. `listingId` stays
exactly as nullable as it already is today ("null until a draft is created
for this product").

`UpsertPlatformProductInput` and `PlatformProduct` (`packages/db/src/repositories/platform-products.ts`)
widen their types to match: `sku`, `specVersion`, `rawRow`, `factsPrefill`,
`contentDigest` become `T | null`, `origin` is added as a required
`"import" | "created"` field. The bulk-form importer's existing call site
(`bulk-form-import.ts`) is updated to pass `origin: "import"` explicitly —
its behavior is otherwise unchanged, and every field it already supplies
stays non-null in practice.

**Regression this surfaces, and its fix:** `enrichmentBatchService.createBatch`
(`apps/web/lib/enrichment-batch-service.ts`) calls `platformProducts.listRecent(...)`
and then unconditionally calls `bulkFormGaps(product.rawRow)` on every row to
build a gap-based cohort. Once create-origin rows (with `rawRow: null`) can
appear in that scan, this call needs to not run on them — gap-based cohorts
are meaningless for a listing that was never a bulk-form row; it went through
the normal AI extraction pipeline instead. Fix: filter to
`products.filter((p) => p.origin === "import")` before the `bulkFormGaps`
call. This is a required part of this slice, not an optional cleanup — without
it, this feature breaks enrichment batch creation the moment a create-origin
row exists.

### 2. Idempotency key: one shared helper, two variants

New exported function, in `packages/shopline` alongside `delivery-policy.ts`:

```ts
export function shoplinePublishIdempotencyKey(
  workspaceId: string,
  versionId: string,
  action: "create" | "update",
): string {
  return `${workspaceId}:${versionId}:shopline:${action}`;
}
```

All five existing call sites (`delivery-policy.ts`, `delivery-service.ts`,
`shopline-consumer.ts`, `publish-product.ts`, and the read-only
reconstruction in the listing GET route) switch to calling this helper with
`"create"` instead of hand-building the string — a pure refactor for those
sites, since the literal produced is byte-identical to today's. The new
`"update"` variant is used wherever the worker decides to update rather than
create (§3). `publish_jobs`'s existing unique index on
`(workspaceId, idempotencyKey)` needs no change — it already treats the key
as an opaque string, so a `:shopline:update` key naturally gets its own row,
independent lease, and independent retry budget from any prior `:shopline:create`
attempt for the same version.

### 3. Worker-side create-vs-update decision

`publishApprovedProduct` (`apps/worker/src/publish-product.ts`) gains one
lookup, placed immediately before it currently builds the idempotency key:

```ts
const existingLink = await repositories.platformProducts.getByListingId(
  listing.id,
);
const action = existingLink ? "update" : "create";
const idempotencyKey = shoplinePublishIdempotencyKey(
  input.workspaceId,
  input.expectedVersionId,
  action,
);
```

- **No link** (`existingLink === null`): unchanged behavior — `createProduct`,
  then on success `platformProducts.upsert({ ..., origin: "created", listingId: listing.id, sku: null, specVersion: null, rawRow: null, factsPrefill: null, contentDigest: null })`.
- **Link exists**: call `connector.updateProduct(existingLink.remoteProductId, payload, idempotencyKey)`
  instead of `createProduct`. On success, `platformProducts.upsert(...)` again
  with the same `remoteProductId`/`connectionId`/`listingId`/`origin` (origin
  stays whatever it already was — `"import"` stays `"import"`, `"created"`
  stays `"created"`; an update never changes how a listing originated) —
  this refreshes `updatedAt` so the row's recency stays meaningful to any
  future reader, without needing new tracked state beyond what already
  exists.

This decision is made **fresh, inside the worker, at processing time** — not
decided earlier and encoded into the `ShoplinePublishJob` queue message. The
message schema (`packages/jobs/src/cloudflare-queue.ts`) is unchanged:
`{ workspaceId, draftId, versionId, connectionId }`, no new field. This
matches how the worker already re-evaluates delivery-policy eligibility fresh
at processing time rather than trusting the web request's earlier check —
whatever is true about the listing's link _right now_ is what decides the
connector call, not what was true when the reviewer clicked "Deliver."

`markPublished` (`packages/db/src/repositories/listings.ts`) is reused,
unchanged, for both paths — an update doesn't need a different terminal
listing status; the listing is correctly `"published"` either way, with the
same `listing.published` audit event and metadata shape
(`{ versionId, remoteProductId, payloadDigest }`).

### 4. Reviewer-facing signal: what will this delivery do

The listing GET route (`apps/web/app/api/listings/[id]/route.ts`) adds one
field to its existing response, alongside the current permission flags
(`canProcess`, `canApprove`, etc.):

```ts
shoplineLink: { remoteProductId: string } | null
```

sourced from the same `platformProducts.getByListingId` lookup used in §3.
`null` → this delivery will create; present → this delivery will update.

The delivery panel component uses this to show, before the reviewer confirms
a `shopline_api` delivery:

- No link: _"This will create a new SHOPLINE product."_
- Linked: _"This will update the live SHOPLINE product for `<listing's own canonical sku>`."_

The listing's own `CanonicalListing.sku` (always present on an approved,
publishable version — the schema only allows a null `sku` on an
in-progress draft, not a version that reached `approved`) is used for the
human-readable label, not `platform_products.sku` — that field is now
nullable for create-origin rows and was never meant as a display label in
the first place.

This is a read-only, informational display — it does not change what the
backend decides at delivery time. §3's worker-side lookup is the actual
decision, made independently and always correctly, whether or not the
reviewer ever saw this message.

### 5. Audit trail

No new audit action strings. `listing.published` and `listing.publish_failed`
(`packages/db/src/repositories/listings.ts`) already carry
`{ versionId, remoteProductId, payloadDigest }` / `{ versionId, errorCode }`
metadata — equally meaningful whether the underlying connector call was a
create or an update, so both paths reuse them exactly as today.

The `platform_products` upsert itself is not separately audited, matching
the existing precedent: the bulk-form importer's own `upsertMany` call isn't
audited either — it's bookkeeping alongside the already-audited
`listing.imported`/`listing.import_refreshed` events, not an audited action
in its own right. The create-path's new upsert follows the same convention.

### 6. Error handling

`updateProduct` slots into the exact retry loop and `ConnectorErrorCode`
classification `createProduct` already uses in `publish-product.ts` — no new
error-handling shape. A `remote_unavailable` error retries (same small-attempt-count
loop); `rate_limited`, `invalid_credentials_or_permission`, and
`validation_failed` do not, and surface through `markPublishFailed` exactly
as a failed create would today.

## Consequences

- `platform_products` changes from "the bulk-form import mirror" to "the one
  place any listing's known SHOPLINE remote product link lives," which is
  what the very first roadmap note describing bulk-form export originally
  envisioned ("decide create-vs-update from `platform_products`") before that
  earlier spec scoped it down to import-only for its own slice.
- The idempotency-key duplication across five call sites, an existing risk,
  gets closed as a byproduct of this feature rather than left to compound
  further.
- Every real-world publish now correctly avoids creating a duplicate SHOPLINE
  product for a listing that already has one — the actual bug this spec
  exists to fix.

## Follow-ups

1. A staleness bound or pre-flight reconciliation (checking `getProductStatus`
   before an update) if a deleted-or-moved remote product turns out to be a
   real operational problem for the pilot, rather than a rare edge case
   handled adequately by the existing error path.
2. Surfacing `platform_products.origin` in any admin-facing catalog view, if
   an operator ever needs to see, at a glance, which of their listings came
   from import versus were created fresh — not needed by anything in this
   slice.
3. An unlink UI, if operators ever need to manually correct a mistaken link
   rather than relying on direct DB access.

## Open questions

None outstanding — the design corrects one internal inconsistency found
during the self-review below (`contentDigest`'s nullability), and the four
scope/UX/data-model/idempotency decisions were confirmed directly during
brainstorming.
