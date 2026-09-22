# Jev listing verification operations

Jev listing verification is an optional server-side advisory. It is disabled unless TYPESAFE_VERIFICATION_MODE=advisory; absence means off. Advisory results do not replace deterministic compliance flags, workspace authorization, review transitions, or delivery eligibility.

| Variable                   | Source                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| TYPESAFE_API_KEY           | User-provided TypeSafe account API credential, stored only as a server secret |
| TYPESAFE_MODEL             | Explicit documented pinned model, initially jev-1.13.0 after verification     |
| TYPESAFE_VERIFICATION_MODE | Operator off/advisory selection; absent means off                             |

The verification operation has a five-second total timeout and no automatic retries. Provider failure produces an unavailable result while the normal listing workflow continues. Cost may be null when provider usage or pricing cannot establish it. Only text evidence is sent; images, audio, video, binaries, credentials, signed URLs, prompts, and raw provider responses are excluded from logs and provider state.

Treat stored verification versions as stale when the evidence, questions, thresholds, or pinned model changes. Existing batch budgets count only known observed costs; unknown costs are excluded rather than guessed. A local observed-cost cap is an operational guard, not a hard provider billing guarantee.

Apply the database migration and complete preview validation before activation. Production migration, deployment, paid evaluation, and activation each require separate production authorization.

To roll back, set TYPESAFE_VERIFICATION_MODE=off and render/deploy the configuration. TYPESAFE_API_KEY may remain installed while off, so rollback does not require deleting the secret. Off mode cannot issue provider calls. Work already in flight when the mode changes may complete under the configuration it read; confirm the queue has drained if an immediate operational boundary is required.

## Synthetic evaluation

Run the 40-case fixture validation without credentials or requests:

```powershell
pnpm.cmd --filter @wukong/ai eval:verification --dry-run
```

The default is also dry-run. The fixed fixture IDs cover ten variations per category (valid, unsupported claims, contradictions, translation), with five development and five holdout cases in each. Holdout source identities and wording differ from development. These deliberately small synthetic sets are exploratory; neither the tests nor a dry-run establish Jev quality on customer listings.

Boolean labels mean the named defect is present. The conflicting-source fixture labels the generation/extraction vintage mismatch and bilingual agreement only; source-truth labels are absent. The no-source fixture labels translation only, and the unsupported checks must remain unassessed. Other labels are reviewable alongside the synthetic inputs in `packages/ai/src/verification-eval-fixtures.ts`.

Live evaluation requires separate authorization, all four CLI gates, a server-side `TYPESAFE_API_KEY`, and an explicit versioned `TYPESAFE_MODEL` (for example `jev-1.13.0`, never an alias). This command is documentation only:

```powershell
pnpm.cmd --filter @wukong/ai eval:verification --live --confirm-synthetic --max-requests 40 --budget-usd 0.10 --output work/jev-evaluation.json
```

Requests run sequentially with the existing five-second verifier deadline and no retries. The evaluator stops before another request once the request count or observed estimated spend reaches its cap, or immediately after an attempted request whose cost is unknown. **Billing is not strictly capped: the last or in-flight call can exceed observed spend.** Unknown cost remains unknown rather than zero. The evaluator accesses no database or customer corpus. No production activation is implied.

Reports contain fixture IDs, labels, labelled assessed probabilities, and sanitized metadata; source inputs, prompts and raw provider responses are excluded. Each split/check reports exploratory thresholds 0.25, 0.5 and 0.75, assessed coverage, unassessed/skipped/unavailable/not-run counts, and exact confusion denominators. Empty rates are null; missing results never count as true negatives. Unsupported checks separate English and Traditional Chinese; the shared identity and translation judgments are marked bilingual because their API scores cannot be attributed to a single language. Reports also include nearest-rank p50/p95 operation latency, known estimated cost, unknown attempted-cost count, requested/actual model IDs and pricing versions. No production threshold is selected.

Without `--output`, the sanitized report goes to stdout. Only an explicitly supplied output file is created (its parent must exist), and an existing file is never overwritten. Keep reports with the evaluated commit and review labels before any separately authorized live run. Changing the model, prompts, corpus or labels invalidates earlier quality conclusions.
