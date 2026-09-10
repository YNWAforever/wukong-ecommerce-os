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

## D4 — A re-run needs its own operation identity (not yet implemented)

**Status:** open — the next blocking design decision

The queue key is `listing:<workspace>:<draft>:<activeVersionSequence>`. A
`needs_info` listing never appends a version, so its sequence stays `0`, the key
keeps resolving to the completed run, and no amount of supplied information
produces a new run.

**Direction.** Introduce an explicit operation identity per run rather than
deriving the key from `activeVersionSequence` alone. The plan forbids renaming or
zeroing `activeVersionSequence`, so the operation id is additive.

**Constraint that shapes the rollout.** `listingJobSchema` is strict, so a
producer must not emit a field the deployed Worker cannot parse. The Worker that
reads both envelopes ships first; the web producer switches after.

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
