# Bulk Form Export Design

**Date:** 2026-08-16
**Status:** Approved for implementation planning; source implementation has not started.

## Context

The bulk-form-import-intake plan built `createBulkFormUpdate` in
`packages/shopline/src/bulk-form.ts` — a pure function that diffs a stored
bulk-update-form row against enriched values and produces a re-importable
update row. It was built and tested against synthetic fixtures. Nothing calls
it. This is the follow-on the roadmap named "exporter delivery (1d)": wiring
that function into the delivery surface so an enriched, imported listing can
actually be written back to SHOPLINE.

The roadmap note that named this follow-on ("wire `createBulkFormUpdate` into
the delivery module, deciding create-vs-update from `platform_products`")
undersold the shape of the work. Investigation for this spec found:

- **Bulk-form export is UPDATE-only, by explicit design and by code
  enforcement.** `bulk-form.ts:5-13` states the form is "the only supported way
  to read an existing catalog in and write enrichment back onto products
  SHOPLINE already owns," and `validateEnrichments` (`bulk-form.ts:974-981`)
  rejects any enrichment whose `productId` isn't already present in the parsed
  sheet. There is no bulk-form "create." "Create-vs-update" is really "does
  this listing have a `platform_products` row with a remote product ID at
  all" — if not, bulk-form export does not apply, and the listing uses the
  existing create path (`shopline_api` / CSV), unchanged.
- **Today's `"csv"` delivery method is an unrelated artifact.**
  `deliverListing`'s csv branch (`delivery-service.ts:347-364`) calls
  `createShoplineCsv`, which emits a 15-column, create-shaped CSV from a
  `ShoplineProductPayload` (`packages/shopline/src/csv.ts:6-22`). The bulk
  update form is a 71-column grid (`BULK_FORM_COLUMNS`,
  `bulk-form.ts:22-246`) built from a stored raw row plus enrichment values,
  written as an `.xlsx` binary via `writeBulkFormWorkbook`. They share no
  code, no spec version, no file format. Bulk-form export cannot reuse the
  existing `"csv"` branch; it is a third delivery kind.
- **`createBulkFormUpdate`'s parameter type is stricter than what's stored.**
  It takes `readonly BulkFormProductRow[]` — the full shape `parseBulkForm`
  produces (categories, pricing, inventory, gaps, facts, ...) — but reads only
  `row.productId`, `row.raw`, and `row.rowNumber` at runtime
  (`bulk-form.ts:1050-1091`). `platform_products` stores only `rawRow` and
  `factsPrefill`, not the rest. The type and the storage don't line up.
- **`platform_products` has no lookup by listing.** The repository
  (`packages/db/src/repositories/platform-products.ts`) exposes `upsert`,
  `upsertMany`, `listByRemoteProductIds`, `listRecent`, and `unlinkListing` —
  nothing answers "does this draft have a known remote product" directly.

The domain term **bulk form export** will be recorded in `CONTEXT.md`
alongside the existing **Shopline bulk form** entry.

## Goals

- Let a reviewer export an approved, enriched, imported listing as a
  re-importable bulk update form, downloadable the same way CSV delivery
  works today.
- Reuse `createBulkFormUpdate` and `writeBulkFormWorkbook` exactly as built —
  no changes to their validation or write logic.
- Decide applicability from data, not from a new flag: a listing qualifies
  when it has a `platform_products` row with a `remoteProductId`.
- Gate on the same review state the existing delivery methods require, so
  bulk-form export cannot ship unreviewed AI content any more easily than CSV
  or the SHOPLINE API can.
- Record what changed and how in the audit trail, at the same identifier
  granularity the existing delivery methods use — no product content in
  metadata.

## Non-goals

- No automatic upload to SHOPLINE. The operator downloads the file and
  re-imports it by hand, exactly like today's CSV delivery — this is
  export, not publish.
- No change to `createBulkFormUpdate`'s or `writeBulkFormWorkbook`'s
  validation, neutralization, or write behavior. This slice is wiring, not a
  rewrite.
- No multi-product batch export in this slice. One listing, one file — the
  route shape and the audit trail both stay per-listing, matching CSV.
  Batch export is a plausible later follow-on once single-listing export has
  been used once.
- No change to the 08-08 delivery-module-consolidation spec's scope. That
  spec is about create-product eligibility policy; this feature doesn't touch
  it and doesn't depend on it landing first.
- No solving the staleness hazard below. It is named, not fixed, in this
  slice.

## Chosen design

### Applicability: `platform_products.getByListingId`

The repository gains one read method:

```ts
getByListingId(listingId: string): Promise<PlatformProduct | null>;
```

A listing is exportable via bulk form exactly when this returns a row with a
non-empty `remoteProductId` — which every row has, since `remoteProductId` is
`notNull()` on the table (`schema.ts:631`). So the check is simply "a row
exists." No new column, no new flag: the same link the importer already
maintains is what the exporter reads.

### The row parameter's type is narrowed to what export can actually supply

`createBulkFormUpdate`'s first parameter changes from `readonly
BulkFormProductRow[]` to `readonly BulkFormExportRow[]`, where:

```ts
export type BulkFormExportRow = Pick<
  BulkFormProductRow,
  "productId" | "raw" | "rowNumber"
>;
```

`BulkFormProductRow` structurally satisfies this narrower type, so
`parseBulkForm`'s existing output — and every existing caller and test —
keeps compiling unchanged. This is the smaller of the two options the
investigation raised (the other being a reconstruction helper that fabricates
unused fields); narrowing the signature to what the function actually reads
is more honest than inventing values for fields nothing consumes.

### Reading `rawRow` back as a `BulkFormRawRow`

`platform_products.rawRow` is stored as `jsonb().$type<Record<string, string |
null>>()` — a compile-time cast with no runtime guarantee that all 71
`BulkFormColumnKey`s are present, the same gap the repository already flags
for `factsPrefill` (`platform-products.ts:81-85`, fixed there with
`listingFactsSchema.parse`). There's no zod schema for a 71-key string record
worth writing for this alone; instead, the export path checks that every key
in `BULK_FORM_COLUMNS` is present in the stored `rawRow` before treating it as
a `BulkFormRawRow`, and reports the row as unexportable (not throws) if the
check fails — a row this shape-broken shouldn't already exist in practice
(the importer always writes a full row), but export must not crash if it
somehow does. This check lives in `packages/shopline`, next to
`BulkFormRawRow`'s definition, as a `isBulkFormRawRow` guard — reused by
nothing else, but co-located with the type it validates rather than
duplicated at the call site.

### Mapping enriched content onto the eight writable columns

The enrichment values `createBulkFormUpdate` needs come from the listing's
`activeVersion.content` (a `CanonicalListing`, `listing-schema.ts:40-46`), not
from `platform_products`. The mapping is direct — every bulk-form enrichable
column has exactly one canonical-listing source:

| Bulk-form column   | `CanonicalListing` source    |
| ------------------ | ---------------------------- |
| `nameZh`           | `title["zh-Hant"]`           |
| `summaryEn`        | `description.en`             |
| `summaryZh`        | `description["zh-Hant"]`     |
| `seoTitleEn`       | `seo.title.en`               |
| `seoTitleZh`       | `seo.title["zh-Hant"]`       |
| `seoDescriptionEn` | `seo.description.en`         |
| `seoDescriptionZh` | `seo.description["zh-Hant"]` |
| `seoKeywords`      | `tags.join(", ")`            |

`seoKeywords` needs a delimiter decision: nothing in the codebase parses or
splits it (`bulk-form.ts:535` only ever compares it whole against `nameEn`
for gap detection), so there's no existing convention to match. `", "` is
chosen as the plain, human-editable form an operator reviewing the file by
eye would expect.

`validateEnrichments` (`bulk-form.ts:953-1038`) already rejects blank values,
control characters, and titles over `SHOPLINE_TITLE_MAX_LENGTH` — the mapping
above needs no additional validation before calling `createBulkFormUpdate`;
its own validation is the gate, and its `ShoplineBulkFormError` is caught and
surfaced (see "Delivery result", below).

### Status gate

`evaluateDeliveryPolicy` is not reused — it is shaped around
`ShoplineProductPayload` projection and validation, neither of which applies
here. But the review-state requirement it enforces for the existing methods
is deliberately mirrored, not skipped: request-phase eligibility there is
`status === "approved" || status === "published"`
(`delivery-policy.ts:115-119`). Bulk-form export uses the same two statuses.
Exporting unreviewed AI content back toward a real SHOPLINE catalog is exactly
the failure mode approval-gating exists to prevent, and there is no reason
bulk-form export should be easier to misuse than CSV or the API path.

### Delivery result and route wiring

The existing `POST /api/listings/{id}/deliver` route already discriminates on
a `method` body field (`z.enum(["csv", "shopline_api"])`,
`deliver/route.ts:29-31`) and is gated the same way (`assertReviewer`:
`reviewer`, `admin`, or `owner` — not `operator`, which gates enrichment-batch
creation instead). Bulk-form export is a third value in that same enum, not a
new route: it is another way to deliver an approved listing, which is exactly
what that route already means.

`DeliverInput.method` widens to `"csv" | "shopline_api" | "bulk_form"`.
`DeliveryResult` gains one new member:

```ts
| { kind: "bulk_form"; body: Uint8Array; specVersion: string; versionId: string }
```

and one new failure member, for the "not linked to a remote product" case:

```ts
| { kind: "no_remote_link" }
```

`Response` accepts a `Uint8Array` body natively, so the route's response
switch gains one case:

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
case "no_remote_link":
  return jsonResponse(409, {
    code: "no_remote_link",
    message:
      "This listing has no linked SHOPLINE product; bulk-form export does not apply.",
  });
```

A `ShoplineBulkFormError` thrown by `createBulkFormUpdate` (blank value,
control characters, over-length title) is caught in the service function and
mapped to the existing `{ kind: "validation_error"; issues: string[] }`
member — the same shape CSV/API delivery already uses for a payload SHOPLINE
would reject, so the route needs no new case for it.

Audit action: `listing.bulk_form_exported`, following the existing
`{noun}_{past-participle}` convention (`listing.csv_exported`,
`listing.bulk_form_imported`). Metadata carries `specVersion`, `versionId`,
and `remoteProductId` — identifiers only, matching every other delivery audit
event; never the exported column values.

### The staleness hazard, named and accepted, not solved

`createBulkFormUpdate` echoes every non-enriched column verbatim from
`row.raw` — the raw row exactly as it stood at the listing's last import
(`bulk-form.ts:1063-1067`: `if (values === undefined || !isEnrichable(key))
return original ?? "";`). It already neutralizes the two quantity-delta
columns specifically to prevent an accidental stock movement
(`bulk-form.ts:1074-1079`), but nothing neutralizes price, warehouse, or any
other non-enriched column.

**This means an export can silently revert a price or inventory change the
merchant made directly in SHOPLINE since the listing was last imported**, the
moment the operator uploads the exported file. This hazard already existed
in the built-and-tested `createBulkFormUpdate` from the import-intake plan; it
was inert only because nothing called the function. Wiring it into a route an
operator actually uses is what makes it real.

This spec does not fix it — fixing it would mean either re-importing at
export time (a network call to SHOPLINE inside a delivery request, a scope
change this slice doesn't make) or tracking a staleness bound on
`platform_products` and refusing an export past it (a real design with its
own open questions, listed below). For this slice: **the runbook must tell
operators to re-import immediately before exporting**, and the response
should say so. This is a known, accepted risk for the pilot, not a solved
one — recorded here so it isn't rediscovered as a surprise later.

## Consequences

- The bulk-form round trip is complete: import creates reviewable drafts,
  enrichment batches fill their content gaps, and export writes the result
  back to a file the operator re-imports into SHOPLINE. Nothing in the
  pipeline changes to make this true — the three slices compose because each
  one produced exactly the artifact the next one needed.
- `createBulkFormUpdate` gets its first real caller and its first real
  parameter-type pressure, which is what surfaced the type mismatch this spec
  resolves by narrowing rather than widening.
- The staleness hazard becomes operationally real rather than theoretical.
  The runbook update is load-bearing, not optional documentation.

## Follow-ups

1. A staleness bound on `platform_products` — refuse (or warn on) export past
   some age since the row was last confirmed against SHOPLINE, rather than
   relying entirely on operator discipline.
2. Multi-listing bulk-form export — one file covering every approved,
   linked listing in a cohort, mirroring how enrichment batches already
   choose a cohort from `bulkFormGaps`.
3. Automatic re-import immediately before export, removing the operator-
   discipline dependency entirely — this is the real fix for the staleness
   hazard, deferred here because it requires a live SHOPLINE read inside a
   delivery request.

## Open questions

1. Should `published` really be an eligible status for bulk-form export?
   `evaluateDeliveryPolicy` allows it because a `published` listing can be
   re-delivered after edits. An imported listing's status realistically never
   reaches `published` in the pilot (that status is reached via the
   `shopline_api` create/publish flow, which imported listings don't go
   through) — so this may be a distinction without a practical difference
   today, kept only for consistency with the existing precedent.
2. What staleness bound, if any, would make follow-up #1 worth building for
   the pilot specifically? The design here punts this to the runbook; a real
   answer needs to know how often Opak's catalog actually changes on
   SHOPLINE's side between enrichment runs.
