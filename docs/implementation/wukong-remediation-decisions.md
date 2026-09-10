# Wukong remediation — decision log

Decisions taken while executing the phased remediation. Each entry records what
was decided, what it rules out, and what would justify revisiting it.

Baseline: HEAD was `9f72a37` — the same commit the audit examined — so no newer
work supersedes any finding. Branch: `codex/listing-grounding-diagnosis`.

---

## D1 — Ground facts by declared mode, not by verbatim quotation

**Status:** implemented (`b68210d`)

`assertFactsGrounded` required every non-null fact to appear verbatim inside one
of its own evidence excerpts. Each fact now declares how it may be grounded:
`verbatim`, `normalized`, `classified`, or `merchant`
(`packages/ai/src/fact-grounding-rules.ts`).

**Why.** Verbatim quotability is a poor proxy for "the model did not invent
this". It is satisfiable by a note that restates each value, and unsatisfiable by
a photographed label, where the correct value is routinely a unit conversion, a
translation, or a classification. The result was not a soft failure:
`ProviderOutputError` is in `isTerminalProviderError`, so a correct extraction
of a real label terminalized the listing to `failed` on the first delivery.

**Rejected alternatives.**

- *Drop grounding for the affected fields.* Removes the anti-fabrication
  property that is the whole point of the check.
- *Ask the model to emit both raw and normalized values.* Moves the trust
  boundary into the model's own self-report; a fabricated pair still passes.
- *Fuzzy/edit-distance matching.* Non-deterministic in effect, and would accept
  the `Mosel`/`Moselle` and `750`/`700` collisions the current rules reject.

**Consequences.** `productType` is no longer checked against its excerpt, so the
substring-collision probe that sat on it moved to `region`. Classification
accuracy is now an eval concern rather than something grounding can police
without a knowledge base — it needs golden-set coverage, tracked as an open item.

**Revisit if.** Golden-set measurement shows `classified` facts drifting, or the
closed country-alias table starts needing entries faster than they can be
reviewed.

---

## D2 — Merchant data may only be grounded in the operator's note

**Status:** implemented (`b68210d`)

`sku`, `priceHkd` and `stockQuantity` are grounded only by evidence whose source
is `NOTE_SOURCE_ID`. Evidence from an image asset is rejected.

**Why.** These describe the merchant's own business. A number printed on a
bottle, a shelf tag or packaging is not the merchant's selling price, stock level
or SKU, so accepting it is a guess presented as an extracted fact. The plan is
explicit that these must come from the merchant or an authorised product system.

**Consequences.** This is the one deliberate *tightening* in D1's change; every
other mode is strictly more permissive. It is compatible with all existing
fixtures and with the import flows, which already write these into the note.
It does **not** by itself let a draft save without them — see D5.

**Revisit if.** An authorised supplier feed becomes a first-class evidence source
distinct from both the note and a photograph; it would need its own mode rather
than being folded into `merchant`.

---

## D3 — Offer retry for `failed`, withhold it for `needs_info`

**Status:** implemented (`1b69c36`)

`ListingProcessingPanel` now renders a retry action for `failed`. It still
renders none for `needs_info`.

**Why.** The asymmetry is not a UI preference, it is what the server supports.
`POST /api/listings/[id]/process` lists `received`/`needs_info`/`failed` as
retryable, but then rejects any run whose state is not `failed`. A `needs_info`
run completed with status `succeeded`, so that route answers
`409 processing_already_started`, and `runListingPipeline` would in any case
short-circuit on `getCompleted`. A button that can only fail is worse than none.

For `failed` the capability was already complete and merely unreachable:
`pipelineRuns.reopenFailed` deletes the still-running step rows and resets the
run, so a retry starts clean rather than colliding with the lease the failed run
left holding.

**Consequences.** Inverts a deliberate test assertion that pinned "no retry
button" for `failed`. That test encoded the dead end, not a constraint.

**Revisit when.** D4 lands: once a re-run carries its own operation identity,
`needs_info` gets a real action and this asymmetry disappears.

---

## D4 — A re-run carries its own attempt number

**Status:** implemented

The queue key was `listing:<workspace>:<draft>:<activeVersionSequence>`. A
`needs_info` listing never appends a version, so its sequence stayed `0`, the key
kept resolving to the completed run, and no amount of supplied information
produced a new one.

`listingJobSchema` gains an **optional** `runAttempt`, and `listingRunKey()` in
`packages/jobs` becomes the single derivation both sides share — previously the
literal was spelled out separately in `listing-queue-runtime.ts` and
`listing-pipeline.ts`, which had to agree by inspection.

**Why a counter rather than a UUID operation id.** Attempt 0 must key exactly as
before, or every run already recorded is orphaned and re-runs work that is done
and paid for. A counter gives that for free (`runAttempt` absent or 0 → the
historical string) and needs no new column: `listing_pipeline_runs` already has
`listing_id` and `active_version_sequence`, so `countRuns` is a plain count.

**Why the newest run decides, not the attempt-0 run.** Numbering off a count
alone would let a second click enqueue attempt 2 while attempt 1 was still in
flight, buying a duplicate extraction. The route reads the state of the newest
attempt instead: `started` → 409; `failed` → reopen and re-drive the same key;
`succeeded` + `needs_info` → the next number. When no run row exists yet — queued
but unclaimed — it re-enqueues the *same* key, which the pipeline deduplicates.

**Rollout constraint.** `listingJobSchema` is strict, so an old Worker
`safeParse`s a message carrying `runAttempt` as invalid and the consumer **acks
it away silently**. The Worker ships first; the producer switches after. Attempt
0 never puts the field on the wire, so the common path stays compatible
throughout — there is a test pinning that.

**Not covered.** A lost POST response *after* the newest run has finished still
produces a genuine new run. Making that idempotent needs a client-supplied
request key, which is a separate contract change.

---

## D6 — A draft saves as reviewable; canonical is the delivery gate

**Status:** implemented

`PUT /api/listings/[id]/review` validated the payload with
`canonicalListingSchema`, which re-tightens the seven commercial facts to
non-null. An operator who had read the producer, origin, vintage, volume and ABV
off a label but was still waiting on the merchant's SKU and price could not
record any of it: the whole payload was rejected for the two fields they did not
have, losing the nine they did.

The save path now validates with `reviewableListingSchema` — the two schemas
already existed side by side for exactly this distinction. `listing_versions.content`
is `jsonb` with no database-level constraint, so this is a TypeScript-visibility
change with **no migration**.

**Why widening the stored type was safe to do now.** Changing
`$type<CanonicalListing>` to `$type<ReviewableListing>` made every reader that
assumes non-null facts fail typecheck. That surfaced exactly four production
sites, and all four are delivery or approval gates — `requireForPublish` (kept
strict, still parsing with `canonicalListingSchema`), the deliver route, the
SHOPLINE publish consumer, and the quality summary. Nothing in the *drafting*
path needed the guarantee. That is the evidence the completeness requirement
belongs at the gate rather than on every save, rather than an assumption.

**The client blocked it too.** `applyListingFields` ran price, volume and ABV
through `requiredNumber`, which threw before the request was made. They now use
`optionalNumber`, which still rejects text that is not a number — absent and
wrong stay different — and `packQuantity` falls back to the schema default of 1.

**Not changed.** Bilingual title, description, SEO, tags and images are still
required to save; relaxing the facts must not relax the content a reviewer reads.

**A regression this introduced, caught before committing.** `listRecent` and
`getByIds` also parsed with `canonicalListingSchema`, and their failure mode is
silent: `safeParse` failing sets `activeVersion` to null, and the catalog row
then falls back to the note and finally to "未命名商品". So the first partial
draft would have vanished from its own catalog row under its real title, with a
null SKU, and no error anywhere. The full test suite stayed green through it,
because nothing saved a partial draft and then listed it.

Both are display paths, so both now parse as reviewable, and a unit test pins
the split — reviewable for display, canonical for publishing — precisely because
the failure is invisible at runtime.

**Why approval did not need a new gate.** `listing-approval.ts` already states
that `getReviewSnapshot` content "is only as complete as review has gotten" and
that "nothing here re-validates completeness; requireForPublish still does". The
separation this decision relies on was already the design, not an assumption
made for it.

---

## D5 — Extraction results are already durable; expose them before migrating

**Status:** open — proposed, not yet implemented

For the `needs_info` outcome, `recordStep(..., output: extraction)` runs *before*
the `missingFields` check, so facts, evidence and missing fields are already
persisted in `listing_pipeline_steps.output`, and `pipelineRuns.getState` already
returns step outputs. Nothing reads them back: the listing GET response never
calls it.

**Direction.** Surface the persisted extraction on the listing read model first,
and only then consider a schema change. That gives a real partial-draft view for
`needs_info` with no migration and no widening of
`listingVersions.content.$type<CanonicalListing>()`.

**Note on the `failed` path.** Those facts are *not* durable, because a grounding
rejection is raised before `recordStep`. D1 removes the common cause; making the
remainder durable is a separate change.

**Constraint for the eventual schema work.** `listingVersions.content` is `jsonb`
typed only in TypeScript, so a discriminated draft union is possible without a
migration — but it ripples through every consumer of `CanonicalListing` (review,
approve, freshness, bulk export projection), which is why it must land as one
coherent slice rather than a partial widening.

---

## Open questions requiring evidence this session could not obtain

- The historical run `3b958fe6-64e3-44bb-ac0c-13fa38ae60a3` cannot be attributed
  from source alone. Confirming it needs that run's `error_code` and failed step
  from `listing_pipeline_runs` / `listing_pipeline_steps`, or the Worker log line.
- Whether the deployed Worker's configured listing model accepts image input at
  all. The source default is `gpt-5.6-terra`; production configuration was not
  readable from here.
