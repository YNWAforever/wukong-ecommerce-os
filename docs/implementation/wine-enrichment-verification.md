# Wine enrichment implementation verification

Status: locally verified implementation suitable for a dormant draft PR; the full acceptance matrix remains incomplete.

## Scope

This report covers the local implementation on `codex/tavily-wine-enrichment-design`, based on `3ca5b99520e056bda99c0efbe87192e619026f04`. The browser/runtime checkpoint is `47db8a15fc6701b6da9217f1e82f673024e8bc26`. Corrective checkpoint `48215e3b52a3ffd1d36ef890397a780b757695a2` adds guarded Extract fallback and save/discard protection. Bilingual test checkpoint `33f4456d30b259a0cf353919234b14965205a579` exercises actual interactions in both locales. Remote CI is a separate check on the PR.

The new flow remains disabled by default. Local tests used synthetic provider responses and actual Web authentication, PostgreSQL, object storage, signed ingress and native Cloudflare Queue. No paid provider call, production migration, deployment, Tavily activation or SHOPLINE publication was performed for this feature verification.

## Implemented behavior

- Staged identity extraction, bounded research, source verification, bilingual generation and quality checks using the configured OpenCode Go model.
- Separate durable Go cost and Tavily credit accounting, including unknown outcomes and retry fencing.
- Tenant-scoped immutable input, source, stage and proposal records; current source authority is checked separately from historical provenance.
- Operator identity confirmation, source/evidence inspection, persistent paragraph drafts, protected manual corrections, section regeneration and explicit selected adoption.
- Deployment capability checks, compatible draining of accepted operations, additive migrations 0041–0044 and an activation/rollback runbook.

## Local verification

| Check                                       | Result                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broad lint / typecheck                      | 14 tasks passed each; affected final Web, Worker and database typechecks also passed.                                                               |
| Build                                       | All 8 tasks passed; Web rebuilt after the final identity grouping change.                                                                           |
| Root CI/configuration contracts             | 109 passed.                                                                                                                                         |
| Runtime formatting / forbidden dependencies | 264 runtime files checked; no forbidden dependencies, imports or runtime files.                                                                     |
| Browser acceptance                          | 9 authenticated journeys passed in 2.1 minutes, including full English and Traditional Chinese editing/adoption and keyboard identity confirmation. |
| Migration discovery/readiness               | 8 checks passed; actual local migration loader applied through 0044.                                                                                |
| Unit/integration regressions                | Package and focused runs completed after correcting the failures described below; overlapping counts are deliberately not added.                    |

Unit coverage included jobs, SHOPLINE, assets, core, AI, Worker, Web and database packages. Initial failures were stale feature metadata/vocabulary assertions and a Web test import of Worker-only types. Focused corrected tests passed. The local AI package run includes uncommitted evaluator work; it is not evidence for that evaluator being included in the PR.

Broad integration first passed 58 files/462 tests, with wine fixture collection blocked by the dedicated database-name guard and a schema inventory assertion. Failed files were rerun against a disposable isolated PostgreSQL cluster. Subsequent generation failures exposed old fixtures that assumed automatic activation; fixtures now execute the real explicit adoption transaction and exercise forged historical provenance, retained manual content and ancestry rollback. A genuine missing foreign-key child index was fixed with additive migration 0044. Applied migrations were not rewritten.

The broad integration suite includes cluster-level role-rename tests. Its database must be on a disposable cluster, not a shared development PostgreSQL service. Local verification used a task-owned cluster on port 54339; browser-only fixtures used the separate dedicated local database on port 54329.

## Final review corrections

A composed regression reproduced unreachable Extract for policy-approved client-rendered pages. Accessible empty documents now use the existing ready/eligible representation, and blank titles use the validated persisted parent source title. Existing immutable unavailable results are unchanged. A second regression reproduced draft reversal when discarding during save; discard is now guarded through save and refresh. Verification passed 147 focused unit/safety tests, 21 research/composition integration tests, both affected typechecks, Web build and Worker dry-run build.

## Browser evidence

The nine test runs cover these seven scenarios, with the full operator and ambiguity journeys executed in both locales:

1. Partial photo upload failure, retained successful upload, retry, persisted progress, accepted web-supported facts, duplicate Queue delivery without extra calls, navigation/draft recovery, paragraph editing and selected adoption.
2. Ambiguous vintage, rejected stale reference, two distinct eligible identity choices, keyboard selection and a new immutable input revision processed by Queue.
3. Conflicting source facts excluded from generated content.
4. Successful empty search with partial photo-supported content.
5. Transport uncertainty with an unknown credit hold and stopped work.
6. Source prompt injection without changing protected commercial fields.
7. An operator edit during processing that supersedes stale work.

English and Traditional Chinese interaction screenshots, persisted Chinese paragraph edits, readable paragraph and identity-choice captures, traces, stage IDs, versions, provider events and usage are retained in ignored local artifacts. CI uploads scoped screenshots/traces/evidence on success or failure. Certificate/private-key directories are excluded. Local screenshots were captured before the checkpoint commit with working-tree changes; remote CI must establish the clean committed-tree result.

## Explicit remaining gates

- Full HTTP cache-expiry replay is not covered; expiry has database integration coverage. Complete-cache reuse reconstructs immutable origin stages and call timestamps, so no fabricated history or clock bypass was added to claim a before/after HTTP result.
- Definitive Tavily failure fallback has handler integration coverage. Browser HTTP evidence separately proves successful-empty fallback and uncertain-transport handling. Current HTTP error handling conservatively retains unknown cost; a synthetic error is not treated as proof that billing is zero.
- Existing explicitly gated suites remain skipped without their dedicated migration-rehearsal databases or local harness configuration; no blanket skip was introduced.
- The 60-case evaluator and fixtures await human label review and remain uncommitted. No claim of at least 20% error correction, non-regressed live accuracy or p95 at most 180 seconds is made.
- Six real merchant products, two per category, require actual provider execution and merchant review.
- Production migrations, matching Worker/Web releases, Tavily credentials, workspace allowance and feature activation require the concrete release procedure in the runbook. Prior authorization for older recovery fixes is not a claim that these feature gates were executed.

## Review and remote status

Independent task and final branch reviews found no additional Critical or Important code defects through `33f4456d30b259a0cf353919234b14965205a579`. The bilingual follow-up at `33f4456d30b259a0cf353919234b14965205a579` changes only the browser spec. The branch is intended for a dormant draft PR; the two HTTP acceptance gaps above remain open. Remote CI and preview readiness must be checked on the PR and are not established by local results.
