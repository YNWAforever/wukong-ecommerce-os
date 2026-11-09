# Final audit — Phase 4 AI backend (2026-10-05)

Baseline: PR #121 head `84006670`, branch `claude/final-audit-ai`. No provider
was activated, no paid call was made, and SHOPLINE stays mock/disabled. SDK
behaviour was checked against the installed `openai` package, not from memory.

## Routing table (as implemented)

| Stage                         | Provider / adapter                                          | Model source                                               | Retries and timeout                                                            | Budget                                                           |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Listing extract               | OpenAI, OpenRouter, OpenCode Go or fake (`operation-ai.ts`) | Frozen per operation from the workspace `listingAi` policy | SDK `maxRetries: 0`; per-call deadline 1–600 s; Queue: 3 retries, then the DLQ | `ai_budget_reservations` per operation; conservative run ceiling |
| Listing generate              | Same adapter and model as extract                           | Same policy                                                | Same                                                                           | Same reservation                                                 |
| Legacy listing (no operation) | OpenAI or OpenRouter (`createProvider`)                     | `OPENAI_LISTING_MODEL` or `OPENROUTER_LISTING_MODEL`       | Same                                                                           | None (legacy path)                                               |
| Wine stages                   | OpenCode Go (`deepseek-v4.1-flash`)                         | Accepted execution snapshot                                | At most 10 physical calls per flow; started/unknown calls are never replayed   | USD 10 cumulative workspace cap                                  |
| Wine research                 | Tavily                                                      | n/a                                                        | Reserved credits                                                               | Tavily credit reservation                                        |
| Verification advisory         | TypeSafe Jev                                                | `TYPESAFE_MODEL` (pinned)                                  | 5 s, no retries                                                                | Observed-cost cap                                                |
| Product shot                  | Photoroom                                                   | n/a                                                        | Lease and cutout checkpoint; uncertain outcome needs explicit consent          | Daily dispatch allowance                                         |

Extraction and generation use one model per policy. A cheap-extract /
strong-generate split would be a policy and configuration change that
activates a second model, so it is listed under decisions and was not made.

## Checklist

| Item                                             | State                         | Evidence                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict structured output, unknown as `null`      | **Met**                       | Responses `parse` with strict JSON schema, `buildSafeListing`, one schema repair only; "every absent protected fact must be null" (`prompts.ts`)                                                                                                                             |
| Prompts use only source facts; flag the rest     | **Met**                       | Prompt rule plus `fact-grounding-rules.ts` grounding modes, claim policy and compliance flags; human approval is mandatory                                                                                                                                                   |
| Untrusted input delimited and declared           | **Fixed (M1)**                | Instructions now declare notes, label/photo text, workbook cells and web pages untrusted. Source material is JSON in the user turn only. Hostile-note test asserts the system turn is unchanged and the output schema stays strict                                           |
| Prompt versions recorded on runs                 | **Met** (version, not digest) | `LISTING_PROMPT_VERSIONS` pinned per operation (`execution.promptVersions`) and recorded in the `ai_runs.input` JSON (`promptVersion`); bumped to extraction 1.2.0 / generation 1.1.0                                                                                        |
| Wine-domain fields                               | **Partly**                    | Schema covers producer, region, vintage, grapes, ABV, volume and pack. Tasting notes and food pairing are not schema fields (see decisions)                                                                                                                                  |
| HK alcohol-listing compliance lines              | **Not present**               | The compliance module has no alcohol-specific rule, so per the brief none was added (see decisions)                                                                                                                                                                          |
| Idempotency and redelivery                       | **Met per run**               | Leases plus recorded step output keyed `listing:<ws>:<draft>:<seq>` / `listing-run:<id>`; redelivery does not re-bill. No cross-run cache keyed by content + prompt + model digest (see decisions)                                                                           |
| Per-workspace token and cost accounting          | **Met**                       | `ai_runs` stores counts and cost only; the quality endpoint snapshots known cost and unknown-cost run counts                                                                                                                                                                 |
| Daily allowance for listing AI                   | **Absent**                    | Exists for product shots and the wine cap, not for listing AI (see decisions)                                                                                                                                                                                                |
| Timeouts, bounded retries, typed provider errors | **Met**                       | SDK retries off; Queue retries bounded; `ProviderApiError` categories; terminal vs transient classification in `listing-consumer.ts`                                                                                                                                         |
| Circuit breaker                                  | **Absent**                    | See decisions                                                                                                                                                                                                                                                                |
| Website-scan HTML into prompts                   | **None on the scan path**     | Scan output is read-only observations. The wine path already declares sources untrusted and has a browser injection case                                                                                                                                                     |
| Evals                                            | **Met**                       | #121 adds 12 synthetic Opak cases (`fixtures/opak-maintenance-v1.json`, including AI08 untrusted instruction), hard-fail rules and dry/live modes. The fixture test runs in `pnpm test`. New `pnpm eval:live` is a gated alias; locally it reports `blocked` with 0 requests |
| Product-shot uncertain-outcome consent in code   | **Met**                       | `nextShotAction` returns `confirm_charge`, and `explicitFreshAttempt` is re-checked under the listing lock (Phase 1, Verified OK)                                                                                                                                            |

Instruction-like text is **not stripped** from source material. Extraction
evidence must quote the source verbatim for grounding, so rewriting the input
would break grounding. The defence is declaration, structural separation, the
strict schema, grounding validation and human review.

## Decisions (not implemented)

1. Cheap/strong model split per stage. This is a policy change that activates
   a second model.
2. Cross-run cache keyed by content digest + prompt digest + model. Needs a
   table, so a migration numbered `0054` or later.
3. Daily listing-AI allowance per workspace, modelled on the product-shot
   allowance. Needs a policy field and storage.
4. Provider circuit breaker. Pause dispatch after N consecutive transient
   failures per provider.
5. HK alcohol-sale notice and tasting-note / food-pairing fields. These are
   legal and catalogue-schema decisions for Opak.
6. Record a prompt content digest beside the version.

## Rollout note for M1

Accepted operations pinned to the old prompt versions refuse with "Accepted
prompt versions are unavailable; start a new retry". Deploy with the listing
queue drained, or expect affected drafts to need a new retry.
