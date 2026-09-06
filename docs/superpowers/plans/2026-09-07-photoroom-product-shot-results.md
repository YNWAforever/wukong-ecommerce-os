# Photoroom product-shot implementation results

Date: 2026-09-07
Status: All seven tasks and final replacement review approved; final repository checks passed. Ready for branch integration review; not deployed.
Branch: `codex/photoroom-product-shots`.
Baseline main: `fe64fb80ff5b1ff6d8efa4962828170b68adcfc2`.

## Delivered behavior

One actual uploaded photo feeds a bounded background-removal adapter. Durable
queue attempts retain leases and private cutout checkpoints. A Node-only renderer
saves the exact white JPEG for review without inventing foreground detail or
enlarging the subject. The operator compares that candidate with the private
original; factual listing approval remains separately required. Replace photo uploads a new original into the same saved draft, preserves its copy and version, and queues only image processing. A committed upload remains recoverable after a request failure.

Approval binds the observed listing version, selected source, provider/render
identity and candidate digest. Changing sources invalidates current acceptance,
including returning from A to B to A. Historical published images remain available
until explicit revocation. Image-carrying create CSV and SHOPLINE delivery require
a current approved publication. The 71-column Bulk Update has no image column and
retains its existing factual and source-binding rules.

Approved JPEG capabilities use 32 random bytes encoded as 43 base64url characters.
A narrowly privileged database function exposes only the immutable publication
record. The public route validates the object size and digest after a buffered read;
invalid, missing, revoked or substituted images return 404. Original objects stay
private.

Saving factual confirmations after approval now reopens the listing under its
row lock, in the same transaction as the confirmation revision and audit write.
The active version and historical image URL remain unchanged. This also applies
to value-identical saves, since they write a new revision. Mutations during
publishing fail closed; a version changed while waiting for the lock returns
409 stale_version. Reapproval reuses the saved image without another provider call.

## Independent task reviews

| Task                            | Commits                         | Final verdict |
| ------------------------------- | ------------------------------- | ------------- |
| 1. Bounded provider adapter     | `0948110`, `11071d6`            | Approved      |
| 2. Exact white renderer         | `26b9d89`                       | Approved      |
| 3. Durable scoped persistence   | `7812f25`, `77d7f64`            | Approved      |
| 4. Recoverable queue processing | `cf31ce7`, `b9d4e80`            | Approved      |
| 5. Exact candidate review       | `1e21bdb`, `80a341c`            | Approved      |
| 6. Stable image publication     | `3be890d`, `0d33952`            | Approved      |
| 7. Browser/runtime acceptance   | `5d6fc6c`, `de6125b`, `5f660af` | Approved      |

Final whole-branch review found one missing operator action. Commit `528f347` adds same-draft upload/replacement; focused re-review approved the repair with no new Critical or Important findings. The earlier public-buffering Minor is documented below and remains nonblocking.

## Reproduced failures and repairs

- Response-stream cancellation could turn known oversized provider output into an uncertain outcome. The adapter preserves invalid-output classification.
- Seven tenant child indexes were missing. The strict inventory now includes all new relationships and supporting indexes without weakening its assertions.
- Replacing the source could leave an expired historical attempt processing forever. Recovery reconciles that lease without redispatching a potentially paid call.
- Single/bulk factual approval could bypass image acceptance before a selection existed. A shared server policy closes the pre-selection path; a successful retry of the initial image read resumes automatic work.
- Worker publication released its image lock before the outer publish claim. Real consumer/runtime races reproduced selection and revocation committing in that gap. Scoped repositories now retain the lock through durable preparation; mutations committed first reject delivery before connector I/O.
- Malformed anonymous JPEG tokens redirected to sign-in. Middleware admits the endpoint shape and the handler returns 404 without lookup/storage access; adjacent routes stay protected.
- A legitimately approved, image-bound listing still exported CSV with HTTP 200 after a confirmation PATCH withdrew its facts. The repair reopens the same active version transactionally and blocks export until reapproval. Both languages exercise this causal regression.
- A version changed between snapshot read and row-lock acquisition could become an internal error. A typed stale result now maps to 409 before confirmation upsert; unrelated errors still propagate.

- A one-photo draft could not upload a replacement through review. The component regression failed before the control existed, and server regressions failed before attachment and publishing fences existed. Shared upload, a scoped idempotent attachment transaction, post-commit image processing, and genuine bilingual browser uploads now cover this path.

## Verification

Commands use `corepack.cmd pnpm@11.7.0` in the execution worktree, with isolated
synthetic service settings. No production environment was used.

Final source checkpoint: `528f34752753991a33ec41b10b7b495aac98e6d6`.

| Check                                   | Verified result                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                        | 14/14 tasks passed                                                                                      |
| `pnpm lint`                             | 14/14 tasks passed                                                                                      |
| `pnpm test`                             | 14/14 tasks passed, including 1498 web tests                                                            |
| `pnpm test:integration`                 | 303 passed, 3 intentional destructive-migration skips; 38 passed files, 2 skipped files; 199.03 seconds |
| `pnpm build`                            | 8/8 tasks passed; Worker build is a dry run                                                             |
| `pnpm format:runtime:check`             | 95 files, zero waived debt                                                                              |
| `pnpm runtime:forbidden:check`          | 9 manifests and 304 source files; zero forbidden dependencies, imports or files/services                |
| Worker bundle and map inspection        | No sharp, libvips or Node product-shot renderer references                                              |
| Replacement focused regressions         | 62 unit/component tests and 11 real database/private-storage tests passed                               |
| `pnpm --filter @wukong/db audit:verify` | Zero missing actions and zero accessible foreign records at the retained audit checkpoint               |

Browser commands all used `--workers=1 --retries=0`:

- `playwright test tests/e2e/product-shot.spec.ts`: 4/4 passed after the replacement repair. English and Traditional Chinese each create a draft through a real synthetic file upload, replace its photo through another upload on that same draft, and verify preserved copy/version, renewed image acceptance and reload persistence. Existing reuse/privacy/eligibility and definite/uncertain retry checks remain.
- `playwright test tests/e2e/workbench.spec.ts tests/e2e/catalog-usability.spec.ts tests/e2e/bulk-update-pilot.spec.ts`: 13/13 passed again after the approval repair, in 1.6 minutes.
- `playwright test tests/e2e/real-stack-boundary.spec.ts`: 3 passed, 1 intentional POSIX-only skip on Windows.
- `playwright test tests/e2e/listing-pilot.spec.ts`: 1/1 passed again after shared upload extraction. The earlier complete synthetic audit trail is retained.

The image suite uses `WUKONG_PRODUCT_SHOT_E2E=1`, which pins guarded fake processing
and strips inherited Photoroom credentials. The legacy trio runs with this opt-in
disabled and `PRODUCT_SHOT_PROVIDER=disabled`. A combined fake-mode run reproduced
a legacy Bulk Update approval failure because its intended approval contract is
different. Separate runs preserve both contracts; no gate was weakened.

The retained audit CLI arguments were
`--workspace ws_opak_98ad3034b2e144f0be05188d00f4827a --draft 577fba03-4931-45fe-abb2-357b0bb687b6`,
using the non-superuser application role. The audit probe includes all five new
tenant tables. Historical synthetic workspaces and browser artifacts are retained.

## Remaining release boundaries

Only synthetic loopback Postgres, MinIO, Mailpit and fake providers were used.
Final publication migration verification used fresh empty v2 databases; older
synthetic databases and capabilities were retained. Automatic approval review
rejected an in-place old-token upgrade, so no destructive upgrade ran. The new
unmerged schema fails closed on obsolete token-column state. All five product-shot
tables have enabled and forced RLS in the fresh browser database.

Live processing remains disabled. No real Photoroom call, merchant image/workbook
upload, paid provider use, production migration, deployment or SHOPLINE write was
performed. The required same-draft replacement repair is complete and approved. Owned synthetic Postgres, MinIO and Mailpit services were stopped after the final checks; their data and browser artifacts were retained. The branch and worktree remain available for review; nothing was pushed or merged.

Actual bottle/glass/label quality, account-specific pricing and billing, live
credentials/configuration, managed-database role-creation and ownership privileges,
and merchant SHOPLINE acceptance remain unverified. New-product XLSX and merchant
pricing/SKU/category rules require separate work. Activation requires its own
authorization and verification. Operator setup and recovery are documented in
`docs/runbooks/product-shot-processing.md`.

The whole-branch review also noted a nonblocking storage-hardening limitation:
anonymous image retrieval buffers the stored object before comparing its actual
size with the bounded publication record. Normal published artifacts are bounded;
an oversized object substituted through privileged storage access or corruption
could use more memory before rejection. No approval bypass was found. Bounded
streaming reads remain a separate hardening opportunity.
