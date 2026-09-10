# Wukong remediation — verification record

What was actually run, in what environment, and what it does and does not prove.
Companion records: [status](./wukong-remediation-status.md) ·
[decisions](./wukong-remediation-decisions.md)

## Environment

| | |
|---|---|
| Baseline | `9f72a37` (the audited commit; HEAD at start of work) |
| Branch | `codex/listing-grounding-diagnosis` |
| Node | v24.18.0 |
| pnpm | 11.7.0, via `corepack pnpm` (`corepack enable` cannot write to `C:\Program Files\nodejs`; `corepack prepare --activate` works) |
| Postgres / MinIO / Mailpit | **not started** — no Docker services were run |
| Provider | none contacted; no API key was used and no paid call was made |

## Commands run

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm --filter "@wukong/db..." build` | ok (required first; the worker suite cannot resolve `@wukong/db` otherwise) |
| `pnpm test` (root gate) | **14/14 tasks**, exit 0 |
| — `@wukong/web` | 1547 passed |
| — `@wukong/worker` | 175 passed |
| — `@wukong/ai` | 152 passed |
| — `@wukong/db` | 101 passed |
| — `@wukong/assets` | 73 passed |
| — `@wukong/jobs` | 11 passed |
| — root `node --test` suites | 78 passed |
| `typecheck` (ai, db, jobs, worker, web) | clean |

The root gate needs a `pnpm` shim on PATH, because `turbo` shells out to a
binary that `corepack pnpm` does not install:

```
pnpm.cmd:  @echo off
           corepack pnpm %*
```

Not run, and therefore not claimed: `pnpm lint` across all packages,
`pnpm build`, `pnpm test:integration`, `pnpm test:e2e`,
`pnpm --filter @wukong/db audit:verify`, `pnpm runtime:doctor`.

## Scenario coverage

Layer legend: **U** unit/contract · **I** DB/queue/storage integration ·
**B** browser journey + real-provider canary · **M** merchant UAT.

| ID | Scenario | Layer reached | Result |
|---|---|---|---|
| A01 | Diagnose the original failed run | — | **Not attributable.** Mechanism reproduced at U; the run's own `error_code` was never read. See status doc for the query. |
| A02 | Clear front label, no SKU / price / stock | U | **Passes.** Reaches review as a draft with those fields null; nothing is invented. |
| A03 | Optional-value nulls must not block generation | U | **Passes.** Generation gates on product identity; an absent region or vintage no longer routes to `needs_info`. |
| A04 | Two selections, second file fails | U | **Partly.** Selections accumulate and can be removed; per-file upload retry still re-uploads everything. |
| A05 | Create succeeds but the response is lost | U | **Passes.** The replay returns the same listing and writes nothing; genuine conflicts still 409. |
| A06 | Presign signature shape | U | **Partly.** No zero-byte checksum is signed, proven against the real SDK. A non-empty PUT against a live bucket is still untested. |
| A08 | `75 cl` / `0.75 L` / `750 ml`, `法國` / `France` | U | **Passes.** Converted and translated values ground; `700` from `75 cl`, `Italy` from `法國`, and the unlisted alias `Polska` are all still rejected. |
| A09 | Invalid schema / grounding rejection | U | **Partly.** The rejection no longer fires for correct extractions, and the checkpoint is now readable for `needs_info`. A `failed` run still saves nothing. |
| A10 | `needs_info` → supply info → re-run | U | **Passes.** The re-run is numbered and enqueued; a duplicate request while one is in flight is refused rather than billed twice. |
| A15 | Edited title, unsaved, then Approve | U | **Passes.** Approval is blocked with a stated reason; server-side freshness remains version-id based. |
| A07, A11–A14, A16–A30 | | — | **Not attempted.** Most need Postgres, MinIO, a browser, a real provider, or a merchant. |

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
  can produce `failed` is not the same as showing it produced *that* `failed`.
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
