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

- _Drop grounding for the affected fields._ Removes the anti-fabrication
  property that is the whole point of the check.
- _Ask the model to emit both raw and normalized values._ Moves the trust
  boundary into the model's own self-report; a fabricated pair still passes.
- _Fuzzy/edit-distance matching._ Non-deterministic in effect, and would accept
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

**Consequences.** This is the one deliberate _tightening_ in D1's change; every
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
but unclaimed — it re-enqueues the _same_ key, which the pipeline deduplicates.

**Rollout constraint.** `listingJobSchema` is strict, so an old Worker
`safeParse`s a message carrying `runAttempt` as invalid and the consumer **acks
it away silently**. The Worker ships first; the producer switches after. Attempt
0 never puts the field on the wire, so the common path stays compatible
throughout — there is a test pinning that.

**Not covered.** A lost POST response _after_ the newest run has finished still
produces a genuine new run. Making that idempotent needs a client-supplied
request key, which is a separate contract change.

---

## D7 — Being missing and being blocking are different questions

**Status:** implemented

Both providers report `missingFields` as every null fact, and the pipeline
treated a non-empty list as "cannot generate". That conflated three unrelated
things: facts a label legitimately does not state (region on a spirit, vintage
on an NV), merchant data the model is **forbidden** to read off a photograph at
all (SKU, price, stock — see D2), and the product identity without which there
is genuinely nothing to write.

Only the last one blocks now. `factsSufficientForGeneration` requires
`GENERATION_REQUIRED_FACTS`, currently just `producer`, and the pipeline gates on
that instead of on `missingFields.length`.

**`missingFields` is deliberately unchanged.** The review screen shows it, and an
operator does want to know a region is absent. It simply no longer decides
whether a draft exists. That also leaves the two providers' differing definitions
(`FACT_KEYS`, all 14, versus the fake's `PROTECTED_FIELDS`, 10) harmless rather
than load-bearing — worth reconciling, but no longer urgent.

**Why this had to move together with generation.** `buildSafeListing` demanded
seven non-null facts and threw `Safe generation requires sku`. Relaxing the gate
alone would have converted a `needs_info` into a terminal `failed` — strictly
worse. So it now requires only the identity and omits each optional clause when
its fact is absent, rather than rendering `Volume: null ml.` to the merchant's
customers. `generationOutputSchema` and `GenerationResult.listing` become
reviewable for the same reason, and the fake provider mirrors the rule so it
cannot accept a draft the real path would reject.

**What now routes to `needs_info`.** An unidentifiable product — a blurred or
obscured label. The two tests that previously reached that state through a
missing price now reach it that way, which is why they changed rather than being
deleted.

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
SHOPLINE publish consumer, and the quality summary. Nothing in the _drafting_
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

For the `needs_info` outcome, `recordStep(..., output: extraction)` runs _before_
the `missingFields` check, so facts, evidence and missing fields are already
persisted in `listing_pipeline_steps.output`, and `pipelineRuns.getState` already
returns step outputs. Nothing reads them back: the listing GET response never
calls it.

**Direction.** Surface the persisted extraction on the listing read model first,
and only then consider a schema change. That gives a real partial-draft view for
`needs_info` with no migration and no widening of
`listingVersions.content.$type<CanonicalListing>()`.

**Note on the `failed` path.** Those facts are _not_ durable, because a grounding
rejection is raised before `recordStep`. D1 removes the common cause; making the
remainder durable is a separate change.

**Constraint for the eventual schema work.** `listingVersions.content` is `jsonb`
typed only in TypeScript, so a discriminated draft union is possible without a
migration — but it ripples through every consumer of `CanonicalListing` (review,
approve, freshness, bulk export projection), which is why it must land as one
coherent slice rather than a partial widening.

---

## D8 — Progress survives the failure that interrupted it

**Status:** implemented (`0cfeba4`)

`createListingDraft` collected asset ids into a local array and threw on the
first failure, so the array went out of scope. The form then reset every
in-flight row to `ready`, because a status string was all it kept. A second
photo failing therefore re-sent the first photo's bytes — over the connection
that had just proved unreliable — and left the first upload orphaned in the
bucket with `listing_id` null.

Each file now reports `storedKey` the moment its bytes land and `assetId` the
moment finalize confirms them, and both are committed to state during the submit
rather than after it. A retry resumes from the stored key, skipping presign and
the PUT entirely.

**Why finalize had to become replay-safe at the same time.** Presign mints a
fresh random key per call (`asset-store.ts:154`), so before this change a retry
could never revisit a key and the `409 asset_already_finalized` branch was
unreachable from any real path. Resuming makes it reachable on the first lost
finalize response. The same key with the same `clientSha256` is now answered
with the existing asset and a `200`; a different checksum is still a `409`, and
no second audit event is written because no mutation happened.

**Consequences.** This also repairs the create-replay guard from F05's first
half, which keys idempotency on the asset set: re-uploading minted new ids, so a
replay looked like a different listing and a lost `POST /api/listings` response
produced a second draft for the same bottle.

---

## D9 — An attempt nothing dispatched gets a terminal state, not silence

**Status:** implemented (`c8125f8`)

`runProductShot` returned silently when the Worker's provider was `disabled`,
acking the message and leaving the row `queued` for ever. The panel polled it
every three seconds, "Retry queue" led back to the same line, and — because
`listing-approval.ts:341` refuses any listing whose product shot is not
`approved` — the listing could never be approved either. A blocked listing, not
a spinner.

`finishUndispatched` ends such an attempt as `failed`, guarded on
`queued && !dispatchedAt && !cutoutAssetId`. That predicate is the whole safety
argument: it is the proof no provider call was made, and therefore that nothing
can have been charged. Anything dispatched keeps flowing through
`finishFailure`, which can still reach `outcome_unknown`.

**A migration was required, and unit tests could not have told me.**
`0021_product_shots.sql:27` pins `error_code` to six values, all of which
describe something that happened during or after a provider call. All three new
codes were outside it, so the write raised `check_violation` in production while
every fake-repository test stayed green. `0022` widens the CHECK — strictly
additive, rehearsed twice on a real Postgres for idempotency, then re-proved
through the full migration chain and the repository integration tests.

**Deployment order.** The migration must be applied **before** the Worker that
writes the new codes. A second ordering constraint on top of D4's.

**Not covered.** A runtime that cannot initialise has no database handle to
record through, so its final delivery still dead-letters; a DLQ replay is the
only recovery. Closing that needs a sweeper pass over stuck attempts, which
needs its own `SECURITY DEFINER` function and migration.

---

## D10 — A batch must not report work it did not do

**Status:** implemented (`cbe7201`)

Every batch wave enqueued `activeVersionSequence: 0`. For any draft already
through the pipeline that key resolved to a completed run, so the Worker
returned the cached result without calling the model: the item was marked
queued, reconciled as succeeded, and the catalog was unchanged. The operator
read "enqueued: 5" over five listings nothing had touched. The cohort makes this
the expected case — the gap is read from an imported sheet row enrichment never
rewrites, so a second batch re-selects exactly the same drafts.

**Why the status gate is in the same commit.** Sending the real revision fixes
the no-op and immediately exposes a worse failure: a genuine job for an
`approved` or `published` draft runs extraction _and_ generation and then throws
`Illegal transition` while completing — and that throw rolls back the cost
record written in the same transaction, so the money is spent where no budget
can see it. Landing the key fix alone would have made production worse than
leaving it broken.

**Mutual exclusion comes from the item status, not the queue key.** Numbering a
fresh attempt per advance means two advances no longer share a key, so the key
no longer serializes them. `claimWave` claims only `pending` rows and nothing
moves an item back, so a draft whose job is in flight cannot be claimed twice.

**`needs_info` and `reopened` now settle.** They were in neither the succeeded
nor the failed list, so the item stayed `queued` and `done` could never become
true. They are `skipped`: the batch has nothing further to try, even though a
person still can.

**Not covered.** Dispatch is still an in-request loop after the claim commits. A
request that dies mid-wave leaves items `queued` with no message and no audit
event. A recovery pass cannot yet tell "never dispatched" from "dispatched and
still in the queue", because the run row only appears when the pipeline claims
its first step — that distinction has to be designed before it can be fixed.

---

## D11 — A budget counts the batch's own spend, not the cohort's history

**Status:** implemented (`cbe7201`)

`sumCostForListings` summed every run those drafts had ever had. The design's
own prescribed recovery — a new batch over a failed cohort — was therefore the
case that broke worst: the second batch opened already charged for the first
one's spend and could exhaust its budget before enqueuing anything. No route can
change a batch's budget after creation, so there was no value an operator could
set to escape it.

`since` bounds the sum to the batch's own lifetime. **Deliberately no batch id
on `ai_runs`**: the listing pipeline stays generic, `listingJobSchema` is
`.strict()` so a new key would make an older Worker reject the envelope, and a
time bound needs no column at all. The parameter is optional, so
`GET /api/quality` — which genuinely wants workspace-lifetime cost and already
publishes `costScope: "all_history_for_workspace_listings"` — is unchanged.

---

## D12 — A gate that a Save can empty is not a gate

**Status:** implemented (`bc501ee`)

Compliance flags are stored against the version they were raised on, and every
edit appends a new version. `approveListing` refuses only on an OPEN BLOCKING
flag it can see, and it reads them off the active version — so saving any edit,
even one nowhere near the flagged field, left the new version with no flags and
opened the gate. `listing-approval.ts` already carries flags forward wherever it
appends a version; `editReview` was the one path that did not.

**Evidence is deliberately not carried.** There the content is what changed, so
the previous version's excerpts may no longer support the values they are
attached to, and asserting that they do would be worse than showing none.

**Revisit if** an edit to a flagged field should re-open a resolved flag. Today
a resolved flag carries its resolution forward unchanged, which restores the
behaviour that existed before the version was appended — not a judgement that
the resolution still applies.

---

## D13 — A diagnostic may not claim more than it checked

**Status:** implemented (`6eefc16`)

Two false greens, both of which an operator would read as an answer to a
question the command never asked.

`vercel-env` read `process.env`. A green line said the operator's own shell held
an ingress URL and secret; its name said Vercel was configured. The bring-up
runbook then told them `health-signed` proves Vercel and the Worker agree — but
that check signs with the same shell value, and the runbook's own command block
tells them to paste the Worker's secret into it. So the most common bring-up
failure was structurally invisible, behind a check named after it. Renamed to
`local-ingress-env`, its detail now says which shell it read, and its fix names
`vercel env pull`, which answers the other question.

`/health` has always published `aiProvider`, and nothing read it. A production
Worker deployed with `AI_PROVIDER=fake` invents every fact and every sentence it
returns, and reported seven green checks. `listing-provider` now fails
production on `fake`, fails any value this build cannot run, and prints both
provider names — the product-shot one is printed rather than judged, because it
is only wrong relative to the web app's value, which this command cannot read.

**Why not make the Vercel check `unknown`.** `hasFailure` treats anything that
is not `ok` as a failure, so an always-unknown check would exit 1 on every run
and be trained away within a week. Naming what was actually checked is worth
more than a signal nobody reads.

**Not covered.** The env-inventory delta: several variables `apps/web` requires
at runtime are still unchecked, and one is explicitly forbidden on Vercel by the
runbook the operator is following.

---

## D14 — F11 is a capability, and a seam that cannot carry it is worse than none

**Status:** decided, not implemented

Nothing at HEAD misbehaves against its own contract. Closing F11 means building
a stage that consults a data source outside this repository, which needs a real
provider and either a credential or a robots-permitted crawl target. None exists
offline, so nothing was landed.

A seam was designed and rejected on review. It proposed a second `extracted`
step record, which `UNIQUE (workspace_id, pipeline_run_id, step)` makes
impossible and which would break the replay determinism the lease design exists
to guarantee; and it copied `deps.productShot?`, whose own comment says that
dependency is legacy and is deliberately never supplied by
`createCloudflareRuntime`. A seam that cannot carry the feature would have
looked like progress and blocked the real design.

**Constraint for whoever builds it.** Facts from an external source must arrive
with evidence or not at all. `fact-grounding-rules.ts` exists to stop an
unattributable value reaching a listing, and adding a source must not become a
way around it — which means a new grounding mode, not an exemption.

---

## D15 — An error code is data the operator is owed; a message is not

**Status:** implemented (`e2d0e8c`)

`responseError` on the review screen discarded the response body, so every
action failure became `Request failed (409)` and rendered as one sentence with
one offered action, Retry. "The AI is still working on this" (wait), "your copy
of this page is stale" (reload) and "resolve the flags below" (act) were
indistinguishable, and Retry is the right move for exactly one of them.

Only `code` crosses the boundary. `message` is still dropped, because route
handlers may put internals there and the rule against leaking internals into a
response body means nothing if the screen prints them instead — there is a test
asserting a connection string in `message` never reaches the DOM.

**Why a second copy table rather than reusing the bulk queue's.** Every remedy
in `approvalErrorLabel` ends in "select it again", which is correct on a queue
and meaningless on a screen with no selection. The two tables sit in one file so
a divergence is visible in review.

**Why unknown codes return null rather than a sentence.** A route may add a code
before the table does. Null keeps the caller's existing fallback, and that
fallback is also what renders the permission wording for 401/403 — which is why
`insufficient_role` deliberately has no entry.

---

## D16 — A claim in the copy is checked against what the listing can support

**Status:** implemented (`7e11b47`, `9a5c5a9`)

Only the fact EXTRACTION was ever grounded. `assertGenerationGrounding` compares
the 14 structured fact keys and `imageAssetIds`; title, description, SEO and
tags were never looked at. The only check on the prose was `scanCompliance`,
whose two rules covered health claims and guarantees.

So a description could assert "Awarded 100 points by Robert Parker" while
`criticScores` was empty, and pass generation validation, pass compliance, and
reach approval with nothing flagged. The two rules that exist for exactly this,
`rating_without_evidence` and `superlative`, were declared in the flag union and
given bilingual labels on the review screen — and no pattern produced either, so
both sets of UI strings were unreachable.

**The rating rule needs the facts, which is why it never worked.**
`scanCompliance(fields)` took text alone, and from text alone a fabricated score
and a grounded one are the same sentence. It now takes the listing's
`criticScores` and `awards`; the argument is optional, so the rule fires only
where the caller genuinely knows, rather than guessing in either direction.

**Superlative is a warning, not a blocker.** Someone has to stand behind
"finest", but blocking every listing that uses one would stop the pilot, and the
flag already puts it in front of a person. One honest limit is recorded in its
test: "best served at 10°C" is read as a rank claim, and a reviewer clears it.

**Why the operator's save had to be re-scanned in the same slice.** Scanning
only generated copy leaves the obvious hole: type the claim in afterwards and
nothing notices. `PUT /review` wrote no flags at all. It now re-scans what was
submitted — and, because the field list is shared from `@wukong/core`, scans the
same eight fields the pipeline does. Two private copies of that list is how a
rule ends up enforced on one path and not the other.

**Resolutions survive only while their field is untouched.** A blind re-scan
would re-open every answered flag on every save and train people to ignore them;
carrying every resolution would let an operator resolve a flag, rewrite the
flagged sentence into something else objectionable, and keep the old answer
attached to text it was never about. Editing the flagged field brings the flag
back open, with the change in front of the person who has to justify it.

**Consequences.** `editReview` gains an optional `flags` argument. Omitted, it
copies the base version's flags forward (D12's safety property: a Save must
never empty the gate). Supplied, the caller's re-scan replaces them — which is
what lets a claim edited OUT clear its flag, something a copy-forward alone can
never do.

**Not covered.** The patterns are deterministic and English/Chinese only; a
claim phrased outside them passes. There is no HK alcohol advertising rule set,
and `workspaceProfile.claimPolicy` is still only pasted into the model prompt
with no deterministic checker reading it.

---

## Open questions requiring evidence this session could not obtain

- The historical run `3b958fe6-64e3-44bb-ac0c-13fa38ae60a3` cannot be attributed
  from source alone. Confirming it needs that run's `error_code` and failed step
  from `listing_pipeline_runs` / `listing_pipeline_steps`, or the Worker log line.
- Whether the deployed Worker's configured listing model accepts image input at
  all. The source default is `gpt-5.6-terra`; production configuration was not
  readable from here.
