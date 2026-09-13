# Confirmation ledger: per-field records — design

Workstream W6 of the [release-gate closure plan](../plans/2026-09-11-release-gate-closure.md).
§11 of the [integration plan](../plans/2026-08-30-wukong-catalog-operations-os-integration.md)
requires the ledger to cover, per field, before/after/evidence for each of the
eight AI-writable fields, plus the negative confirmations.

Extends the ledger built by the
[Package G design](./2026-08-31-package-g-seo-review-confirmation-ledger-design.md).

## Corrections to the approved draft

Writing the implementation plan meant reading the code each claim rests on, and
four claims in the first draft (`91dcbde`) did not survive it. They are
corrected here rather than silently rewritten.

1. **All eight confirmation keys are bulk-form columns.** The draft said only
   `nameZh` was, and that exactly one of eight fields would ever record a
   `before`. `BULK_FORM_COLUMNS` (`packages/shopline/src/bulk-form.ts`) carries
   `nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`,
   `seoDescriptionEn`, `seoDescriptionZh` and `seoKeywords` under exactly those
   names -- the confirmation keys _are_ the column keys. The draft mistook the
   seven cells a synthetic test fixture populates for the column set.
2. **Evidence ids are not stable, so the record pins evidence content.**
   `replaceEvidence` (`listings.ts:1093`) deletes and re-inserts, and its callers
   copy evidence forward onto a newly appended version under fresh ids. The
   draft's `evidenceIds` is replaced by `evidenceDigest`. That also removes the
   dangling-reference problem the draft named as the cost of choosing jsonb.
3. **The keywords rationale.** The draft said digesting the joined display
   string would hide a reordering. It would not -- `"a, b"` and `"b, a"` differ.
   The real defect is that joining is not injective: one keyword containing a
   comma and two separate keywords join to the same string.
4. **Where "before" is read, and the verb.** The route is `PATCH`, not `POST`.
   "Before" is read from `platform_products.rawRow` -- the row whose
   `contentDigest` the ledger already stores as `rowDigest` -- so the new binding
   and the existing one describe the same row, with no separate snapshot read.

Also found: the deployment-ordering record never listed `0026`, shipped this
week. It is now listed beside `0027`.

## The problem, stated precisely

W6 says the stored ledger "records neither". That is true of the ledger and
misleading about the system, and the accurate version changes the size of the
work.

All three ingredients already exist:

- **After** — `listing_versions`, immutable, and already pinned by the ledger's
  `versionId`.
- **Before** — `platform_products.rawRow`, the imported row. The ledger already
  stores its `sourceImportId` and `contentDigest`; `source_row_snapshots` keeps
  each import's copy.
- **Evidence** — `field_evidence` (`schema.ts:404`), keyed per `fieldPath` per
  version, and already returned by `getReviewSnapshot`.

The defect is narrower: **the ledger records the reviewer's tick at row
granularity, while the confirmation is made at field granularity.** Eight
booleans say someone ticked eight boxes. Nothing says what was in front of them
for any one of them.

Two facts decide the design:

1. **Evidence is replaced, not appended.** An evidence id identifies a row, not
   the grounding it carries: the same grounding copied onto a new version gets
   a new id, and a re-run replaces the rows outright. Pinning ids pins nothing
   durable; pinning a digest of the grounding does.
2. **"Before" must be able to say "nothing supplied".** A merchant may leave any
   of the eight cells blank, and a listing created in this system has no
   imported row at all. Recording `null` states that without inventing a
   baseline.

So W6 is **smaller than "the largest item here"** implies: one additive column
and one extracted mapping. No new table, no new RLS, and no new repository read
of evidence or source rows.

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

1. **"Before" is the merchant's own value**, from the imported row, and `null`
   where the listing has no imported row or the cell is blank.
2. **Digests, not copies.** Nothing duplicates content into a second table.
3. **A new nullable jsonb column** on `review_confirmations`, not a child table
   and not a rewrite of the existing boolean maps.
4. **Record only.** `approveOne` is unchanged.

## What the column holds

`field_records jsonb`, nullable, keyed by `CONFIRMATION_FIELD_KEYS`:

```json
{
  "nameZh": {
    "afterDigest": "<sha256>",
    "before": { "column": "nameZh", "digest": "<sha256>" },
    "evidenceDigest": "<sha256>"
  },
  "summaryEn": {
    "afterDigest": "<sha256>",
    "before": null,
    "evidenceDigest": null
  }
}
```

**Every digest is sha256 hex of a JSON encoding**, matching the
`/^[a-f0-9]{64}$/` shape `import-results.ts:58` already validates.

- **`afterDigest`** — `JSON.stringify` of the value as stored in the version:
  a string for seven fields and the ordered array for `seoKeywords`. None of the
  eight is an object, so key order never arises. It is deliberately **not** the
  joined display string the review UI shows for keywords, because joining is
  not injective: `["a, b"]` and `["a", "b"]` both display as `a, b`.
- **`before`** — `{ column, digest }`, where `column` is the bulk-form column
  key (identical to the field key) and `digest` is taken over the cell **with
  leading and trailing whitespace removed**. Content is stored through
  `z.string().trim()`, so the confirmed value never carries surrounding
  whitespace, and digesting the raw cell would make a padded cell the merchant
  never changed read as changed. Interior whitespace is kept, because content
  allows it and collapsing it could hide a real edit. `null` when the listing
  has no imported row, or the cell is empty or whitespace.
- **`evidenceDigest`** — the grounding the AI offered for the field: every
  evidence entry whose `field` equals the field's evidence key, reduced to
  `sourceAssetId`, `page`, `excerpt` and `confidence`, each encoded on its own
  and **sorted** before digesting. `getReviewSnapshot` reads evidence with no
  `ORDER BY`, and the same grounding arriving in a different order must not
  look changed. `null` when there is none.

For the seven text fields, **`before.digest` equal to `afterDigest` means the
confirmed value is the merchant's cell exactly, ignoring leading and trailing
whitespace** -- readable from the record without seeing either value. Nothing is
Unicode-normalised: equality means identical code points, because folding
full-width punctuation or CJK compatibility ideographs would hide a difference a
storefront visibly shows. Unequal digests mean the values differ in some code
point; on their own they do not show a meaningful edit.

**`seoKeywords` is the exception.** Its cell is a joined string and its content
an array, so its `before` records provenance only and its digests are never
comparable. Splitting the cell back into an array is not safe: joining is not
injective, which is why the array is digested in the first place.

### The negative confirmations stay booleans

§11 asks the ledger to cover them, but they are not fields with before/after.
Each asserts a property of the **whole row** -- price, membership, category,
status, supplier, quantity delta, images. At confirmation time no export exists
yet, so the only recordable state is the source row, which `sourceImportId` and
`rowDigest` already pin. Giving them a per-field shape would be inventing
structure to satisfy a sentence.

## Where the mapping lives

Two maps from these fields to content already exist, and neither can be used as
it stands:

- **`listing-review-client.tsx`'s field descriptors** are in a client component,
  and three of their keys differ from the confirmation keys: `titleZhHant`,
  `descriptionEn` and `descriptionZhHant` for `nameZh`, `summaryEn` and
  `summaryZh`.
- **`canonical-listing-gaps.ts`** is server-safe and uses the confirmation keys,
  but omits `seoDescriptionZh` and reads keywords as the joined string -- correct
  for the gap checks it serves, wrong for a digest.

A new leaf module, `apps/web/lib/review-field-bindings.ts`, holds a reader and
an evidence key per confirmation key. `listing-review-client.tsx` imports its
evidence keys for those eight descriptors, so the UI and the ledger cannot drift
apart. `canonical-listing-gaps.ts` is left alone; it answers a different
question.

Hashing lives in a separate server-only module,
`apps/web/lib/review-field-records.ts`, because the client component imports
the bindings and must not pull `node:crypto` into its bundle.

## Write path

`PATCH /api/listings/[id]/review-confirmations` already holds the review
snapshot -- parsed content and evidence -- and the platform-product row with its
`rawRow`, and already rejects a stale version with 409 before writing. It builds
the records from those and passes them to `upsert`.

**The client sends nothing new.** The request schema is strict and unchanged,
so a request carrying its own records is refused with 400. Unlike W1's boolean,
nothing here can be supplied by a caller.

## Reading it back

`getByVersionId`, and the rows `upsert` returns, keep their current shape. Six
callers read that shape, and `GET /api/listings/[id]` returns it to the browser;
none of them needs the record. A narrow `getFieldRecordsByVersionId` reads the
column on its own.

## Persistence

Migration `0027` adds `field_records jsonb`, **nullable**, with
`CHECK (field_records IS NULL OR jsonb_typeof(field_records) = 'object')`,
guarded by `conrelid` the way `0025` is.

**Not back-filled.** `NULL` means "confirmed before this existed", true of every
historical row, and recomputing digests now would fabricate evidence for a
review nobody performed at that time.

**A revision written without a record stores `NULL`.** The record describes the
revision it was written with, so an update carrying none clears it rather than
leaving the previous revision's record looking current.

The column inherits the table's existing row-level security and workspace
policy; there are no policy changes.

### Rehearsal, and the constraint this project has been bitten by

A Postgres `CHECK` is invisible to fake-repository unit tests. That is how F06's
`error_code` fix passed every unit test, and how `0026`'s trigger reached CI
this week while both halves of one rule disagreed.

The dedicated migration-rehearsal harness drops the schema and needs its own
database URLs, so it is skipped in CI. `0027` is therefore rehearsed where CI
runs it: an integration case re-runs `migrate()` against the shared test
database and re-checks the column and constraint, and another writes a
non-object value and expects the constraint to refuse it.

## Audit

The existing `review_confirmation.updated` event
(`review-confirmations/route.ts:121`) gains two counts beside `versionId` and
`revision`: `fieldsWithSource` and `fieldsWithoutEvidence`. Digests stay in the
column; audit metadata stays small and keeps the route's rule -- identifiers and
counts, never confirmed content.

## Testing

- **Bindings:** the module binds exactly `CONFIRMATION_FIELD_KEYS`, in order,
  and each reader returns the value at its own path.
- **Records:** every field is recorded; `before` is the digest of the cell,
  `null` for a blank cell and for a listing with no imported row; equal digests
  signal an unchanged value; keywords that join identically still digest
  differently; the same evidence in a different order gives the same digest.
- **Route:** records are derived from the snapshot and the imported row, a
  request carrying its own records is refused with 400, the response shape is
  unchanged, and the audit event carries the counts.
- **Integration, real Postgres:** the column is written and read back, a
  repeated `migrate()` leaves it intact, the CHECK refuses a non-object, an
  update without a record clears it, and another workspace cannot read it.
- **Existing suite:** `allConfirmed`, the approval path and every
  `getByVersionId` caller are untouched, so their tests should not move. Any
  that does is a signal the change leaked past its scope.

## Deployment ordering

`0027` must precede the web deploy, because the application writes the new
column. The verification record gains two constraints: `0027`, and `0026`, which
was owed -- the export route writes provenance the pre-`0026` trigger refuses.

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
- **No change to `canonical-listing-gaps.ts`.**
- **No SHOPLINE write.** Preview stays `mock`, production stays `disabled` with
  `SHOPLINE_PUBLISH_ENABLED=false`.
