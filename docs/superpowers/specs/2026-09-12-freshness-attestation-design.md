# Freshness attestation — design

Workstream W1 of the [release-gate closure plan](../plans/2026-09-11-release-gate-closure.md),
which ranks it the highest risk to the merchant in the whole plan.

## The problem, stated precisely

The plan said "a client that sends `true` satisfies it". That undersold what is
already built, and the accurate version matters, because it changes what needs
fixing.

A human **is** asked. `apps/web/components/bulk-export-panel.tsx:179-190` renders
a checkbox — "I confirm this SHOPLINE source export is still current." — and the
Generate button is disabled until it is ticked (`bulk-export-panel.tsx:195`). The
tick is bound to the selection
(`const attested = currentSelection.length > 0 && attestedSelection === currentSelection`,
`:74-75`), so changing the selection silently drops it. That is careful work.

The defect is narrower: **the attestation is made and enforced entirely in the
browser.** The request carries one boolean, hardcoded at the call site
(`bulk-export-panel.tsx:118`, `freshnessAttested: true`), and the server keeps no
record of who attested, when, or what it covered. Consequently:

- `not_attested` is unreachable from the product and reachable only by a
  non-browser caller, which is the one caller it cannot protect against.
- The attestation leaves no trace, so a UAT stage cannot cite it — and
  [`opak-uat-rollout.md`](../../runbooks/opak-uat-rollout.md) §3 makes "freshness
  and all confirmations renewed for the approved source" a Stage 1 entry
  condition.

This check is also the only judgement in its set. `version_mismatch`,
`remote_link_changed`, the row-digest comparison and the header-contract
comparison are all derived from source and genuinely enforced. Whether the
merchant's SHOPLINE export still matches their live store is not derivable at
all: only a person re-exporting can establish it. So an attestation is the right
_kind_ of thing. It just has to be real.

## What is already true, and is not being rebuilt

- `assertExportFreshness` runs its content and header-contract checks correctly.
- `export_attempts` already records `requestedBy`, a per-listing `manifest` with
  versions, `provenance` and `artifactSha256`, and already has `ENABLE`/`FORCE`
  row-level security with a workspace policy
  (`packages/db/drizzle/0014_export_attempts.sql:15-17`). A new column inherits
  tenant scoping with no new policy.
- `apps/web/lib/catalog-contract.ts:22` already exposes `contentDigest` per row,
  and `catalog-control-center.tsx:462` already iterates those rows, so the
  evidence the client must send is in scope at the call site (`:275`).
- `not_attested` is covered by tests
  (`app/api/listings/export/route.test.ts:900`, `:906`, `:1003`). It is
  unreachable, not untested.

## Decisions

1. **Purpose:** auditable evidence _and_ server-enforced. A direct API call
   without an attestation is refused.
2. **Home:** on the export attempt, as confirmed evidence. The client sends what
   it saw; the server refuses unless that matches what it is about to export.
3. **Shape:** per-listing digest evidence, because it is the only shape that
   falsifies the operator's actual claim and can name which product moved.
4. **Scope:** the export path, plus closing the latent default on the deliver
   path. No new delivery UI.

## The request contract

`freshnessAttested: boolean` is **removed**, not kept alongside. A field that is
always `true` is what made this unfalsifiable, and leaving it would let a caller
satisfy the old shape and skip the new one.

```ts
{
  listingIds: string[],                 // unchanged, now bounded (below)
  attestation: {
    listings: Array<{ listingId: string; contentDigest: string }>,
  },
}
```

Checked before any export work, in this order:

| Order | Check                                                                          | Reason on failure                                   |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1     | `attestation` is present                                                       | `not_attested`                                      |
| 2     | attested listings are exactly `listingIds` — none missing, extra or duplicated | `attestation_incomplete`                            |
| 3     | each attested `contentDigest` equals the current `link.contentDigest`          | `attestation_stale`, naming the listings that moved |
| 4     | existing content and header-contract checks                                    | unchanged                                           |

`not_attested` keeps its name and becomes genuinely reachable: it now means the
`attestation` object is absent.

### Bounding the selection

`listingIds` has no maximum today (`app/api/listings/export/route.ts:34`,
`z.array(z.string().min(1)).min(1)`). Per-listing evidence makes the payload
scale with the selection, so the request is bounded at **100**, matching the
largest attended UAT stage in the rollout runbook. The constant lives beside
`MAX_BULK_APPROVE_ITEMS` in `apps/web/lib/bulk-approve-limit.ts`, which exists
precisely so a client component and a route schema can read one number.

### Copy, and the duplicated union

`attestation_incomplete` and `attestation_stale` need bilingual copy in
`apps/web/lib/approval-ui-copy.ts`, and must be added to the reason union
restated as a comment at `apps/web/app/api/jobs/route.ts:35`. That comment is a
second copy of the union and will drift silently if missed.

## Persistence

Migration `0025` adds `source_attestation jsonb` to `export_attempts`,
**nullable**, with `CHECK (jsonb_typeof(source_attestation) = 'array')` when
present.

Nullable rather than defaulted: `NULL` means "recorded before this existed",
which is true of every historical row. A `[]` default would invent an empty
attestation for exports that never had one, and check 2 makes `[]` otherwise
unreachable.

A dedicated column rather than `provenance`: `provenance` is a free-form bag,
while this is evidence a UAT stage must cite by name and query directly.

The stored value is the evidence only — `[{listingId, contentDigest}]`.
Deliberately **not** `attestedBy` or `attestedAt`: the row already carries
`requestedBy` and its timestamp, the attestation arrives in the same request, and
two sources of truth for the actor is how they drift apart.

**It is written on refused attempts as well as successful ones.** The route
already returns `exportAttemptId` on some failures, so attempts exist for
refusals, and "they attested X, we refused because Y" is the half of the evidence
a stage review actually needs.

### The constraint this project has been bitten by

A Postgres `CHECK` is invisible to fake-repository unit tests. That is exactly
how F06's `error_code` fix passed every unit test and would have raised
`check_violation` in production. So `0025` is rehearsed twice against a real
Postgres for idempotency, and an integration test writes the column for real,
before any code depends on it.

## Audit

The attestation rides the existing `listing.bulk_form_exported` event rather than
adding one. The two are simultaneous, so a second event is noise.

Its metadata carries **counts only** — how many listings were attested, how many
mismatched. The digest list stays in the column. Digests are hashes rather than
content and would not breach the logging rule, but audit metadata stays small and
the column is the queryable record.

## Client

`BulkExportPanel`'s prop becomes
`ReadonlyArray<{ listingId: string; contentDigest: string }>`, built at
`catalog-control-center.tsx:275` from the rows the checkboxes already iterate.

This closes a second gap. `selectionIdentity` (`bulk-export-panel.tsx:45`) sorts
and joins **ids only**, so when the catalog refreshes and a row's digest changes
beneath an unchanged selection, the tick silently survives. Folding digests into
that identity drops the attestation exactly when what the operator saw stops
being true — the same guarantee the server will enforce, applied one layer
earlier, so the operator is asked again rather than refused.

## The deliver path

`app/api/listings/[id]/deliver/route.ts:160` coerces
`body.freshnessAttested === true`, so an absent field becomes `false` silently,
and `delivery-service.ts:501-504` passes that straight into `createBulkExport`.
The delivery panel offers no `bulk_form` method, so this is latent rather than
live.

The `bulk_form` branch will require an explicit attestation and refuse without
one, so wiring that method to a UI later fails loudly instead of inheriting a
`false` nobody chose.

## Testing

- **Unit:** absent attestation → `not_attested`; attested set unequal to
  requested set → `attestation_incomplete`; one stale digest → `attestation_stale`
  naming that listing.
- **Client:** the tick drops when a digest changes beneath an unchanged
  selection.
- **Integration, real Postgres:** the column is written on a refused attempt as
  well as a successful one, and the CHECK holds — the part fake repositories
  cannot see.
- **Existing suite:** `export/route.test.ts` sends `freshnessAttested` in several
  places, including three `not_attested` assertions; those migrate to the new
  shape. Expected churn.
- **End to end:** the pilot journey already ticks this checkbox and selects it by
  label text (`tests/e2e/bulk-update-pilot.spec.ts:358`), so it should pass
  unchanged. It is the one place this could surprise us, because it exercises the
  real path.

## Deployment ordering

Migration `0025` must precede the web deploy, because the application writes the
new column. That is a fourth constraint for the verification record, alongside
`0022` before the Worker, `0023`/`0024` before the Worker, and Worker before the
web producer.

## Non-goals

- **Verifying the merchant's live store.** Nothing here can. The attestation
  records a human judgement and binds it to what they saw; it does not make the
  judgement checkable.
- **An expiry window.** The integration plan's G4 mentions 24/72h thresholds. An
  attestation submitted with its own export is never stale in wall-clock terms,
  so a window would only matter under the separate-record design that was not
  chosen. If attestations later become independent artefacts, revisit it.
- **Any SHOPLINE write.** Preview stays `mock`, production stays `disabled` with
  `SHOPLINE_PUBLISH_ENABLED=false`.
- **A delivery UI for `bulk_form`.**
