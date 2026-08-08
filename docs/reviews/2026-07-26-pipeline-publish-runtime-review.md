# Durable listing pipeline & SHOPLINE publish runtime — review

**Date:** 2026-07-26
**Scope:** `apps/worker/src/*`, `packages/db/src/repositories/{pipeline-runs,publish-jobs,listings}.ts`,
`packages/jobs/src/*`, and the HMAC ingress boundary between `apps/web` and `apps/worker` (~4,850 lines).
**Method:** six independent review lenses, each finding put through two adversarial refuters
(reachability from the shipped wiring, and already-handled/misquote checks). 14 findings survived
refutation; they collapse to the 5 distinct defects below.
**Commit reviewed:** `c14e5ac` (merge of #8, `codex/production-listing-workflow`).

> **Original verdict: not ready for the first real SHOPLINE write.** Findings 1 and 2 can each put a
> live product into a merchant's store that this system has no record of and cannot reconcile.

## Status (updated 2026-07-26)

All five findings are fixed on `codex/pipeline-durability-fixes`, each with a regression test that was
confirmed to fail against the unfixed code:

| #   | Finding                                                 | Fix                                                                                                                                                                     |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `editReview` rewrites a listing mid-publish             | Exhaustive status map replaces the fall-through ternary; `appendVersion` moved after the guard; route returns 409 `listing_busy`                                        |
| 2   | DB error after a successful create re-POSTs `/products` | `complete()` moved out of the create-retry loop; new `publishJobs.recordRemoteProduct` commits the remote id immediately, making the reconciliation reads reachable     |
| 3   | Lease bookkeeping cleared inside the transaction        | Bookkeeping moved after the callback resolves; `makeTransactionAwareHarness` added with commit-failure simulation                                                       |
| 4   | Stale-lease window exceeds the retry budget             | `claimStep` returns `leaseExpiresAt`; `PipelineStepBusyError` carries it; the consumer schedules its retry from lease expiry, plus a module-load lease-budget assertion |
| 5   | Consumer hardcodes `attempt: 1`                         | `LISTING_MAX_ATTEMPTS` forwarded from `message.attempts`                                                                                                                |

Beyond the five, the root-cause gap below is partly closed: an operator can now re-drive a listing the
pipeline gave up on. `process/route.ts` accepts the three statuses the workflow state machine actually
allows (`received`, `needs_info`, `failed`) instead of only `received`, and re-drives a failed run via
the new `pipelineRuns.reopenFailed`, which returns it to `started` and drops orphaned `running` step
rows so the retry does not wait out a five minute lease. Completed steps are kept, so a retry does not
pay for extraction again.

Two caveats remain. Finding 2 shrinks the unreconcilable window to a single small `UPDATE` but cannot
eliminate it: if that one commit fails, the remote product is still unrecorded. Closing it fully needs
either a SHOPLINE lookup by external reference or a two-phase write. Finding 4 keeps the 300 s lease
because shortening it below the retry budget would let a redelivery steal a step from a worker still
inside a 120 s provider call; the fix makes the retry wait for expiry instead.

---

## Root cause: the durability model is in-memory, but the transactions are not

`runListingPipeline` is not one unit of work. It is **seven independently-committed transactions**
(`deps.withWorkspace` → `drizzleClient.transaction`, `packages/db/src/client.ts:105`), stitched
together by four mutable locals: `activeStep`, `claimedStep`, `claimedLeaseToken`, `completionStep`.

Ownership of a _database-backed_ lease is tracked in _isolate memory_, and the recovery logic in the
`catch` block reads that memory to decide what to release. Three consequences follow mechanically:

- If the isolate dies, no release runs at all → **finding 4**.
- If a transaction rolls back, the memory does not → the release is skipped for a lease the database
  still holds → **finding 3**.
- The only durable backstop, the 300 s stale-lease reclaim, is calibrated against nothing and is
  unreachable inside the queue's retry budget → **finding 4**.

There is no reaper. `apps/worker/src/cloudflare.ts` exports only `fetch` and `queue` — no `scheduled`
handler — and `LISTING_QUEUE_NAMES` (`queue-consumer.ts:10-13`) excludes the DLQ names, so nothing
consumes dead-lettered messages.

**Partly addressed.** Operator re-drive now exists (see Status above), so recovery no longer requires
an engineer replaying the dead-letter queue by hand. Still outstanding: nothing _automatically_ moves
a dead-lettered listing out of `processing`, so the state stays invisible until someone notices it. A
DLQ consumer or a `scheduled` reaper remains the right fix, and needs Cloudflare resource wiring
(`cloudflare-runtime.config.json`, `render-cloudflare-config.mjs`, and the queue-name allowlist) that
cannot be verified without a live Wrangler deploy.

The publish path got this right and is worth copying: `shopline-consumer.ts:30-37` statically asserts
its lease budget at module load, and `:171-182` schedules retries from actual lease expiry. The
listing path has neither.

---

## 1. `editReview` rewrites a listing mid-publish, orphaning a live SHOPLINE product — **high**

**`packages/db/src/repositories/listings.ts:415`**

`editReview` computes `nextStatus` with a ternary instead of routing through `transitionListing`.
`publishing` matches no arm, so it falls through to `in_review` — an edge `workflow.ts:41-44`
forbids. The optimistic guard `eq(listingDrafts.status, listing.status)` (line 431) binds to the
status that was just _read_ (`'publishing'`), so it **permits** the write rather than blocking it,
and `beginPublish` leaves `activeVersionId` untouched so the reviewer's `baseVersionId` still
matches.

Nothing upstream stops it either: `apps/web/app/api/listings/[id]/review/route.ts:45-49` has no
status guard, `listing-review-client.tsx:134` renders `publishing` as `"approved"`, and
`app/api/listings/[id]/route.ts:37` computes `canEdit` from role rank alone. Save is live on the
normal review screen for the entire publish window.

**Failure scenario.** Reviewer clicks Publish (202), notices a typo, clicks Save. `beginPublish` has
committed `status='publishing'` (`publish-product.ts:295-310`) and the worker is inside
`connector.createProduct` (up to 45 s per attempt, 2 attempts). The PUT lands: status → `in_review`,
`activeVersionId` → V2. SHOPLINE returns 201 for product P. `complete()` runs
`publishJobs.markPublished` — which succeeds, since its guard is job status plus lease token, neither
touched by the edit — then `listings.markPublished`, which throws at `listings.ts:494`. Both
statements are in one transaction, so **the remote product id and the `listing.published` audit event
are discarded together**. Product P is live in the merchant's store, `publish_jobs.remote_product_id`
is NULL, and re-approving V2 mints `${workspaceId}:${V2}:shopline:create` — a _different_ idempotency
key — producing a **second live product**.

The failure path is identically poisoned: `markPublishFailed` carries the same guard at
`listings.ts:524`, so `fail()` also rolls back and the job is left `running` with no recorded error.

**Fix.** Reject the edit when the listing is publishing, and derive `nextStatus` through
`transitionListing` so no caller can bypass the state machine.

---

## 2. A database error after a successful create is laundered into `remote_unavailable` and re-POSTs `/products` — **high**

**`apps/worker/src/publish-product.ts:400-421`**

`return complete(created.remoteProductId)` sits **inside the `try` of the create-retry loop**. Any
throw from the post-create transaction is therefore passed to `normalizeConnectorError`, which
returns `PublishDeliveryError("remote_unavailable")` for anything unrecognised
(`publish-product.ts:169`). Line 409 does not break on `remote_unavailable`, and the
between-attempt reconciliation at line 410 is gated on `job.remoteProductId` — which is **provably
always null at that point**: `publish-jobs.ts:207-217` is the sole writer of `remote_product_id` and
sets `status='published'` in the same UPDATE; `claim` (`:182-192`) never re-claims a published row;
and `publish-product.ts:238/256` early-return for a published job. The loop falls straight through to
a second `createProduct`.

**Failure scenario.** SHOPLINE creates product P and returns 201. A Neon/Hyperdrive reset, a
serialization failure, or the concurrent edit from finding 1 makes `complete()`'s COMMIT fail.
`createError = remote_unavailable`, no break, no reconciliation → **`POST /products` fires again in
the same invocation**. Nothing about P was ever committed, so no later delivery and no operator query
can reconcile it. The only thing standing between this and a duplicate merchant product is SHOPLINE
honouring the `idempotency-key` header (`shopline-connector.ts:158`), which this repo cannot verify.

The same guard is dead on the pre-flight path at line 380. The two tests that appear to pin
reconciliation (`publish-product.test.ts:471-535`) construct `{status:"running", remoteProductId:"…"}`
rows the repository can never produce — false assurance.
`docs/superpowers/specs/2026-07-19-shopline-publish-runtime-hardening-design.md:164` promises "the
Worker checks the ledger and remote status before attempting another create"; that ledger check is
unreachable code.

**Fix.** Move `complete(...)` outside the retry loop so only connector calls are classified by
`normalizeConnectorError`, and persist the remote id the instant `createProduct` returns — a small
committed write on the still-`running` row — so the reconciliation branches at 380 and 410 have an
input.

---

## 3. Lease bookkeeping is cleared inside the transaction, so a rollback skips `releaseStep` — **high**

**`apps/worker/src/listing-pipeline.ts:462-465`** (same pattern at `:350-353`)

`completionStep = "generated"; claimedStep = null; claimedLeaseToken = null;` executes inside the
`withWorkspace` callback, with `repos.listings.complete` (`:470`) and `repos.pipelineRuns.complete`
(`:476`) still to run in the same transaction. If either throws, Postgres rolls back `recordStep` —
the row is back to `state='running'` with its original lease token — but the in-memory nulling does
not roll back. The `catch` then evaluates `claimedStep === activeStep` as `null === "generated"` →
false, and `releaseStep` never runs on a lease this worker still owns.

**Failure scenario.** Generation succeeds. `listings.complete` throws — it has three in-band throws
(`listings.ts:722`, `:734` "listing status changed while completing pipeline", and the `audit.write`
at `:735`) plus the COMMIT itself. Because `attempt` is pinned to 1 (finding 5), the terminal branch
at `:494` is skipped and evaluation reaches `:511`, which no-ops. Had `claimedStep` survived,
`releaseStep` would have deleted the running row (`pipeline-runs.ts:433-443`, guarded on
`state='running'` AND matching token — a safe no-op if the step had actually committed) and the 30 s
redelivery would have re-claimed and finished. Instead the lease is orphaned and finding 4 takes
over: the message dead-letters and the draft sits at `processing`.

The test that appears to cover this (`listing-pipeline.recovery.test.ts:17-27`) passes only because
`pipeline-test-support.ts:69` implements `withWorkspace` as `return work(repos)` with **no rollback**.
The publish suite already has `makeTransactionAwareHarness` (`publish-product.test.ts:100-126`); the
listing suite does not.

**Fix.** Assign the bookkeeping after the callback resolves, not inside it. Add a rollback-aware
harness to `pipeline-test-support.ts`.

---

## 4. The 300 s stale-lease window exceeds the entire queue retry budget — **high**

**`packages/db/src/repositories/pipeline-runs.ts:300`**, with `apps/worker/src/listing-consumer.ts:18`

`const staleBefore = new Date(Date.now() - 300_000)` guards the reclaim UPDATE (`:312`). The listing
consumer returns a flat `RETRY_AFTER_SECONDS = 30` on every non-terminal outcome, and
`cloudflare-runtime.config.json` sets `maxRetries: 3` — so all redeliveries land within ~90 s of the
failure, always inside the 300 s window. Every one returns `{claimed:false}`, hits
`stepUnavailable = true` (`listing-pipeline.ts:330-332` / `:425-428`), and is short-circuited by
`if (stepUnavailable) throw error;` at `:490` **before any failure is recorded or lease released**.
With `maxConcurrency: 1` and `maxBatchSize: 1`, a non-stale `running` row on this queue is by
construction an orphan, not a live holder.

**Failure scenario.** `claimStep("extracted")` commits its own transaction, then the isolate is
evicted at `await deps.ai.extract(...)` (`:334`) — a call bounded at 240 s by
`openai-listing-provider.ts:84`. No catch runs. Redeliveries at ~+30/+60/+90 s all no-op; the message
dead-letters into `wukong-listing-dlq-production`, which has no consumer. Final state:
`listing_drafts.status='processing'`, `listing_pipeline_steps.extracted='running'`,
`listing_pipeline_runs.status='started'`, no `listing.pipeline_failed` audit row. The operator cannot
re-drive it — `process/route.ts:61` 409s on `status !== 'received'` and `:85` 409s again because a run
row exists — and the UI shows an indefinite `aria-busy` spinner.

**Fix.** Mirror the publish consumer: have `claimStep` return the blocking row's `updatedAt`, surface
it on the `stepUnavailable` path, and return `retryAfterSeconds = ceil((updatedAt + 300_000 - now)/1000)`
instead of the flat 30. Add a `shopline-consumer.ts:30-37`-style module-load assertion tying the lease
window to the queue budget. **Do not** simply shrink 300 s below 90 s — that lets a redelivery steal a
lease from a worker still inside a 120 s OpenAI call, causing double spend.

---

## 5. The listing consumer hardcodes `attempt: 1`, so exhausted transient failures are never recorded — **medium**

**`apps/worker/src/listing-consumer.ts:50`**

`consumeListingMessage(payload, env)` has no attempt parameter and passes literal
`{attempt: 1, maxAttempts: 3}`; `queue-consumer.ts:66` calls `consume(message.body, env)` and drops
`message.attempts` — which the SHOPLINE branch at `:53-56` demonstrably forwards.
`listing-pipeline.ts:246-247` normalises to 1 and 3, so the `attempt >= maxAttempts` disjunct at
`:494` is dead in production. The other disjunct still works: `isTerminalProviderError`
(`listing-consumer.ts:20-26`) covers `ProviderOutputError`/`ProviderRefusalError`/
`UnsupportedAssetError`, and those do fail correctly. What is unreachable is failure-on-exhaustion
for everything else.

**Failure scenario.** OpenAI 503s for ~2 minutes → `ProviderApiError`, which `isTerminalProviderError`
excludes. Every delivery takes the `releaseStep` branch and rethrows; each redelivery deletes the step
row and **re-runs `deps.ai.extract` from scratch** (4× extraction spend). After the 4th delivery the
message dead-letters with `listing_pipeline_runs.status='started'`, `error_code` NULL,
`listing_drafts.status='processing'`, and **zero `listing.pipeline_failed` audit rows** —
`listings.ts:748-768` is the sole writer of that action and its sole caller is the dead branch.
`listing-pipeline.recovery.test.ts:82-92` pins the intended contract by hand-passing `attempt: 3`,
which no production caller can produce. Same for any Hyperdrive/Neon or R2 error.

**Fix.** Give `consumeListingMessage` a third parameter mirroring `consumeShoplineMessage`, forward
`{attempt: message.attempts, maxAttempts: LISTING_MAX_ATTEMPTS}` from `queue-consumer.ts:66`, and set
`LISTING_MAX_ATTEMPTS = 4` — `maxRetries: 3` yields four 1-based deliveries, which is why
`SHOPLINE_MAX_ATTEMPTS = 4`. Note this alone does not restore operator re-drive;
`process/route.ts:61,85` still rejects.

---

## What held up under review

- **Workspace isolation.** Every path goes through `db.forWorkspace`, which sets `app.workspace_id`
  transaction-locally (`client.ts:106-108`) and constructs every repository against that transaction
  handle. No cross-workspace read was found.
- **The HMAC ingress.** Constant-time comparison (`cloudflare-queue.ts:73-85`), a 300 s replay window,
  exact-bytes signing over `timestamp\npath\nbody`, a 4 KB streaming cap, and it fails closed when
  `QUEUE_INGRESS_SECRET` is absent (`ingress.ts:88`).
- **The publish path's lease budget.** `shopline-consumer.ts:30-37` asserts at module load that the
  lease outlives the worst-case remote call and dies before the queue wall clock.

## Explicitly dropped

- **"Permanently stranded"** as an impact claim on findings 4 and 5. The documented manual DLQ replay
  (`docs/runbooks/production-ai-runtime.md:157-169`) does recover these runs: by replay time the lease
  is >300 s old, `claimStep` reclaims it, and completed steps are reused. The real harm is that
  _automatic_ recovery is structurally impossible and the state is operator-invisible.
- **"Guaranteed duplicate SHOPLINE product"** on finding 2 — downgraded. The `idempotency-key` header
  is sent on every create with a stable, version-scoped key, so a duplicate requires assuming SHOPLINE
  ignores it. The in-repo defect (dead reconciliation, DB errors triggering re-POST) is reported
  instead of the speculative remote behaviour.
- **The `started`-step instance of the lease-nulling bug** (`listing-pipeline.ts:292-293`). That step's
  `claimStep` runs inside the _same_ transaction (`:275`), so a rollback removes the step row along
  with the in-memory state. Only the `extracted` and `generated` sites are exploitable.
- Nothing was dropped as factually wrong on a direct read; all quoted lines matched the files.

## Suggested order of work

1. **Finding 1** — small, self-contained, and removes the worst scenario (a second live product from
   an ordinary operator action).
2. **Finding 5** — two lines, and it is a prerequisite for finding 3 behaving usefully.
3. **Finding 3** — mechanical move of four assignments, plus a rollback-aware test harness.
4. **Finding 2** — needs a schema-level decision about recording the remote id before `markPublished`.
5. **Finding 4** — needs a lease-budget design pass; do not shrink the window naively.

Before the first real write, run a live create against a sandbox store with an injected COMMIT failure
and confirm the ledger records the product id before anything else happens.
