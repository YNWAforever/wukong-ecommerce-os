# Astra 6 T02/T07 diagnostics and claim safety

> Integration update: this file records its original implementation slice. Parent wiring, final fixes and combined checks are recorded in [the consolidated delivery evidence](astra6-delivery-evidence.md). Earlier pending sibling-work notes below are historical.

Date: 2026-09-16
Branch: `codex/astra6-recovery`
Baseline: `63a6f762e67ebcc1d106334b59b04b45afe3d6b4`

## Claim safety regression

The reproduced defect was an aggregate evidence shortcut: any `criticScores` or `awards` row made every rating claim pass. Both focused regressions failed before the fix:

- Robert Parker 100 passed with only an unrelated 2020 Bronze medal.
- Robert Parker 100 passed with only Wine Spectator 85.

`scanCompliance` now parses the claimed critic/alias and numeric score and requires one grounded critic-score fact to match both. An award can support an award claim but cannot support a critic score claim. Existing behavior when the caller supplies no grounded-claims context remains fail-silent because support cannot be determined at that boundary.

This is bounded A27 groundwork. Product, vintage, variant, award name/year, and evidence-source identity matching remain open for the later enrichment contract.

## Safe provider diagnostics

`ProviderDiagnostic` exposes only:

- category and retryability;
- allowlisted HTTP status and provider code;
- a format-limited provider request ID.

Categories are `rate_limited`, `timeout`, `invalid_media`, `refusal`, `invalid_output`, `missing_configuration`, `provider_unavailable`, and `internal`. Provider message text, request bodies, signed URLs, prompts, and model output are excluded by construction. OpenAI and OpenRouter transport errors now carry this diagnostic on `ProviderApiError`. This does not assign a new cause to the historical production incident.

`PhysicalInvocationObserver` is the Worker-facing adapter contract. It records one ordinal and phase per physical request, outcome, safe diagnostic, and nullable input tokens/output tokens/cost with measured/estimated/unknown certainty. Unknown usage is explicitly `null`, never zero.

## Parent Worker/DB wiring hooks

The parent should wire the interface at these boundaries:

1. Before each `responses.parse` or chat completion request, append a pending `ai_runs` physical invocation keyed by `pipelineRunId + stage + ordinal`.
2. Pass an observer into the selected provider adapter. Finalize that exact invocation for every observer record, including refusal and invalid output.
3. When adapter transport throws `ListingProviderError`, persist `error.diagnostic`; do not persist `error.message` as provider detail.
4. If provider usage is absent or send outcome is ambiguous, store token/cost columns as `NULL` and certainty `unknown`. Do not automatically retry a possibly charged call after lease expiry.
5. Terminalize the owned pipeline step independently. AI invocation accounting is append-only evidence and must survive later schema/grounding rejection.

No `ai_runs` migration or repository mutation was added in this slice because the parent is concurrently defining the pipeline-run identity in migration 0029 and Worker orchestration. The next coordinated additive migration should add `pipeline_run_id`, stage/call ordinal identity, safe diagnostic columns, provider request ID, usage certainty, and nullable estimated cost, then add the observer to both concrete adapter configs. This avoids baking an incompatible identity into 0030 before 0029 settles.

## Evidence and open gates

| Check                    | Result                         |
| ------------------------ | ------------------------------ |
| Compliance red state     | 2 expected failures reproduced |
| Compliance green state   | 43/43 passed                   |
| Diagnostic contract      | 8/8 passed                     |
| OpenAI adapter tests     | 42/42 passed                   |
| OpenRouter adapter tests | 60/60 passed                   |

A02 remains open for a newly instrumented Worker canary with safe stage correlation and terminal step evidence. A17 remains open for persisted physical invocation rows across 429, timeout, refusal, invalid schema, and ambiguous outcomes. No paid call, live provider request, production read/write, deployment, or historical-cause assertion was performed.
