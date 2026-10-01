# Opak maintenance fix status

Execution date: 2026-10-01 (Asia/Hong_Kong). Plan: [approved implementation plan](2026-10-01-wukong-opakcellar-fixes.md).

## Baseline and custody (T00)

- Repository remote: `https://github.com/YNWAforever/wukong-ecommerce-os.git`.
- Local root, refreshed remote main, and current production web SHA: `dde9e178d9e1f9ca8880618c63104f41fe2fa3be`. This is the starting baseline, not a rollback target.
- Production: `dpl_4UtLTAFZmKDsyPgPKtvHMBBBbDxm`, READY, iad1. Verified through Vercel on execution date.
- Isolated managed worktree: `opak-runtime-recovery`, branch `codex/opak-runtime-recovery`. Existing root untracked directories and both older linked worktrees remain untouched.
- Evidence archive SHA256: `030a64f578190959d69246c5a6cf372dc1aac155388ae1e5107079c84f09e822`, matches master plan. Extracted outside Git into host temporary storage. Customer records, screenshots and browser snapshots must remain there.
- Read complete master plan, audit Markdown, original UC01-UC30 CSV and AI01-AI12 fixture contracts. Original counts and outcomes are historical observations only.
- PR #120: OPEN / DRAFT / unmerged, head `8206c3429004e2a7e7a2bb38bd8382f8ea34d2d1`, base current main. All 12 changed-file patches inspected. No merge/cherry-pick. Preserve its bulk response validation, missing-version explanation, safe ingress diagnostics, approval audit ownership, and publish/import race protection when the relevant task changes those modules. None establishes the F01 cause.
- Node `24.18.0`, pnpm `11.7.0`; frozen install passed. Existing local Docker project had no running services; local Postgres 17, MinIO, TLS proxy and Mailpit started. Test adapters: fake AI / mock SHOPLINE; publishing disabled.
- Root web environment database URLs were checked only for locality: loopback, not Neon. No production credentials copied into the worktree.
- Worker production deployment: `af414db8-9b1a-4c18-ab86-0abd65454601`, created 2026-08-16T17:42:14.980313Z; active version `fa79610e-eb8d-4362-90d2-3791023945f1` (number 6, 100%). Verified through read-only Wrangler metadata. Commit SHA **unknown**: deployed artifact metadata exposes no `BUILD_SHA` binding/commit annotation. No inferred match to web SHA.
- User-identified Neon project: `weathered-lake-51694428`, primary/default branch `br-twilight-meadow-at9qky4q`, database `neondb`, Postgres 17.11. Production catalog has 54 public tables; tenant RLS is enabled/forced and `wukong_app` is non-superuser/non-bypass with SELECT. The source-binding columns and foreign key required by existing migration 0046 are missing. Effective web connection identity remains a release check; metadata inspected through the Neon connector does not certify the runtime credentials.
- Browser read reproduction: **blocked** by desktop browser sandbox startup (`apply deny-read ACLs`), before any page/session access. Vercel logs independently confirm both listing GETs and queue GET returned 500 on this deployment; no claim of fresh authenticated reproduction.
- Code graph index: automatic approval review rejected possible external code transmission. Use local code discovery as the safer alternative; do not retry via another export path.
- Shell sandbox startup also fails before commands. Read/build/local-only commands use reviewed escalations. This is an environment limitation, not a product regression.

## Finding register

| Finding                           | Initial classification | Evidence / next verification                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 detail/queue 500              | reproduced             | Production schema lacks two columns read by `getReviewSnapshot`; zero-row projection fails 42703. Actual local missing-column regression reproduces both routes and existing 0046 restores them without content changes. Fresh authenticated production reads and repair are blocked; historical minified logs cannot prove this is the only cause. |
| F02 reference intake dead end     | reproduced             | Same main and inspected reference-only importer; T03 must preserve immutable source binding.                                                                                                                                                                                                                                                        |
| F03 old rawRow cohort / 5000 cap  | reproduced             | Same audit source baseline; T04 current-content/fence regression pending.                                                                                                                                                                                                                                                                           |
| F04 source/draft statistics scope | reproduced             | Audit UI and unchanged baseline; distinguish records from unique products.                                                                                                                                                                                                                                                                          |
| F05 account/logout/role guidance  | reproduced             | Audit UI and unchanged shell; T08 role/API tests pending.                                                                                                                                                                                                                                                                                           |
| F06 recovery/support              | changed                | T01/T02 add validated support IDs, explicit blocked rows/sections and retry. Batch/cost recovery remains T06/T08.                                                                                                                                                                                                                                   |
| F07 catalog/detail layout         | reproduced             | Audit screenshots; new browser behavior still unverified.                                                                                                                                                                                                                                                                                           |
| F08 URL state                     | reproduced             | Audit snapshots and unchanged source; T07 regression pending.                                                                                                                                                                                                                                                                                       |
| F09 performance                   | blocked                | Source risks confirmed; no latency/query-plan measurements yet.                                                                                                                                                                                                                                                                                     |
| F10 quality/cost                  | reproduced             | Existing signals are advisory; AI fixtures have no live verdicts.                                                                                                                                                                                                                                                                                   |
| F11 admin dirty guard             | reproduced             | Source unmount behavior; authenticated admin runtime test pending.                                                                                                                                                                                                                                                                                  |
| F12 draft/readiness guidance      | changed                | No-active-version manual guidance and operator/reviewer browser read verified locally. Intake/readiness integration remains T03/T09; cloud runtime readiness not certified.                                                                                                                                                                         |

## Task ledger

- [x] T00 baseline and version inventory, evidence custody, full document review and PR #120 comparison recorded.
- [ ] T01 local root cause, safe diagnostics, read-only preflight and true schema-repair regression complete; production repair/fresh authenticated acceptance remain blocked. See [recovery/release pack](../../runbooks/opak-runtime-recovery.md).
- [x] T02 classified row isolation and explicit section degradation verified by route/component/real DB and operator/reviewer local production-build browser cases. Cloud production acceptance remains separate.
- [ ] T03 existing maintenance intake / identity binding.
- [ ] T04 current-content gaps / cursor cohort / fences.
- [ ] T05 explicit cross-page selection / immutable preview / selected fields.
- [ ] T06 pause / retry-failed / unknown-cost recovery.
- [ ] T07 catalog / URL / return context.
- [ ] T08 account / role / assignment / support.
- [ ] T09 dirty guard / actual readiness.
- [ ] T10 measured DB performance.
- [ ] T11 audit-fixtures-v1 adapter / quality / cost harness.
- [ ] T12 bulk approval / XLSX cell protection / independent results.
- [ ] T13 role matrix / UC01-UC30 / operations runbooks.
- [ ] T14 release / compatible rollout / rollback pack.

## Dependency preflight

| Producer -> consumer  | Shared contract / decision                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| T01/T02 -> all        | Opaque request ID + allowlisted stage; global DB/session failures remain HTTP errors.                       |
| T03 -> T04/T05/T12    | Store/remote identity + immutable source digest; reference rows never become exportable by toggling a flag. |
| T04 -> T05/T06/T12    | Current working/active content and input/version/source fences; preview must reject stale create/enqueue.   |
| T05 -> worker/T11/T12 | Exactly eight content fields; merchant IDs/SKU/price/stock/manual locks preserved at apply.                 |
| T06 -> T10/T11/T14    | Unknown provider outcome retains reservation and reconciliation lineage.                                    |
| T08/T09 -> T13/T14    | Server membership/role and readiness observation; assignment is not approval.                               |
| T12 -> T13/T14        | Artifact generated / merchant reported / independently verified remain distinct.                            |

Ruling: Execute the supplied T00-T14 plan inline, retaining this ledger and per-task checkboxes. The supplied plan is the approved implementation scope; do not re-open already authorized implementation decisions. Production migration/merge/deploy/first SHOPLINE write remain subject to actual authorization and repository release gates.

## Verification evidence

Safe command logs are in this plan's ignored `.superpowers/sdd/2026-10-01-wukong-opakcellar-fixes/` directory. Record exit codes, fresh versus cached checks, dataset, role and adapters per run. Unit, local real DB, mock browser, production read, live AI and merchant acceptance must be reported separately.

### Batch A: T00-T02

Behavior: typed malformed records stay visible with a support ID; blocked selections cannot be newly selected or retained after an observed blocked reload. Healthy records remain usable, no-version drafts stay manually editable, activity/preview degradation is explicit, and unknown critical source data blocks delivery. Global DB/permission failures stay HTTP failures. Imported approval/export repeat the source-time check at the authority boundary. Instrumented diagnostics omit untrusted exception names/sites and raw messages.

Failure evidence: production zero-row projection fails on `source_import_id`; catalog inspection finds both source-binding columns/FK absent. Local real DB tests remove those columns, observe detail/queue 500 with safe stages, apply existing 0046, then verify 200 and unchanged version content/count. Production repair and authenticated read verification are **blocked**, not passed. Malformed active version is a separate synthetic per-row regression, not a claim about merchant records.

Baseline: frozen install passed; `pnpm test` root 116 passed, unrestricted web suite had two existing timeout failures. Isolated vocabulary tests 7/7 and bounded full package suite passed. `pnpm typecheck` 14 tasks and `pnpm build` 8 tasks passed. Original evidence's eval dry run had 40 fixtures/20 holdout and **0 provider requests**; that is not measured AI accuracy.

Fresh commands/results after implementation and review:

| Verification                                                                                                            | Result / scope                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted route/component/authority tests after review                                                                   | 163 passed across 6 files; preserves original approval/export source/version/CAS tests                                                                                                                                     |
| `pnpm exec vitest run --config vitest.integration.config.ts apps/web/app/api/listings/runtime-read.integration.test.ts` | 7 passed with explicit `WUKONG_OPAK_INTEGRATION=1`, dedicated loopback DB; no migration-dir override, actual role/permissions/schema repair                                                                                |
| `pnpm exec playwright test tests/e2e/opak-runtime-read.spec.ts --project=chromium --workers=1 --retries=0`              | 2/2 operator/reviewer through local production build, Better Auth and RLS; fake/mock, zero listing writes, synthetic screenshots inspected                                                                                 |
| Root Node suites                                                                                                        | 116/116 passed, fresh execution                                                                                                                                                                                            |
| `pnpm exec turbo run test --concurrency=1 -- --maxWorkers=4`                                                            | 3,665 package tests passed, 1 existing asset-provider opt-in skip; 14/14 tasks (13 cached, web fresh 2,006 tests). DB/worker and other cached results originate from the immediately preceding successful unchanged checks |
| `pnpm typecheck`                                                                                                        | 14/14 tasks, 11 cached and 3 fresh, exit 0                                                                                                                                                                                 |
| `pnpm build --filter=@wukong/web`                                                                                       | 6/6 tasks, 4 cached and 2 fresh, exit 0; actual compiled server used for latest browser acceptance                                                                                                                         |
| `pnpm exec prettier --check <explicit changed/new runtime files>`                                                       | all matched files passed; commit-relative runtime format gate is also required after committing                                                                                                                            |
| Production/preview authenticated acceptance                                                                             | blocked: no authorized schema mutation or accessible browser session; desktop browser startup fails before page access                                                                                                     |

Review found and fixed four Important issues: explicit opt-in/dedicated CI DB plus migration-loader fallback; revoke observed blocked selections and repeat source validation at mutation; no arbitrary exception content in instrumented logs; preflight requires the effective runtime role. Independent re-review found no remaining Critical/Important defect within those fixes. Root env regression also caught missing diagnostic metadata names; manifest corrected and root 116/116 passed on rerun. Full package checks caught one old delivery fixture lacking source time; fixture made valid and full suite rerun passed. No failed assertion was removed. Normal integration skips the destructive suite; CI separately provisions and runs `opak_fixes_ci`, so the regression is not silently omitted from CI.

Local screenshots: ignored `node_modules/.opak-evidence/{operator,reviewer}-{queue,blocked-mobile}.png` contain synthetic values only. Customer evidence remains outside the repo. Production repair uses existing `0046_listing_version_source_binding.sql`; no new migration or backfill. Configuration and additive-schema rollback are documented in the recovery pack.

PR/preview: not yet created; publish this batch after final checks and review follow-up. Next independent implementation: T03 maintenance intake and immutable source matching, retaining reference-only eligibility.

No paid provider call, production mutation, merge, deployment command or SHOPLINE write performed.
