# Wukong remediation — verification record

What was actually run, in what environment, and what it does and does not prove.
Companion records: [status](./wukong-remediation-status.md) ·
[decisions](./wukong-remediation-decisions.md)

## Environment

|                 |                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Baseline        | `9f72a37` (the audited commit; HEAD at start of work)                                                                              |
| Branch          | `codex/listing-grounding-diagnosis`                                                                                                |
| Node            | v24.18.0                                                                                                                           |
| pnpm            | 11.7.0, via `corepack pnpm` (`corepack enable` cannot write to `C:\Program Files\nodejs`; `corepack prepare --activate` works)     |
| Postgres        | **started** — `docker compose up -d postgres` (postgres:17-alpine, 54329), `wukong_app` role created, full migration chain applied |
| MinIO / Mailpit | **not started** — one integration file (`product-shot-worker`) is skipped for want of `S3_BUCKET`                                  |
| Provider        | none contacted; no API key was used and no paid call was made                                                                      |

## Commands run

| Command                                              | Result                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                     | ok                                                                          |
| `pnpm --filter "@wukong/db..." build`                | ok (required first; the worker suite cannot resolve `@wukong/db` otherwise) |
| unit suites, every package                           | **2475 passed**, 0 failed                                                   |
| — `@wukong/web`                                      | 1592 passed                                                                 |
| — `@wukong/shopline`                                 | 260 passed                                                                  |
| — `@wukong/worker`                                   | 190 passed                                                                  |
| — `@wukong/ai`                                       | 152 passed                                                                  |
| — `@wukong/db`                                       | 101 passed                                                                  |
| — `@wukong/assets`                                   | 73 passed                                                                   |
| — `@wukong/core`                                     | 96 passed                                                                   |
| — `@wukong/jobs`                                     | 11 passed                                                                   |
| — root `node --test` suites                          | 84 passed                                                                   |
| `packages/db` integration, real Neon-shaped Postgres | **317 passed**, 1 suite skipped (needs MinIO)                               |
| `db:migrate` (full chain, incl. `0022`)              | ok                                                                          |
| `check-runtime-format.mjs`                           | clean, 77 files, **0 waived**                                               |
| `typecheck` (ai, db, jobs, worker, web)              | clean                                                                       |

The root gate needs a `pnpm` shim on PATH, because `turbo` shells out to a
binary that `corepack pnpm` does not install:

```
pnpm.cmd:  @echo off
           corepack pnpm %*
```

| `pnpm format:runtime:check` | clean, 0 waived |
| `pnpm runtime:forbidden:check` | 310 files, 0 forbidden |

Not run, and therefore not claimed: `pnpm lint` across all packages,
`pnpm build`, `pnpm test:e2e`, `pnpm runtime:doctor`, and the `apps/web`
integration suites (they need MinIO as well as Postgres).

`packages/db`'s integration suites **were** run, against a real Postgres started
for this session. `audit:verify` is exercised inside them — the product-shot
cases assert 0 missing actions and 0 accessible foreign records — but the
standalone `pnpm --filter @wukong/db audit:verify` CLI was not invoked.

`format:runtime:check` compares against the audit baseline, so it flags every
file this branch touches. It was failing from the first commit until it was run;
the twelve files it named are now Prettier-clean. Two routes that were in the
hash-pinned format-debt waiver were formatted and **removed** from it rather
than re-pinned to new hashes, so the waiver shrank from five entries to three.
Its guard is exact and fail-closed in both directions, which is why the script,
`tests/ci-workflow.test.mjs` and `production-ai-runtime.md` all had to agree.

## Scenario coverage

Layer legend: **U** unit/contract · **I** DB/queue/storage integration ·
**B** browser journey + real-provider canary · **M** merchant UAT.

| ID                    | Scenario                                         | Layer reached | Result                                                                                                                                                           |
| --------------------- | ------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01                   | Diagnose the original failed run                 | —             | **Not attributable.** Mechanism reproduced at U; the run's own `error_code` was never read. See status doc for the query.                                        |
| A02                   | Clear front label, no SKU / price / stock        | U             | **Passes.** Reaches review as a draft with those fields null; nothing is invented.                                                                               |
| A03                   | Optional-value nulls must not block generation   | U             | **Passes.** Generation gates on product identity; an absent region or vintage no longer routes to `needs_info`.                                                  |
| A04                   | Two selections, second file fails                | U             | **Passes.** Selections accumulate and can be removed, and a retry re-sends only what did not finish — driven through the real component against a stubbed fetch. |
| A05                   | Create succeeds but the response is lost         | U             | **Passes.** The replay returns the same listing and writes nothing; genuine conflicts still 409.                                                                 |
| A06                   | Presign signature shape                          | U             | **Partly.** No zero-byte checksum is signed, proven against the real SDK. A non-empty PUT against a live bucket is still untested.                               |
| A08                   | `75 cl` / `0.75 L` / `750 ml`, `法國` / `France` | U             | **Passes.** Converted and translated values ground; `700` from `75 cl`, `Italy` from `法國`, and the unlisted alias `Polska` are all still rejected.             |
| A09                   | Invalid schema / grounding rejection             | U             | **Partly.** The rejection no longer fires for correct extractions, and the checkpoint is now readable for `needs_info`. A `failed` run still saves nothing.      |
| A10                   | `needs_info` → supply info → re-run              | U             | **Passes.** The re-run is numbered and enqueued; a duplicate request while one is in flight is refused rather than billed twice.                                 |
| A15                   | Edited title, unsaved, then Approve              | U             | **Passes.** Approval is blocked with a stated reason; server-side freshness remains version-id based.                                                            |
| A07, A11–A14, A16–A30 |                                                  | —             | **Not attempted.** Most need Postgres, MinIO, a browser, a real provider, or a merchant.                                                                         |

## What the evidence supports

- The grounding rejection is **deterministic and offline-reproducible**. It is a
  pure function of facts and evidence, so it does not depend on a provider, a
  network, or a model version.
- The `failed` state discards the extraction, writes no `aiRuns` telemetry, and
  holds the extraction step lease until it goes stale
  (`PIPELINE_STEP_LEASE_MS` = 300 s), so a redelivery inside that window is
  refused before the provider is consulted.
- Retry-from-`failed` works server-side: `reopenFailed` deletes running step rows
  and resets the run before re-enqueueing.

## What the evidence does NOT support

- **That production is fixed.** Nothing was deployed. No listing was processed by
  a real Worker, and no real provider was called.
- **That the historical incident had this cause.** Reproducing a mechanism that
  can produce `failed` is not the same as showing it produced _that_ `failed`.
- **That a real model produces gradeable output under the new prompt.**
  `listing-extraction@1.1.0` has never been sent to a provider. The existing
  `PLAYWRIGHT_E2E=1` harness runs `AI_PROVIDER=fake`, and the fake provider
  builds its evidence by slicing the note verbatim, so it can never exercise the
  grounding path a photograph takes. Real-provider verification remains
  **separate and outstanding**.
- **Classification accuracy.** `productType` is now grounded by citing the text
  it was judged from rather than by restating the value, which grounding cannot
  police without a knowledge base. This needs golden-set measurement.
- **The country alias table's coverage.** It is a closed table; unlisted
  languages fall back to verbatim matching and fail closed.
- **That a real queue rejects an over-long retry delay.** The product-shot budget
  delay was capped at 43200 to match `website-consumer.ts`, which is in-repo
  evidence of the ceiling, not an observation of Cloudflare refusing 86400.
- **Anything about the batch path end to end.** The stale-key, status-gate and
  cost-window fixes are covered by service-level tests with injected fakes. No
  batch was advanced against a real queue and a real Worker.
- **That the claim patterns catch a claim phrased outside them.** They are
  deterministic, English and Chinese only, and match wording rather than meaning.
  A score asserted in words the table does not list passes, and there is still no
  HK alcohol advertising rule set — `workspaceProfile.claimPolicy` is pasted into
  the model prompt and read by no deterministic checker.
- **That the superlative rule has no false positives.** One is already known and
  recorded in its own test: "best served at 10°C" is read as a rank claim. It is
  a warning, so a reviewer clears it, but the rate across real copy is unmeasured.
- **That the doctor's new checks read a real deployment.** `listing-provider` and
  `local-ingress-env` are pure functions tested against synthetic payloads. The
  command was not run against production, which is also why it is still unknown
  whether production is in fact serving `fake`.

## What the integration run does now support

Postgres was started this session, so these are no longer assumptions:

- The full migration chain applies cleanly from empty, including `0022`.
- `0022` is idempotent: applied twice in a row against the same database, which
  matters because `migrate()` re-runs every file on every invocation and keeps
  no applied-migrations table.
- Under the **pre-`0022`** constraint, writing `provider_disabled` raises
  `check_violation`. Reproduced directly, which is the evidence that the F06 fix
  would have failed in production while its unit tests passed.
- `finishUndispatched` writes `failed` for an undispatched attempt, refuses a
  dispatched one, and normalises an unrecognised code rather than letting it
  reach the CHECK.
- `audit:verify` reports **0 missing actions** and **0 accessible foreign
  records** for the new terminal state.
- A compliance flag survives `editReview`, and a resolved one keeps its
  resolution reason. Both cases were confirmed to **fail** with the fix removed,
  so they pin behaviour rather than restating it.
- A caller-supplied flag set replaces the carried one rather than adding to it,
  which is what lets a claim the operator edited out actually clear its flag,
  and the base version keeps its own flag history untouched.

## Unverified runtime gates

1. Deployed Worker build SHA, `AI_PROVIDER`, and configured listing model — in
   particular whether that model accepts image input at all.
2. The failed run's `error_code` and failing step for listing
   `ffc23109-7205-4d4d-b429-ca77706a239f`.
3. Behaviour of a real vision model against a real label under the new prompt
   and grounding modes, with authorized photographs.
4. Whether any historical `listing_pipeline_steps.output` row fails the
   defensive re-parse in `listing-processing-summary.ts` — it degrades rather
   than throwing, but the rate is unmeasured.
5. How many `product_shot_attempts` rows are currently sitting `queued` with no
   terminal state. The fix ends new ones; it does not sweep existing ones, and
   each such row also blocks its listing from ever being approved:

   ```sql
   select workspace_id, listing_id, id, created_at
   from product_shot_attempts
   where state = 'queued' and dispatched_at is null
     and created_at < now() - interval '1 hour';
   ```

6. Whether any `enrichment_batches` row is currently `budget_exhausted` purely
   because of pre-batch spend. Those become advanceable again under D11, and an
   operator who read that status as "this cohort is finished" will see it
   resume:

   ```sql
   select id, label, budget_usd, created_at
   from enrichment_batches where status = 'budget_exhausted';
   ```

## Deployment order, now two constraints

1. **Migration `0022` before the Worker.** A Worker that writes
   `provider_disabled` against the un-widened CHECK raises `check_violation` on
   exactly the path meant to stop an attempt disappearing.
2. **Worker before the web producer** (unchanged, from D4). An older Worker
   parses `listingJobSchema` strictly and silently acks away any message
   carrying `runAttempt` — which the batch path now sends too, not just the
   manual re-run route.
