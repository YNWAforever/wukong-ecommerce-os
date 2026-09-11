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
| unit suites, every package                           | **2482 passed**, 0 failed                                                   |
| — `@wukong/web`                                      | 1599 passed                                                                 |
| — `@wukong/shopline`                                 | 260 passed                                                                  |
| — `@wukong/worker`                                   | 190 passed                                                                  |
| — `@wukong/ai`                                       | 152 passed                                                                  |
| — `@wukong/db`                                       | 101 passed                                                                  |
| — `@wukong/assets`                                   | 73 passed                                                                   |
| — `@wukong/core`                                     | 96 passed                                                                   |
| — `@wukong/jobs`                                     | 11 passed                                                                   |
| — root `node --test` suites                          | 95 passed                                                                   |
| `packages/db` integration, real Neon-shaped Postgres | **384 passed**, 1 suite skipped (needs MinIO)                               |
| `db:migrate` (full chain, incl. `0022` and `0023`)   | ok                                                                          |
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

### What CI proved that this machine could not

GitHub Actions run [`34589711668`](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/34589711668)
went green on Linux with a real Postgres and a real MinIO, and it covers several
things recorded above as unrun. Every step below passed:

| Step                                     | Notes                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lint · Typecheck · Build                 | `pnpm lint` and `pnpm build` were never run on this machine                                                 |
| Unit tests                               | matches the local run                                                                                       |
| Integration tests                        | includes the `apps/web` suites and `product-shot-worker`, both of which need MinIO and were skipped locally |
| Production build                         | the trace manifests this branch's tracing fix depends on                                                    |
| Verify sharp's native library is bundled | 3 passed, **0 skipped** — the platform guard did not mask anything on Linux                                 |
| Playwright product-shot acceptance       | synthetic images                                                                                            |
| Playwright Wrangler Queue acceptance     | fake AI, mock SHOPLINE                                                                                      |
| Verify the completed Opak audit by draft | the `audit:verify` release gate, as a CLI                                                                   |

Still not run anywhere: `pnpm runtime:doctor`, which needs a real Cloudflare
account and a deployed Worker. Everything under "What the evidence does NOT
support" below stands unchanged — CI exercises the fake provider and a mock
SHOPLINE, so none of it speaks to a real model or a real storefront.

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
- **That an interrupted wave recovers in production.** The outbox is proven at
  the repository level against a real Postgres and at the service level with
  injected fakes; no request was actually killed mid-dispatch against a live
  queue. Recovery also happens on the next advance of the same batch, not on a
  timer, so a batch nobody advances again keeps its pending rows indefinitely --
  visible and safe, but not self-healing.
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
- The dispatch outbox behaves as the schema, not the code, promises: the unique
  index refuses a second row for the same run key, row-level security hides one
  workspace's pending work from another, a confirmed row is never re-dated, and
  an attempt counter stops once the row is sent.
- `TENANT_TABLES` covers the new table, and every composite foreign key is
  workspace-consistent -- both are existing invariants that failed until the
  outbox was declared in them, which is the test doing its job.
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
