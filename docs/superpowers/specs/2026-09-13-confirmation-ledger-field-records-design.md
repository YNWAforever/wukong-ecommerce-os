# Confirmation ledger: per-field records — design

Workstream W6 of the [release-gate closure plan](../plans/2026-09-11-release-gate-closure.md).
§11 of the [integration plan](../plans/2026-08-30-wukong-catalog-operations-os-integration.md)
requires the ledger to cover, per field, before/after/evidence for each of the
eight AI-writable fields, plus the negative confirmations.

Extends the ledger built by the
[Package G design](./2026-08-31-package-g-seo-review-confirmation-ledger-design.md).

## The problem, stated precisely

W6 says the stored ledger "records neither". That is true of the ledger and
misleading about the system, and the accurate version changes the size of the
work.

All three ingredients already exist:

- **After** — `listing_versions`, immutable, and already pinned by the ledger's
  `versionId`.
- **Before** — `source_row_snapshots`, retained per import. The ledger already
  stores `sourceImportId` and a whole-row `rowDigest`.
- **Evidence** — `field_evidence` (`schema.ts:404`), already keyed per
  `fieldPath` per version.

The defect is narrower: **the ledger records the reviewer's tick at row
granularity, while the confirmation is made at field granularity.** Eight
booleans say someone ticked eight boxes. Nothing says what was in front of them
for any one of them.

Two consequences decide the design:

1. `field_evidence` has **no uniqueness constraint on (version, fieldPath)** --
   only an index (`schema.ts:418`). Rows can accumulate for a field, so "the
   evidence for this field" is not a fixed set after the fact. Nothing records
   which rows existed when the reviewer ticked.
2. For most of the eight fields the merchant supplied nothing at all. A design
   assuming "before" always exists would invent a baseline.

So W6 is **smaller than "the largest item here"** implies: one additive column
and one extracted mapping, not a new table with its own RLS.

## This does not break "approval is whole-listing, never per-field"

The Package G design states that rule where it introduces the table, and it
still holds. It governs **approval granularity**: one ledger row per listing
version, and approval is never granted field by field.

Nothing here changes that. The table keeps one row per version, the new column
lives inside that row, and `approveOne` still gates on `allConfirmed` across all
fifteen items. What becomes per-field is the **evidence recorded about a
confirmation**, not the unit in which approval is given or withheld.

The distinction is worth stating because a reader of the Package G design who
meets a column named "field records" would reasonably assume the rule had been
relaxed.

## Decisions

1. **"Before" is the merchant's own value**, from the retained source row, and
   `null` where they never supplied one.
2. **Bindings and digests, not copies.** Nothing duplicates content into a
   second table.
3. **A new nullable jsonb column** on `review_confirmations`, not a child table
   and not a rewrite of the existing boolean maps.
4. **Record only.** `approveOne` is unchanged.

## What the column holds

`field_records jsonb`, nullable, keyed by `CONFIRMATION_FIELD_KEYS`:

```json
{
  "nameZh": {
    "afterDigest": "<sha256 of the confirmed value>",
    "before": { "column": "nameZh", "digest": "<sha256>" },
    "evidenceIds": ["<field_evidence.id>"]
  },
  "summaryEn": {
    "afterDigest": "<sha256>",
    "before": null,
    "evidenceIds": []
  }
}
```

**Digests are sha256 hex**, matching the `/^[a-f0-9]{64}$/` shape
`import-results.ts:58` already validates. What is digested is
`JSON.stringify(value)` of the value **as it appears in the version content** --
a quoted string for the seven text fields, and the ordered array for
`seoKeywords`. None of the eight is an object, so key ordering never arises and
the encoding is deterministic without a canonicalisation step.

It is deliberately **not** the rendered string. The review UI displays
`seoKeywords` as `tags.join(", ")`, and digesting the display form would make a
reordering of the same keywords indistinguishable from a genuine edit.

`before.column` is the source column key from `BULK_FORM_COLUMNS`, and its
digest is taken over the raw cell value in the retained
`source_row_snapshots.raw_row` -- the merchant's own text, before any parsing
this system applies to it.

**`before: null` is a recorded fact, not a missing key.** It states that the
merchant supplied nothing and the AI wrote the field from nothing. An absent key
would leave a reader guessing whether the field was unconfirmed, unmapped, or
genuinely sourceless.

**`evidenceIds` pins the set that existed at confirmation.** This is the one
part that is not merely a binding. Because `field_evidence` has no uniqueness on
(version, fieldPath), the set is not stable after the fact, so recording it is
the only way to know what was shown. An empty array states that the AI offered
no grounding for that field.

### The cost of choosing jsonb

`evidenceIds` cannot carry a foreign key, so a pinned id could in principle
dangle. `field_evidence` cascades only on version delete and versions are
immutable, so the window is narrow -- but it is the price of not adding a table,
and it is named here rather than discovered later.

### The negative confirmations stay booleans

§11 asks the ledger to cover them, but they are not fields with before/after.
Each asserts a property of the **whole row** -- price, membership, category,
status, supplier, quantity delta, images. At confirmation time no export exists
yet, so the only recordable state is the source row, which `sourceImportId` and
`rowDigest` already pin. Giving them a per-field shape would be inventing
structure to satisfy a sentence.

## The mapping moves server-side

The eight keys are mapped to a content path and an `evidenceKey` today inside
**a client component** (`listing-review-client.tsx:355-395`), where no route can
reach them.

A new leaf module, `apps/web/lib/review-field-bindings.ts`, holds that mapping;
`listing-review-client.tsx` consumes it instead of defining it, so the two
cannot drift. This is the same extraction, for the same stated reason, that
`review-confirmation-keys.ts` documents in its own header -- it was pulled out of
`confirmation-checklist.tsx` so a route could import the key lists without
pulling React into a route bundle.

A test asserts the module covers exactly `CONFIRMATION_FIELD_KEYS`, mirroring
the existing "cover the 8 AI-writable fields and 7 negative conditions" drift
test.

### What that mapping forces into the open

Of the eight keys, only `nameZh` has a corresponding bulk-form column. The
workbook carries `productId, nameEn, nameZh, sku, regularPrice, quantity,
updateQuantity` -- nothing resembling a summary, SEO title, description or
keywords. **Exactly one of eight fields will ever record a non-null `before`.**

That is a fact about the merchant's export format, not a defect, and it belongs
in the evidence rather than being discovered during a stage review.

## Write path

`POST /api/listings/[id]/review-confirmations` already holds the review snapshot
and the platform-product link, and already rejects a stale version with 409
before writing. It additionally reads the version's `field_evidence` rows and
the retained source row, computes the digests, and passes `fieldRecords` to
`upsert`.

**The client sends nothing new.** The request shape is unchanged, so unlike
W1's boolean there is nothing here a caller can fabricate: every value is
derived server-side from rows the caller does not control.

## Persistence

Migration `0027` adds `field_records jsonb`, **nullable**, with
`CHECK (field_records IS NULL OR jsonb_typeof(field_records) = 'object')`,
guarded by `conrelid` the way `0025` is.

Nullable rather than defaulted, and **not back-filled**: `NULL` means "confirmed
before this existed", which is true of every historical row. Recomputing digests
now would fabricate evidence for a review nobody performed at that time.

The column inherits the table's existing row-level security and workspace
policy; there are no policy changes.

### The constraint this project has been bitten by

A Postgres `CHECK` is invisible to fake-repository unit tests. That is how
F06's `error_code` fix passed every unit test, and how `0026`'s trigger reached
CI this week while both halves of one rule disagreed. So `0027` is rehearsed
twice against a real Postgres for idempotency, and an integration test writes
and reads the column for real, before any code depends on it.

## Audit

The existing `review_confirmation.updated` event
(`review-confirmations/route.ts:121`) gains **counts only** beside its current
`versionId` and `revision`: how many fields recorded a `before`, and how many
recorded no evidence. Digests stay in the column, which
is the queryable record; audit metadata stays small and keeps the route's
existing rule -- identifiers only, never the confirmed field content.

## Testing

- **Unit:** `nameZh` records a `before`, the other seven record `null`;
  `evidenceIds` pins the rows present for the version; a field with no evidence
  records `[]` rather than being omitted.
- **Drift:** `review-field-bindings.ts` covers exactly
  `CONFIRMATION_FIELD_KEYS`, and each `evidenceKey` is one the review response
  actually emits.
- **Integration, real Postgres:** the column is written and read back, and the
  CHECK holds -- the part fake repositories cannot see.
- **Existing suite:** the `review-confirmations` route and repository tests gain
  the new column; `allConfirmed` and the approval path are untouched, so their
  tests should not move. Any that does is a signal the change leaked past its
  scope.

## Deployment ordering

`0027` must precede the web deploy, because the application writes the new
column. That is a fifth constraint for the verification record, alongside `0022`
before the Worker, `0023`/`0024` before the Worker, `0025` before the web
deploy, and Worker before the web producer.

## What this deliberately does not claim

The record is evidence about the confirmed version and its source -- **not a
transcript of the reviewer's screen.** The review UI does not currently render
the merchant's prior value, so recording a `before` does not mean the reviewer
read it. Naming the column after what the reviewer saw would be the same
overclaim W1 existed to remove.

## Non-goals

- **No approval-gate change.** `approveOne` keeps gating on the booleans and the
  existing version/digest binding, which works today.
- **No back-fill** of historical rows.
- **No new table**, and no rewrite of the existing boolean maps.
- **No UI change.** The reviewer's screen is unchanged.
- **No per-field shape for the negative confirmations.**
- **No SHOPLINE write.** Preview stays `mock`, production stays `disabled` with
  `SHOPLINE_PUBLISH_ENABLED=false`.
