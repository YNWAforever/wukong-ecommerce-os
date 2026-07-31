# Pilot end-to-end via CSV — design

Date: 2026-07-30
Status: accepted

## Goal

One real Opak wine travels the whole chain and lands in SHOPLINE:

```
photo → AI draft → review → approved → CSV → imported into Opak's live store as an
unpublished product, verified correct, then removed
```

The phase is finished when that product exists in SHOPLINE with the right fields
**and its images resolve**. Anything short of a successful import does not count,
because the CSV format is the one link never tested against reality.

## Where the pilot actually stands

Working in production: sign-in, dashboard, photo upload to R2, draft creation.

Not working: everything after draft creation. The Cloudflare Worker has never been
deployed, and `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` are unset in Vercel, so
the pipeline cannot be reached. Drafts are created and correctly fall back to
`retry_required`.

There is no way around this. `packages/core/src/workflow.ts` allows exactly one
transition out of `received` — `start_processing`. A listing cannot reach a
reviewable or deliverable state without the pipeline running, so an operator cannot
hand-fill a draft and export it. The Worker is a hard gate for this phase, even
though CSV export itself is synchronous and web-side.

SHOPLINE stays CSV-only. `SHOPLINE_ADAPTER` already defaults to `disabled` and
production sets it explicitly, so the API connector is off and nothing in this phase
turns it on.

## Two unknowns, deliberately separated

1. **Does the pipeline work in production?** Configuration only — no code change can
   settle it.
2. **Is the CSV spec right?** `SHOPLINE_CSV_SPEC_VERSION = "opak-2026-07"` was
   designed but never validated against SHOPLINE's importer. Getting it wrong
   requires a _code_ change.

Running them together makes a failed import ambiguous. Validating the CSV first
retires the unknown that cannot be fixed by configuration, and proceeds in parallel
with the Cloudflare work.

## Tracks

**Track 1 — validate the CSV spec (no infrastructure required).**
A committed script builds a representative Opak wine payload, runs it through
`validateShoplineProducts` and `createShoplineCsv`, and writes a file. Import it into
Opak's store as an unpublished product, confirm the 15 columns land in the right
fields, delete it.

The script is committed rather than throwaway because the spec will need
re-validating whenever it changes; `opak-2026-07` will not be the last version. It
reuses the payload fixtures already in `csv.test.ts` so the harness and the tests
cannot drift.

**Track 2 — deploy the Worker (parallel with Track 1).**
Create the four production queues and the Hyperdrive config, set the five Worker
secrets, deploy, then set `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` in Vercel and
redeploy. `SHOPLINE_TOKEN_ENCRYPTION_KEY` and the two shopline queues are required by
the secret preflight and the rendered bindings, but stay inert under CSV-only
operation — a generated placeholder is correct for the key.

**Track 3 — the end-to-end run (after both).**
One real wine, photo through to import. Because Track 1 has already proved the
format, a failure here is attributable to the pipeline rather than the CSV.

## The image expiry defect

`packages/assets/src/s3-asset-store.ts:79` presigns reads for ten minutes. The CSV's
`Images` column carries those signed URLs, and SHOPLINE fetches them when it processes
the import. A human downloads the CSV, opens SHOPLINE and uploads it — a sequence that
routinely exceeds ten minutes. **The images 403 and the product imports without
pictures.**

Ten minutes was correct for the API integration, where the fetch happened immediately.
The CSV-first pivot introduced a human into the middle of that window and invalidated
the assumption.

**Fix:** the read-presign call takes an explicit lifetime. The CSV delivery path
requests **seven days**; upload presigning and in-app image previews keep the existing
ten minutes. Scoping it to the export boundary keeps the difference visible at the call
site instead of buried in a shared constant, and avoids widening exposure for reads
that do not need it.

Seven days is chosen because it is the maximum available, and any shorter value trades
operator convenience for an exposure reduction that is negligible on unpublished wine
photos. If that trade ever changes, the value is a single constant at one call site.

**Constraint:** SigV4 presigned URLs cap at seven days. That is a ceiling, not a
choice. An operator sitting on a CSV for longer must re-export; this belongs in the
operator runbook rather than being engineered around.

**Accepted exposure:** anyone holding the CSV can fetch those images for the lifetime
of the URL. For unpublished wine photos this is acceptable, and it preserves the
runbook's rule that every bucket stays private.

## What is already right

The projection hardcodes `status: false` (`packages/shopline/src/projection.ts:57`), so
imports land unpublished. Draft-import safety is built in and needs nothing added.

## Verification

At the SHOPLINE end: all 15 columns in the right fields, both `en` and `zh-hant`
variants present, images resolving, product unpublished. Then delete the test product
— cleanup is part of the phase, not an afterthought.

Poor AI output is explicitly **not** phase-blocking. The review UI exists so the
operator corrects fields before approving; a mediocre first draft is the system working
as designed.

## Testing

One unit test asserting the export path requests the long lifetime and the in-app path
still requests the short one. That is the regression that matters, because the defect
was a single constant serving two different needs.

Existing CSV tests must pass unchanged. No new integration tests — the SHOPLINE import
is verified by hand, once, by definition.

## Out of scope

Direct SHOPLINE API integration, multi-operator access, batch export, and any change to
the `received → start_processing` workflow. Making `SHOPLINE_TOKEN_ENCRYPTION_KEY` and
the shopline queues genuinely optional is worth revisiting if CSV-only becomes
permanent, but not while a deployment is in flight.

## Risks

- **The CSV spec is wrong in a way Track 1 does not catch.** The harness exercises one
  representative payload; a field that only appears for some wines could still fail.
  Mitigated by running the Track 3 wine through the same verification checklist.
- **Opak's store settings differ from assumptions** — currency, categories, custom
  fields. Track 1 surfaces this early, against the real store, which is why the live
  store was chosen over a test store.
- **Junk products in a live store.** Every import in this phase is unpublished and
  deleted after verification.
