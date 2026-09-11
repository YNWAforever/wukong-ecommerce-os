# Wukong remediation — implementation status

Branch `codex/listing-grounding-diagnosis`. Baseline: HEAD was `9f72a37`, the
same commit the audit examined, so **no newer work supersedes any finding** —
"already fixed" can only mean the audit misread the source, never that a later
commit fixed it.

Companion records: [decisions](./wukong-remediation-decisions.md) ·
[verification](./wukong-remediation-verification.md)

## Phase 0 — diagnosis

**G0: partially met.** A reproducible source-level failure path is established
with deterministic offline tests. The historical run is **not** attributed, and
must not be reported as attributed.

### The failure path, reproduced

`assertFactsGrounded` required every non-null fact to appear verbatim inside one
of its own evidence excerpts. That is satisfiable by the synthetic note the
provider fixtures use (`product type wine; country Germany; volume 750 ml`) and
unsatisfiable by a photographed label. Since `ProviderOutputError` is in
`isTerminalProviderError`, a _correct_ extraction of a real label terminalized
the listing to `failed` on the first delivery — no retry, no dead-letter, the
consumer acks — and discarded every fact extracted alongside the rejected one.

Rejection paths confirmed by test, each a legitimate extraction:

| Case                                   | Why it was rejected                                        |
| -------------------------------------- | ---------------------------------------------------------- |
| `productType: "wine"`                  | A four-value enum classification; no label prints the word |
| `volumeMl: 750` from `75 cl`           | Unit conversion; 750 is not a number in the excerpt        |
| `country: "France"` from `法國`        | Translation; the value cannot quote itself                 |
| `abvPercent: 13.5` from `13,5 % vol.`  | Tokenizes to 13 and 5; neither equals 13.5                 |
| `field: "abv"`                         | Evidence field names were never given to the model         |
| `Chateau Margaux` vs `CHÂTEAU MARGAUX` | NFKC composes accents rather than stripping them           |

### What is NOT established

The observed run `3b958fe6-64e3-44bb-ac0c-13fa38ae60a3` **cannot be attributed
from source**. An independent adversarial review of six candidate failure paths
corrected every alternative down to low or ruled-out and left this one at
"medium" — disputing attribution of the historical run, not the mechanism.

One constraint does narrow it: the incident reported status `failed`, which
requires a thrown error. A `needs_info` outcome renders different copy, so the
missing-merchant-data path alone does not explain what was seen.

**To attribute it, this is the exact evidence needed:**

```sql
select r.status, r.error_code, r.result_status, s.step, s.state
from listing_pipeline_runs r
left join listing_pipeline_steps s on s.pipeline_run_id = r.id
where r.listing_id = 'ffc23109-7205-4d4d-b429-ca77706a239f';
```

Plus the Worker log line for that delivery, and the deployed Worker's configured
listing model — the source default is `gpt-5.6-terra`, and whether the deployed
model accepts image input was not readable from here.

## Audit findings at HEAD

Twelve of fourteen reproduce. None were already fixed.

| ID                                           | Status             | Addressed here                                                                                                        |
| -------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| F04 normalization                            | still_reproducible | **fixed** — `b68210d`, `d1af2a7`                                                                                      |
| F03 needs_info / failed dead end             | partially_fixed    | **fixed** — `1b69c36` (failed) and the re-run work below (needs_info)                                                 |
| F02 null facts block generation              | still_reproducible | **fixed** — generation gates on product identity, not on every null fact                                              |
| F01 empty-body CRC32 on presign              | still_reproducible | **fixed** — presign pinned to `WHEN_REQUIRED`, covered by a real-SDK test                                             |
| F05 no idempotency in intake                 | still_reproducible | **create half fixed** — a replayed create returns the same listing; per-file upload retry still re-uploads everything |
| F07 four disagreeing media policies          | still_reproducible | **fixed** — one browser-safe policy leaf shared by form, presign, finalize and create                                 |
| F10 draft save requires canonical            | still_reproducible | **fixed** — save accepts reviewable; canonical enforced at the delivery gate                                          |
| F13 second file selection replaces the first | still_reproducible | **picker and error copy fixed** — selections accumulate, and a refused action now names the conflict that refused it  |
| F06 create never starts image work           | still_reproducible | **fixed** — create dispatches image work, and a shot the Worker will never run now ends instead of queueing for ever  |
| F12 doctor passes while misconfigured        | partially_fixed    | **fixed** — the false greens are gone, and what each surface requires is written down and checked against the source  |
| F08 batches enqueue at sequence 0            | still_reproducible | **fixed** — a wave is recorded before it is sent, so an interrupted advance is recoverable rather than lost           |
| F14 batch cost is all-history                | still_reproducible | **fixed** — a batch's budget counts only its own spend, and a claim with no evidence behind it is flagged             |
| F09 approve without a dirty guard            | still_reproducible | **client guard fixed** — approval blocks on unsaved edits and says why; server freshness was already version-id based |
| F11 no external enrichment stage             | **not_a_defect**   | no — and deliberately not attempted; see below                                                                        |

## Delivered

| Commit             | What a user can now do                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `5b00f91`          | — (reproduction tests; Phase 0 evidence)                                                                                |
| `b68210d`          | A real label extracts without being rejected for converting a unit, translating a country, or classifying a type        |
| `1b69c36`          | Retry a failed listing instead of being told to contact support                                                         |
| `605a2ff`          | See what the AI read off their photos, and which fields only they can supply, while the listing still needs information |
| `d1af2a7`          | Same, for labels with accents, and for models that name evidence fields naturally                                       |
| (re-run work)      | Re-run a listing after supplying what it asked for, instead of being refused forever                                    |
| (partial save)     | Save a draft with the SKU and price still unknown, keeping everything already confirmed                                 |
| (generation gate)  | Get a usable draft from a label with no SKU, price, region or vintage, instead of a dead end                            |
| (presign checksum) | Upload against a backend that enforces checksums, instead of every PUT failing at once                                  |
| (create replay)    | Click create again after a lost response and reach the same listing, instead of a 409 dead end                          |
| (file picker)      | Add a back label without silently losing the bottle shot, and remove a file that was picked by mistake                  |
| (dirty guard)      | Stop approving a version that lacks the correction still sitting in the box                                             |
| (media policy)     | Learn a photo is too large before uploading it, not after presign refuses it                                            |
| `0cfeba4`          | Retry after one photo fails without re-sending the ones that already uploaded                                           |
| `c8125f8`          | See that image processing is off rather than watching a spinner that never ends                                         |
| `cbe7201`          | Run a second batch over the same products and have it actually do the work it reports                                   |
| `bc501ee`          | Stop a blocking compliance flag disappearing because someone saved an unrelated edit                                    |
| `e2d0e8c`          | Read which conflict refused an action, instead of one sentence that fits a dozen different problems                     |
| `7e11b47`          | Have "95 points from Robert Parker" flagged when nothing in the source ever said so                                     |
| `9a5c5a9`          | Have the same check applied to a claim typed in by hand after the AI was done                                           |
| `5b538df`          | Follow one list of what to set, instead of guessing what Vercel needs                                                   |
| `5e89866`          | Keep a batch wave that was interrupted, instead of losing it with no trace                                              |
| `6eefc16`          | Find out the production Worker is inventing every listing, instead of reading seven green checks                        |

## What the adversarial review corrected in my own work

Every finding below was investigated and then independently attacked. Three
corrections changed what shipped, and are recorded because the tests did not
catch any of them:

1. **F06's fix would have raised `check_violation` in production.**
   `0021_product_shots.sql:27` pins `error_code` to six values, and all three
   codes the fix writes were outside it. Unit tests use fake repositories, so
   they stayed green. Caught by review, then reproduced on a real Postgres,
   fixed by migration `0022`, and re-proved end to end.
2. **F06's severity was overstated by me.** The committed
   `cloudflare-runtime.config.json` pins the Worker to `disabled`, but the web
   app defaults to `disabled` too and refuses to enqueue, so the committed
   configuration is self-consistent. The reachable case is enabling the feature
   on Vercel without also setting it in the Worker config. The code comment said
   otherwise and was corrected.
3. **F08's key fix alone would have made production worse.** Resolving the real
   revision stops the silent no-op — and immediately sends a genuine job for
   drafts that are already `approved` or `published`, which spends on the model
   and then throws on the status transition, rolling back the cost record in the
   same transaction. The status gate had to land in the same commit, and did.

## Next task, exactly

**Nothing in the audit remains open.** All fourteen findings are addressed; what
is left is verification, not implementation, and it is listed under "Still not
proven" in the [verification record](./wukong-remediation-verification.md). The
two that matter most before a pilot: `listing-extraction@1.1.0` has never been
sent to a model, and the production run remains unattributed.

### Done since this section last named a task

**F08, durable dispatch.** Dispatch is still an in-request loop that runs after
the claim transaction commits. A request that dies mid-wave leaves its items
`queued` with no queue message, no audit event, and nothing able to find them:
the cron sweeper requires a source asset, which imported drafts never have, and
`claimWave` only claims `pending`.

The blocker was a design question rather than typing: a recovery pass could not
tell "never dispatched" from "dispatched and still sitting in the queue",
because the `listing_pipeline_runs` row appears only once the pipeline claims
its first step, and re-dispatching the second case buys a duplicate extraction.
Settled by recording the dispatch itself — migration `0023` adds
`listing_dispatch_outbox`, written inside the claim transaction, so the row
exists before any send and `dispatched_at` says which of the two happened.

**F12's env-inventory delta.** Several variables `apps/web` required at runtime
were unchecked, and one — `DATABASE_MIGRATION_URL` — was a name read in exactly
one file, spelled differently from the `DATABASE_ADMIN_URL` used everywhere
else, documented nowhere, and handed to a `migrate()` the web app never calls.
It was removed rather than documented: what it actually provided was a channel
for putting an admin database URL on Vercel, which the runbook forbids under the
other spelling. `scripts/runtime-env-manifest.mjs` now states what each surface
needs, and a test derives the truth from the source so the list cannot fall
behind the code.

### Done since this section last named a task

**F13(c) — the review screen collapsed a conflict into one useless sentence.**
Not every failure, as first reported: 401/403 already render a dedicated
permission sentence. What collapses is the 409/422 family —
`version_conflict`, `confirmation_ledger_stale`, `confirmation_source_stale`,
`source_snapshot_required`, `source_origin_changed`, `image_approval_required`,
`stale_version`, `listing_busy` — each of which has a precise remedy already
written in `apps/web/lib/approval-ui-copy.ts` and wired only to the bulk queue.
`listing-review-client.tsx:506-509` discards the body, so the code never
reaches the screen. Forward the `code` field only, never `message`, or the
"never leak internals into a response body" rule leaks through the UI instead.

Fixed in `e2d0e8c`: only `code` crosses the boundary, never `message`, and an
unrecognised code still falls back to the generic sentence.

**F14 claim grounding.** Only the fact EXTRACTION was ever grounded; nothing
checked the prose. `rating_without_evidence` and `superlative` were declared in
the flag union and had bilingual labels on the review screen, and no pattern
produced either — so a description could assert "Awarded 100 points by Robert
Parker" against `criticScores: []` and pass generation validation, compliance,
and approval. Both rules are real now (`7e11b47`), and the operator's save is
re-scanned too (`9a5c5a9`), because scanning only at generation left the obvious
hole of typing the claim in afterwards.

## F11 is not a defect, and was deliberately not attempted

Nothing at HEAD misbehaves against its own contract: the pipeline is
extract → generate → complete, and it does exactly that. Closing F11 means
building a stage that consults a data source outside this repository, which
needs a real provider and either a credential or a robots-permitted crawl
target. None of the three exists in an offline session.

A seam was designed and then rejected on review: it proposed a second
`extracted` step record, which `UNIQUE (workspace_id, pipeline_run_id, step)`
makes impossible and which would break the replay determinism the lease design
exists to guarantee; and it copied `deps.productShot?`, whose own comment says
that dependency is legacy and deliberately never supplied. Landing a seam that
cannot carry the feature is worse than landing nothing, so nothing was landed.

Whatever eventually fills it must produce evidence-bearing facts or none:
`fact-grounding-rules.ts` exists precisely to stop an unattributable value
reaching a listing, and an external source must not become a way around it.

## Discovered while fixing, not yet addressed

**The presign does not bind content type.** `PutObjectCommand` is given a
`ContentType`, but the SDK signs only `content-length;host`, so a caller holding
an upload URL may PUT any content type and the object is stored with it. The
presign is therefore not the layer enforcing media policy -- finalize is, and it
does re-read the stored object (`object.mimeType !== body.mimeType` rejects a
mismatch) rather than trusting what the browser declared. Pinned by a test so it
cannot be assumed otherwise. Sharing the policy in F07 does not change this: a
shared constant makes the four layers agree on the RULE, not on who enforces it.

## Not started

Phases 2–5 in full. No migration was written, none was rehearsed, and no
deployment control was touched. SHOPLINE write settings are unchanged.
