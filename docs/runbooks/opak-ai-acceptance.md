# Opak AI maintenance acceptance

This harness implements the approved T11 audit-fixture mapping and deterministic safety checks. A dry run is not an AI accuracy result. No live provider evaluation or low-resolution image experiment is authorized by the current local implementation approval.

## Fixtures and boundaries

`packages/ai/fixtures/opak-maintenance-v1.json` contains twelve newly written synthetic counterparts to AI01–AI12. It uses the explicit `audit-fixtures-v1` schema, not the older listing-verification CLI format. The adapter checks all twelve unique IDs, the eight required evidence fields, partial fact types, merchant expectations, manual locks and revision identity. Missing fact keys remain absent; explicit nulls remain null. SKU strings retain their leading zeroes.

The original audit fixtures stay in the private evidence archive outside Git. An external file may be mapped with `--fixtures`; dry output contains only controlled IDs, versions, digests, source IDs, revisions and invariant witness counts. It contains no input text, prompts, generated output or numeric quality score. The archive's `synthetic` flag is recorded as metadata and is not authorization to send its contents to a provider.

AI07 and AI11 are holdout cases. Use `--split=development` while tuning; preserve the holdout file and evaluate it only after freezing prompts and policy. A twelve-case report is a focused acceptance sample, not a calibrated general accuracy estimate.

| Case | Acceptance boundary                                                            |
| ---- | ------------------------------------------------------------------------------ |
| AI01 | Wrong vintage for the same producer                                            |
| AI02 | Explicit NV and a publication year                                             |
| AI03 | Age/edition versus vintage                                                     |
| AI04 | 75cl conversion and decimal ABV                                                |
| AI05 | Sake polishing ratio versus alcohol                                            |
| AI06 | Six-pack, per-bottle volume and merchant facts                                 |
| AI07 | Rating for another vintage; holdout                                            |
| AI08 | Untrusted source instructions and invented ratings                             |
| AI09 | Missing facts; live blocked without an authorized low-resolution image fixture |
| AI10 | Late manual edit and old run; service/worker evidence required                 |
| AI11 | Bilingual proper noun; holdout                                                 |
| AI12 | Glassware/other and pack quantity                                              |

## Zero-provider verification

From the repository root, choose a new private output filename:

```powershell
pnpm.cmd --filter @wukong/ai eval:opak-maintenance --dry-run --output "$env:TEMP\opak-maintenance-dry.json"
pnpm.cmd --filter @wukong/ai exec vitest run scripts/opak-maintenance-fixtures.test.ts scripts/opak-maintenance-live.test.ts --maxWorkers=1
pnpm.cmd --filter @wukong/ai typecheck
```

An external audit file can be mapped by adding `--fixtures <private-file>`. Do not copy the original file, its prompts or its source text into Git, issue bodies or PRs. Files are opened exclusively: an existing output is never overwritten. Repository output paths are rejected except the ignored `node_modules/.opak-evidence/` directory. A symlinked parent is resolved before enforcing this boundary. Unix output mode is 0600; on Windows use an appropriately private user directory and its inherited ACL.

The deterministic witnesses check known facts and explicit unknowns, the eight-field copy allowlist, merchant-only SKU/price/stock, manual locks, current revision, workspace/listing identity, exact frozen source IDs, unsupported structured ratings/awards, simple copy claim patterns and no publication. They deliberately do not assess natural-language entailment, completeness, bilingual quality or general medical-claim safety. Those require human review.

AI10 is not a single-prompt evaluation. Run the existing local tests separately:

```powershell
pnpm.cmd --filter @wukong/web exec vitest run lib/listing-operation-service.test.ts --maxWorkers=1
pnpm.cmd --filter @wukong/worker exec vitest run src/listing-operation-pipeline.test.ts --maxWorkers=1
```

The service test rejects stale input before paid/queued work. The worker tests cover immutable persisted input, trusted locked fields, a late candidate, and ten concurrent maintenance operations with five late human corrections. Their provider calls are explicitly fake; they demonstrate adoption/revision safety, not real-provider quality. Database RLS/adoption and browser evidence are separate release checks.

## Controlled live admission

Live mode requires separate explicit authorization for the particular test data, provider and budget. It never uses fixture gold answers as provider input. Every required gate below must be set deliberately; secrets belong in the process environment and must never be pasted into evidence or command logs:

- `OPAK_EVAL_LIVE_AUTHORIZED=1` and CLI `--confirm-authorized-data`.
- `OPAK_EVAL_PROVIDER=openai` and an authorized `OPENAI_API_KEY`.
- `OPAK_EVAL_MODEL` with an explicit dated model suffix `YYYY-MM-DD`.
- `OPAK_EVAL_PRICING_VERSION` and positive `OPAK_EVAL_INPUT_USD_PER_MILLION` / `OPAK_EVAL_OUTPUT_USD_PER_MILLION`, verified for that model/provider.
- `OPAK_EVAL_MAX_INPUT_TOKENS`, a positive integer text-only conservative bound. The serialized UTF-8 request plus 4096 tokens of protocol/schema overhead must fit it.
- CLI `--mode=live --budget-usd <positive-number> --output <new-private-file>`; optionally `--max-requests <1..48>` and `--split=holdout`.

After these gates have been authorized, the invocation shape is:

```powershell
pnpm.cmd --filter @wukong/ai eval:opak-maintenance --mode=live --budget-usd <authorized-positive-budget> --confirm-authorized-data --include-private-content --output <new-private-file>
```

Without the gates the CLI writes a blocked metadata report, exits 2 and makes zero provider requests. It does not fabricate a quality pass. Dry mode does not construct a provider or read its credentials.

The current live adapter evaluates the existing note-only `OpenAIListingProvider` extraction and generation stages, projecting the generated candidate onto the authoritative eight maintenance copy fields. It does not run production worker adoption, paid web research, wine verification/check orchestration, SHOPLINE delivery or publication. Source inputs keep stable IDs and digests; the provider's provenance remains the aggregated note. Mapping those IDs records the frozen inputs, not evidence that each passage entails each output claim. Human source-grounding review is mandatory. AI09 and AI10 remain explicitly blocked in a live model report rather than counted as passed.

The transport disables SDK automatic retries and checks every physical request, including schema repair, against the request cap and remaining conservative token-price reservation before I/O. The output limit is 4096 tokens. Responses with missing usage and API-error attempts have unknown cost, represented as `usd: null`; the run stops before another physical request or repair. Token-derived cost is `estimated`, not a billed amount. A response exceeding the input/output bound stops further work. The configured rates and text-only bound must be checked for the chosen provider; this is an admission reservation, not proof of the provider's final invoice.

A private live report records model/prompt/adapter/policy/pricing versions, input and output digests, revisions, frozen source IDs/digests, latency, physical request count, cost certainty and deterministic failure codes. `--include-private-content` additionally retains source text and candidate output in that private artifact for human review. It is rejected in dry mode. Console output is restricted to controlled run metadata; provider errors and source/output content are never logged. A metadata-only live artifact is insufficient for human copy review unless the reviewer separately has the exact private sources/output matching its digests.

## Human verdict and acceptance

Every item starts with `humanVerdict: null`. The CLI never fills or generates a human verdict. A human reviewer must inspect the exact private sources, output and deterministic failures, then fill the following dimensions independently for each item:

| Dimension                             | Maximum |
| ------------------------------------- | ------: |
| Product identity and factual accuracy |      35 |
| Source grounding                      |      20 |
| Bilingual expression/proper nouns     |      15 |
| Business usability                    |      15 |
| Safety/protected-field behavior       |      15 |

Use a `reviewer`, ISO `reviewedAt`, `identityFacts`, `sourceGrounding`, `bilingual`, `businessUsability`, `safety`, and integer `hardFails` in a private verdict. `gradeHumanVerdict` validates these values. Acceptance requires **each item >=90/100 and zero human or deterministic hard failures**. Averages cannot conceal a failed item. Pending, blocked, missing output, unknown-cost interruption or absent human review is not an acceptance pass.

Hard failures include wrong identity/vintage/volume/pack, unsupported rating/award/medical claims, changed SKU/price/stock, unauthorized publication, cross-workspace/listing leakage and overwriting a newer manual correction. Do not fill unknown facts with common 750ml/13.5% defaults. A proper-noun or semantic defect may require human rejection even if all deterministic checks pass.

Preserve private original evidence, a versioned development/holdout split, admitted run evidence and independently filled human verdicts. Roll back the local harness by reverting only its scoped script, test, synthetic fixture, runbook and package-script changes; it creates no database rows or production state. No current dry evidence authorizes live execution or a claim of Opak AI quality.
