# Photoroom product-shot implementation results

Date: 2026-09-07
Status: All seven tasks implemented; Task 7 and whole-branch independent reviews pending.
Branch: `codex/photoroom-product-shots`.
Baseline main: `fe64fb80ff5b1ff6d8efa4962828170b68adcfc2`.

## Delivered behavior

One actual uploaded photo feeds a bounded background-removal adapter. A durable queue attempt records its lease and private cutout before a Node-only renderer creates the exact white JPEG for review. Rendering does not invent labels, viewpoints or foreground detail and does not enlarge the subject. The operator accepts the persisted candidate beside the original; factual listing approval remains separately required.

Approval binds the observed listing version, selected source, provider/render identity and candidate digest. Replacing the selection invalidates current acceptance, including selecting A again after B. Historical published images remain available until explicit revocation. Image-carrying create CSV and SHOPLINE delivery require a current approved publication; the 71-column Bulk Update has no image column and retains its existing factual and source-binding rules.

Public JPEG capabilities use 32 random bytes encoded as 43 base64url characters. Public lookup exposes only an immutable publication record through a restricted database function. Original images remain private. The application verifies bounded object bytes and digest before serving a public image; invalid, missing, revoked or substituted images return 404.

## Review gates

| Task                            | Commits              | Independent review                                            |
| ------------------------------- | -------------------- | ------------------------------------------------------------- |
| 1. Bounded provider adapter     | `0948110`, `11071d6` | Approved after overflow-classification repair                 |
| 2. Exact white renderer         | `26b9d89`            | Approved                                                      |
| 3. Durable scoped persistence   | `7812f25`, `77d7f64` | Approved after tenant index repair                            |
| 4. Recoverable queue processing | `cf31ce7`, `b9d4e80` | Approved after historical lease repair                        |
| 5. Exact candidate review       | `1e21bdb`, `80a341c` | Approved after pre-selection approval and read-retry repairs  |
| 6. Stable image publication     | `3be890d`, `0d33952` | Approved after worker transaction and malformed-token repairs |
| 7. Browser/runtime acceptance   | `5d6fc6c`            | Pending                                                       |

Independent Task 7 and whole-branch reviews remain pending. This is not a production rollout or live-provider acceptance report.

## Reproduced failures and repairs

- An oversized provider response whose stream cancellation rejected was misclassified as an uncertain outcome. The adapter now preserves the known invalid-output classification.
- The new tenant relationships lacked seven supporting child indexes. The strict foreign-key inventory reproduced this and now covers every added relationship without weakening its assertions.
- An expired processing attempt could remain stuck after its source was replaced. Recovery now reconciles historical leases without redispatching a potentially paid call.
- Factual approval could bypass required image acceptance before a selection existed. A shared server policy now applies to single and bulk approval; retrying a failed initial image read also resumes automatic preparation.
- Worker publication used a nested image transaction, releasing the selection lock before the outer publish claim. Real consumer/runtime race tests reproduced both selection and revocation committing in that gap. Scoped repositories now retain the lock through durable preparation. Mutations committed first reject delivery before connector I/O.
- Malformed anonymous JPEG tokens redirected to sign-in. Middleware now admits the endpoint shape and the handler returns 404 without lookup or object-store access, while adjacent paths stay protected.

## Verification recorded before Task 7

Commands use `corepack.cmd pnpm@11.7.0` in the execution worktree. Integration commands load the isolated synthetic helper; no production environment is used.

- Baseline: `pnpm test` passed 14/14 Turbo tasks; integration passed 252 tests with 3 intentional destructive-migration skips.
- Task 3 final DB regression: 257 passed, 3 intentional skips.
- Task 4 final repair: 107 focused unit tests, 12 config checks, 3 real DB/storage tests; worker/web/DB typechecks and Worker dry-run build passed. The bundle excluded sharp, libvips and the Node renderer.
- Task 5 final repair: 358 focused web tests, 28 DB/storage integration tests and web/DB typechecks passed.
- Task 6 implementation: 245 focused unit tests, 70 integration tests, five package typechecks and three package builds passed.
- Root full integration before the final Task 6 repair: `pnpm test:integration` passed 291 tests, with 3 intentional skips across 2 migration-test files (38 passed files, 2 skipped files).
- Final Task 6 repair: worker runtime/publisher/consumer tests passed 61/61; public route/publication/middleware tests passed 25/25; publication integration passed 6/6, including actual PostgreSQL blocking and opposite-order rejection. Worker and web typechecks passed. Exact-file formatting and diff checks passed.

## Task 7 acceptance and release checks

- `pnpm build`: 8/8 tasks passed, no cache hits. Worker build is a dry run; no deployment was performed.
- Built Worker JavaScript and source map contain no sharp, libvips or Node product-shot renderer references.
- `pnpm test:integration`: 295 passed, 3 intentional destructive-migration skips; 38 passed files and 2 skipped files, 169.24 seconds. This includes the final Task 6 transaction repair.

- `pnpm typecheck`: 14/14 tasks passed (no cache hits).
- `pnpm lint`: 14/14 tasks passed (6 cached).
- `pnpm test`: 14/14 Turbo tasks passed (6 cached), including 1478 web tests and 166 Worker tests.
- `pnpm format:runtime:check`: passed after correcting one database-client signature line wrap; 81 runtime files checked and no waived format debt.
- `pnpm runtime:forbidden:check`: passed; zero forbidden dependencies, imports or runtime files/services.

- Final Worker dry-run build after fixture control changes passed; bundle and source map still exclude native rendering dependencies.
- Product-shot browser acceptance: 2/2 passed in 1.1 minutes, covering English and Traditional Chinese with the explicit local fake provider. Assertions include exact candidate/version reuse, accepted-source replacement, stale approval 409, factual approval 422, anonymous approved JPEG 200, unsigned original object 403, and consumed fresh attempts after definite/uncertain outcomes.
- Existing workbench, catalog-usability and Bulk Update browser suites: 13/13 passed in 1.6 minutes with the provider disabled.
- Harness boundary tests: 3 passed and 1 intentional POSIX-only skip on Windows. Worker runtime focused tests: 14/14 passed.
- Existing listing-pilot browser lifecycle: 1/1 passed in 19.6 seconds, retaining a complete synthetic audit trail.
- `pnpm --filter @wukong/db audit:verify --workspace ws_opak_98ad3034b2e144f0be05188d00f4827a --draft 577fba03-4931-45fe-abb2-357b0bb687b6`: passed with zero missing actions and zero accessible foreign records using the application role.

All Playwright acceptance commands used `--workers=1 --retries=0`. The four-suite combined invocation was reconciled into two provider modes: the image suite requires guarded fake processing, while the three legacy suites require their existing disabled-provider approval semantics. Running the latter in fake mode reproduced a Bulk Update approval failure. Separate runs preserve both contracts; no eligibility gate was weakened to make the legacy tests pass.

The negative delivery request returns the earlier `image_approval_required` decision. A separate authoritative factual-approval request returns `422 confirmation_incomplete`, proving the factual gate without changing production decision order. The runtime fixture strips inherited Photoroom credentials, pins its provider mode, and confines synthetic scenario controls to fake processing with the local E2E build identity.

Independent Task 7 and whole-branch reviews remain pending.

## Environment and remaining risks

Only synthetic loopback Postgres, MinIO and Mailpit services are used. Publication migration verification uses fresh empty v2 databases; older synthetic databases and capability records are retained. Automatic approval review rejected an in-place old-token upgrade, so no destructive upgrade was executed. The new unmerged schema fails closed on obsolete token-column state. All five product-shot tables have enabled and forced RLS in the fresh browser database.

Committed live processing remains disabled. No real Photoroom call, merchant image or workbook upload, paid provider use, production migration, deployment or SHOPLINE write was performed.

Unverified release gates remain actual bottle/glass/label segmentation quality, account-specific pricing and billing, live credentials/configuration, managed-database role creation and ownership privileges, and merchant SHOPLINE acceptance. New-product XLSX and merchant pricing/SKU/category rules require separate work. Production activation requires its own authorization and verification.
