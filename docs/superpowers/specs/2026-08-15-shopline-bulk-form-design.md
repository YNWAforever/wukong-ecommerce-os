# Shopline Bulk Update Form Round-Trip Design

**Date:** 2026-08-15
**Status:** Approved for implementation; implemented in `packages/shopline/src/bulk-form.ts`.

## Context

Every listing Wukong has produced so far was *created* from messy inputs: photos,
a supplier sheet, an operator note. The pilot merchant's actual catalog problem
is the opposite shape. Opak Cellar already has 500 products live on Shopline,
and Shopline's own round-trip artifact for that catalog is the **bulk update
form**: export xlsx → edit cells → re-import, keyed by `Product ID (DO NOT
EDIT)`.

That artifact is different from the export this repo already emits.
`packages/shopline/src/csv.ts` produces a 15-column **create** form (spec
`opak-2026-07`) carrying descriptions and image URLs. The bulk update form has
**71 columns**, carries no description or image column at all, and adds
everything the create form omits: dual pricing, four membership tiers,
hierarchical categories, POS categories, cost, weight, supplier, barcode, MPN,
preorder fields, separate online/retail publish status, payment and delivery
exclusions, and a full variant block.

The two forms are not versions of one thing. They are different directions:
create pushes new products out; the bulk form is the only supported way to
*read the existing catalog in* and to write enrichment *back onto products
Shopline already owns*.

The domain term **Shopline bulk form** is recorded in `CONTEXT.md`.

### What the merchant's real export contains

Profiled from Opak's 2026-05-21 export (500 products × 71 columns) using the
`bulk-form:profile` CLI in this package. These numbers set the product case and
they also set the parser's obligations. Text comparisons trim surrounding
whitespace, which is what `gaps` computes:

| Observation | Count | Consequence |
|---|---|---|
| Traditional Chinese name identical to English | 499/500 | The catalog is not localized at all |
| Traditional Chinese SEO title identical to the English one | 487/500 | — |
| SEO keywords identical to the product name | 478/500 | Keywords carry no information |
| SEO description identical to SEO title | 407/500 | SEO fields are placeholders |
| SEO title identical to the product name | 392/500 | — |
| Product Summary empty | 489/500 | Descriptions are greenfield |
| Quantity at zero or below | 342/500 | Dead stock dominates (338 at 0, 4 oversold) |
| Hidden from the online store | 275/500 | — |
| Visible in the retail store | 249/500 | — |
| Product Cost > 0 | 493/500 | Margin analysis needs no new data |
| Sale price below regular price | 439/500 | — |
| No product type derivable from the category path | 36/500 | Merchandising-only rows need `extract` |

A full parse of that file produces **500 rows, zero errors, and seven
warnings**: four `quantity_negative`, two `categories_missing`, and one
`quantity_unlimited_sentinel`. Every warning is one of the structural facts
below.

The catalog is whisky-dominant (278/500), then Red Wine, Party Selection,
Spirits/Fortified, White Wine, Champagne, Sparkling, Plum Wine, Sake.

### Structural facts the parser must survive

Each of these is present in the real file, and each one breaks a naive reader:

1. **Two header rows.** Row 1 is the English contract, row 2 is the
   Traditional Chinese label for the same column. Data starts at row 3. A
   reader that assumes one header row ingests the Chinese labels as a product.
2. **SKUs are leading-zero strings.** All 500 look like `0013`. Any reader that
   lets a spreadsheet engine type them as numbers silently destroys every SKU
   in the catalog. This is the single highest-consequence parsing rule here.
3. **`無限數量` appears in a numeric column.** Row 437's `Quantity (DO NOT
   EDIT)` holds that literal instead of an integer. The same row also has
   `Unlimited Quantity = Y`, so the sentinel is consistent and means unlimited,
   not corrupt.
4. **Negative quantities exist.** Four rows carry `-1` (oversold). The
   canonical `listingFactsSchema.stockQuantity` is `nonnegative`, so a direct
   map throws.
5. **Newlines in the category cell are multi-category assignment, not dirty
   data.** 26 cells hold two complete category paths separated by `\n`, e.g.
   `Champagne>Non-Vintage Champagne>Rose` and `Party Wines
   Selection>Party Champagne Selection`. Stripping or collapsing the newline
   destroys a category assignment. Category paths run up to depth 5.
6. **`Update Quantity` is a delta column, not a value column.** Every row reads
   `+0`. A round-trip that echoes a non-zero delta re-applies a stock movement
   on every re-import.
7. **Variants are entirely unused** (0/500 rows carry a Variant ID) and every
   `Weight(KG)` is `0.0`. Logistics data is genuinely absent rather than
   unparsed.
8. One row has no barcode; two rows have no category.

## Goals

- Parse a Shopline bulk update form into typed, workspace-neutral product rows
  without losing a single cell, so the raw row can be snapshotted and diffed.
- Preserve `Product ID` as the platform join key Wukong currently lacks — today
  a remote product ID exists only on `publish_jobs.remoteProductId`, never on
  the listing.
- Prefill `ListingFacts` with values the form *states*, so the existing
  extract/generate pipeline starts from real data instead of a blank draft.
- Report every defensive-parsing case as a typed issue rather than throwing,
  guessing, or silently dropping a row.
- Emit a re-importable 71-column update form keyed by Product ID in which only
  explicitly enriched columns differ from the source, with a per-cell change
  list suitable for an audit event.
- Keep the module dependency-free and runtime-agnostic so it runs in the
  Worker, in a route handler, and in tests without binary fixtures.

## Non-goals

- **No inference from prose.** The parser does not read vintage, volume, ABV,
  producer, or grape varieties out of product names. That is the `extract`
  step's job, and `extract` produces per-field evidence that a regex cannot.
- **No geography from the category path.** Segment 2 looks like a country for
  Whisky, Red Wine, and White Wine, but the same position holds
  `Independent Bottlers (IB)`, `Irish`, `Cognac`, `1.8L Large Format`, and
  `Gin` elsewhere in the same file. The rule does not hold, so `country` and
  `region` stay null and the structured category paths are exposed instead.
- No database schema change. The `platform_products` link table that will
  persist the Product ID join and the raw-row snapshot is a separate slice.
- No variant support. Opak uses zero variants; variant columns are echoed
  verbatim and never enriched.
- No stock, price, category, or status writes. The enrichable surface is
  content only.
- No live Shopline calls; this module never performs I/O.

## Chosen design

### One column contract, three column classes

`BULK_FORM_COLUMNS` is a 71-entry ordered tuple, each entry carrying a stable
`key`, the exact English header, and the exact Traditional Chinese header. It
is the single source of truth for column addressing, contract verification, and
header emission, so the parser and the emitter cannot drift apart.

Columns fall into three classes:

- **Locked** — the ten columns whose header says `DO NOT EDIT` (`productId`,
  `quantity`, `variantId`, `variantEn`, `variantZh`, `variantQuantity`,
  `slStockId`, `warehouse`, `slKey0`, `slKey1`). Echoed byte-identically;
  enriching one is a hard error.
- **Enrichable** — the eight content columns Wukong is allowed to write:
  `nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`,
  `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`. This whitelist is the
  blast radius of the entire catalog-takeover phase.
- **Echoed** — everything else: pricing, stock, categories, status, logistics.
  Read and exposed, never written.

`nameEn` is deliberately *not* enrichable. Rewriting the English product name
changes the merchant's product identity and their operators' search handle;
only the untranslated Chinese name is Wukong's to fill.

### Parsing is a total function over a cell matrix

`parseBulkForm(sheet)` takes `readonly (readonly (string | null)[])[]` and
returns a result. It never throws. The cell matrix boundary is what keeps the
module pure: tests construct matrices literally, the Worker can parse a matrix
it received over a queue, and no binary fixture is committed.

Header location is by content, not position: the first row matching the English
contract is the header row, and the row immediately after it is skipped when it
matches the Traditional Chinese contract. A file whose columns do not match the
contract yields a `column_contract_mismatch` error and no rows, because
addressing cells by position in an unknown layout is how catalogs get
corrupted.

Row-level problems are typed issues with a severity:

- **error** — the row has no usable identity (`product_id_missing`,
  `product_id_duplicated`, `sku_missing`). The row is excluded from `rows` and
  reported.
- **warning** — the row is usable but something was normalized
  (`quantity_unlimited_sentinel`, `quantity_negative`, `number_not_numeric`,
  `flag_not_recognized`, `categories_missing`, `variant_row_ignored`,
  `quantity_delta_not_neutral`, `row_too_short`). The row is kept.

`row_too_short` is a warning rather than an error because worksheets omit
trailing empty cells: a 40-cell row in a 71-column form means 31 trailing
blanks, not a broken layout. The header contract check has already proven the
column alignment by that point, so the missing cells read as empty. Treating
this as an error silently dropped every round-tripped row whose tail was blank.

Quantity resolution, in order: `Unlimited Quantity = Y` or the `無限數量`
sentinel means unlimited, represented as `stockQuantity: null` — which is
exactly what the existing Shopline projection reads as `unlimited_quantity:
true`. A negative quantity clamps to `0` and warns. Anything else parses as an
integer, and an unparsable value warns and yields `null`.

Price resolution: `priceHkd` is the sale price when it is greater than zero,
otherwise the regular price. 24 rows carry a `0.0` sale price meaning "not on
sale", so treating zero as a price would give away the catalog.

### Facts prefill carries only what the form states

The `ListingFacts` prefill fills `sku`, `priceHkd`, `stockQuantity`,
`packQuantity`, and `productType`; everything else is `null` or empty for
`extract` to fill with evidence. `productType` is derived from the top segment
of the category path through an explicit lookup over the 17 top-level
categories observed in the file, evaluating each of a row's paths in order and
taking the first that maps — so a product filed under both
`Champagne>…` and `Party Wines Selection>…` resolves as wine rather than as a
merchandising bucket. Unmapped tops yield `null`.

Alongside the facts, each row exposes a `gaps` block — `untranslatedName`,
`seoTitleMirrorsName`, `seoDescriptionMirrorsSeoTitle`, `keywordsMirrorName`,
`untranslatedSeoTitle`, `summaryMissing`. These are the six pathologies the
profile above quantified, computed per row. They are what makes the catalog
hygiene report and the enrichment cohort selection cheap, and they let a batch
job target only the rows that need a given fix.

### Emission is a diff, not a regeneration

`createBulkFormUpdate(rows, enrichments)` returns the header rows, the selected
data rows, a per-cell `changes` list, and the row numbers whose quantity delta
was neutralized. Rules:

- Every non-enriched cell is echoed from the parsed raw snapshot, so a
  round-trip through Wukong is a no-op on 63 of 71 columns.
- `updateQuantity` and `updateVariantQuantity` are forced to `+0` regardless of
  the source value, and any row that carried something else is reported. This
  is the one place the emitter overrides the source, because echoing a stock
  delta re-applies it on import.
- The default `include` mode is `"changed"`: rows with no enrichment are left
  out of the file entirely. A smaller file is a smaller blast radius, and
  Shopline treats absent rows as untouched.
- Invalid enrichment throws `ShoplineBulkFormError` before any cell is written,
  mirroring `createShoplineCsv`'s "never emit a file the platform would
  reject". Rejections: unknown Product ID, duplicate enrichment, a locked or
  non-enrichable target column, a blank value, a title over
  `SHOPLINE_TITLE_MAX_LENGTH`, control characters, and an empty enrichment set.

Control characters — including newlines — are rejected in *enriched* values
while being preserved in *echoed* ones. That asymmetry is deliberate: the
category column's newlines are meaningful and must survive, but a generated SEO
description containing a newline is a defect that would corrupt the cell.

### The xlsx boundary is a separate adapter

`bulk-form.ts` has no I/O and no dependencies. `bulk-form-xlsx.ts` is a thin
Node adapter that converts bytes to a cell matrix and back: a ZIP reader over
`node:zlib`, a targeted worksheet XML scan, shared-string and inline-string
support, and a writer that emits stored ZIP entries with `t="inlineStr"` cells.

Every cell is written as an inline string and read as text. That is the
mechanical guarantee behind rule 2 above: `0013` cannot become `13` if no cell
is ever typed as a number. Newlines and carriage returns are written as numeric
character references so multi-path category cells survive XML normalization.

The adapter is Node-only and the pure module is not, which is the point — the
Worker can act on a matrix without linking a ZIP reader.

## Consequences

- Wukong gains its first ingestion path for *existing* platform listings, and
  the Product ID that path carries is the join key the schema has been missing.
- The enrichable whitelist bounds catalog-takeover risk to eight content
  columns before any of it runs against a live store.
- `gaps` turns the profile in this document into a per-row query, so the
  hygiene report and the enrichment cohort are derived rather than hand-picked.
- The pure/adapter split means the round-trip is testable without committing a
  single row of merchant data.

## Follow-ups

1. `platform_products` link table (workspace, connection, remote product ID,
   SKU, raw-row snapshot, content digest) with the composite-FK pattern, so
   create-vs-update can be decided per product.
2. An `imported` intake path that turns parsed rows into drafts.
3. Batch enrichment over imported drafts with per-batch cost caps.
4. Wiring `updateProduct` into publish for the API path.

## Open questions

1. Does Opak's Shopline plan include OpenAPI product-write scopes? If not, the
   bulk form is the only write path and this module is the delivery mechanism
   rather than a fallback.
2. Membership price tiers are all `0.0` in the export but the storefront runs a
   points programme. Confirm tier pricing is out of pilot scope before any
   pricing column becomes enrichable.
3. Should `nameEn` ever become enrichable behind an explicit operator opt-in,
   for the products whose English name is itself a placeholder?
