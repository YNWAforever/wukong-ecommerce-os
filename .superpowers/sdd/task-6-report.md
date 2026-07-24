# Task 6 report — Cloudflare Queue AI consumption and provider deadline

## Status

DONE. Listing jobs now run through the existing tenant-scoped domain pipeline from the Cloudflare Queue consumer, terminal and transient outcomes are separated safely, and both initial and repair OpenAI calls have bounded abort signals.

Commit: `98efe95` (feat: consume AI jobs with Cloudflare Queues).

## RED evidence

1. `corepack pnpm --filter @wukong/worker exec vitest run src/listing-consumer.test.ts`
   - Exit 1; suite failed before collection because `listing-consumer.ts` did not exist.
2. `corepack pnpm --filter @wukong/ai exec vitest run src/openai-listing-provider.test.ts`
   - Exit 1; 39 tests ran, 35 passed and 4 failed.
   - Expected failures: Responses `parse` had no request-options signal, `AbortSignal.timeout` was never called, and invalid timeout configuration was accepted.
3. Runtime-initialization review regression: focused Worker test exited 1 with 1 failed and 7 passed because `createCloudflareRuntime` failure rejected instead of returning a retry outcome.

## GREEN evidence

1. Focused Worker consumer: 1 file, 8 tests passed.
2. Focused AI provider: 1 file, 39 tests passed.
3. Complete `@wukong/ai` suite: 3 files, 48 tests passed.
4. Complete `@wukong/worker` suite: 6 files, 39 tests passed.
5. `@wukong/ai` typecheck: exit 0.
6. `@wukong/worker` typecheck: exit 0.
7. `@wukong/ai` build: exit 0.
8. Final `@wukong/worker` Wrangler dry-run build: exit 0; 2131.51 KiB, gzip 375.51 KiB; expected listing Queue, SHOPLINE Queue, and Hyperdrive bindings only.
9. `git diff --check`: exit 0.

## Outcome classification

- Strict queue payload parsing occurs before runtime or database construction; malformed payloads acknowledge without database access.
- Success and terminal provider output/evidence/refusal/unsupported-asset errors acknowledge. Terminal provider errors force the existing pipeline to persist only a sanitized error code and audit action.
- Provider API availability, explicit abort/timeouts, runtime initialization failures, and other transient pipeline failures return `{ retryAfterSeconds: 30 }` without logging errors or model content.
- Listing Queue messages ack success/terminal results and call `retry({ delaySeconds: 30 })` for transient results.
- SHOPLINE Queue messages retain the Task 5 retry placeholder; real SHOPLINE consumption remains disabled for Task 7.
- Unknown Queue names throw before any acknowledgement or retry call.

## Runtime and tenant isolation

- `createCloudflareRuntime` restores the existing provider, S3 signed-read, repository, and AI usage adapters on top of the Task 5 Hyperdrive database.
- Every repository operation remains inside `database.forWorkspace(workspaceId, ...)`.
- Runtime configuration is validated before opening the database where possible, and the consumer closes the database in `finally`.
- The OpenAI secret is passed directly to the lazy provider client and is never logged or placed in a queue payload.

## Provider deadline

- `timeoutMs` defaults to 120000 ms.
- Values must be integers from 1000 through 600000 inclusive; both bounds are covered.
- Both the initial and single repair `responses.parse` requests receive fresh `AbortSignal.timeout(timeoutMs)` signals.
- The maximum explicit per-request deadline remains below the Cloudflare Queue 15-minute wall.

## Files

Created:

- `apps/worker/src/listing-consumer.ts`
- `apps/worker/src/listing-consumer.test.ts`

Modified:

- `apps/worker/src/cloudflare-runtime.ts`
- `apps/worker/src/cloudflare-runtime.test.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/listing-pipeline.ts`
- `apps/worker/src/pipeline-test-support.ts`
- `apps/worker/src/queue-consumer.ts`
- `apps/worker/src/worker-env.ts`
- `packages/ai/src/openai-listing-provider.ts`
- `packages/ai/src/openai-listing-provider.test.ts`

## Self-review and concerns

- Reviewed the complete scoped diff, Queue acknowledgement order, typed error classification, lifecycle ownership, tenant scoping, and secret/model-content surfaces.
- Narrow security scan found no logging calls, signed URLs, credentials, or prompt/model content in the Queue consumption path; the only prompt match is the existing safe `promptVersion` telemetry field.
- The managed Windows ACL helper prevented `apply_patch`, so edits used the brief-authorized guarded exact-once replacement fallback. Formatter-only noise was removed before final verification.
- Protected paths and `.wrangler` output remain unstaged and untouched by Task 6.
- No blocking concerns. Queue names intentionally match the two checked-in preview/production configurations; an unrecognized deployment Queue fails closed before ack/retry.

## Review fix — cleanup outcome preservation

Review identified that a rejected `runtime.close()` in `finally` replaced the consumer's already-classified acknowledgement or retry return value, preventing `handleQueue` from applying the intended per-message action.

RED: `corepack pnpm --filter @wukong/worker exec vitest run src/listing-consumer.test.ts` exited 1 with 2 failed and 8 passed. Both terminal-ack and transient-retry regressions rejected with the injected cleanup failure instead of resolving their classified outcomes.

Fix: runtime cleanup remains awaited but its rejection is contained locally with no logging or telemetry. This preserves the classified queue contract and does not expose cleanup messages, model content, secrets, signed URLs, or credentials.

GREEN and final verification:

- Focused listing consumer: 1 file, 10 tests passed.
- Complete Worker suite: 6 files, 41 tests passed.
- Worker typecheck: exit 0.
- Wrangler dry-run build: exit 0; 2131.54 KiB, gzip 375.52 KiB; expected listing Queue, SHOPLINE Queue, and Hyperdrive bindings only.
- Regression assertions verify the sensitive marker is not logged for either outcome.

Review-fix files: `apps/worker/src/listing-consumer.ts` and `apps/worker/src/listing-consumer.test.ts` only. The report remains an unstaged handoff artifact.

Review-fix commit: `bf2600e` (fix: preserve queue outcomes when cleanup fails).

## Task 11 reproducible Cloudflare release gate

### Candidate and runtime

- Verified runtime candidate: `c858ce837cf569e3a41707ee42377c1c320d14d3` (`ops: define Cloudflare production runtime`).
- Detached checkout: `C:\tmp\wukong-task11-clean-ae1f4be`.
- Node: `v24.18.0`.
- Corepack pnpm: `11.7.0`.
- Frozen install: passed; lockfile supply-chain policy passed and 192 packages installed from the pinned lock.
- Final detached status after stopping candidate services and removing generated `.wrangler`/`test-results`: empty.
- No Cloudflare, Vercel, Neon production, or SHOPLINE mutation occurred. All services and data were local; SHOPLINE remained mock/disabled.

### CI and configuration RED/GREEN

Initial Node configuration run: 15 tests total, 10 passed and 5 failed for the intended missing behavior: Redis was still in CI, Wrangler render/validation was absent, the forbidden-runtime scan was absent, and local/production/readiness runbooks still described the legacy runtime.

Final Node configuration run: 16/16 passed. The candidate pins Node 24 and pnpm 11.7, starts Postgres plus candidate-owned MinIO/MinIO-TLS/Mailpit, renders preview Wrangler configuration with the non-secret all-zero fake Hyperdrive ID, runs full Playwright, and keeps the local Hyperdrive connection string scoped to the Playwright step.

Forbidden-runtime proof checked 9 package manifests and 111 non-test runtime source files: forbidden dependencies `0`, forbidden imports `0`, forbidden runtime files/services `0`. Railway config/tests are absent; no Redis service or variable remains.

### Hash-pinned formatting debt

The first detached format gate failed on the report plus 12 pre-Task11 code files. Formatting those 12 in the disposable checkout produced only mechanical Prettier drift (1,453 insertions and 580 deletions), but those files were outside Task 11 scope. The report was formatted normally. The exact 12 inherited files are temporarily waived only when their canonical-LF SHA-256 matches:

| File                                                            | Expected SHA-256                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/app/api/assets/finalize/route.test.ts`                | `3abb816c52d65a7223313586b4ee6dd56da80abd43e5598a98ddda3b4d50845b` |
| `apps/web/app/api/assets/finalize/route.ts`                     | `5aaa692c0b800758e6e63012d8aca47bc31b517b4924244763f3256fa1c097b2` |
| `apps/web/app/api/assets/presign/route.ts`                      | `7adbcb02f097f202c849e229d9510f8c3a59059072aa81b55c0ad997c37388ea` |
| `apps/web/app/api/listings/route.create.test.ts`                | `175f467561747ea218d165278e1e57eb4023b50761f81898b3a0f4dc0461cbc0` |
| `apps/web/lib/listing-queue-runtime.ts`                         | `0140cf7c13dbc3dddd78e32fec238ff548e31b4a25b94558fd6d61c5f967ad68` |
| `apps/worker/src/listing-consumer.test.ts`                      | `e1b487bd64cfe877d416cdd270e731b42ad2a3dba17b2c52a89161c10e7d1035` |
| `apps/worker/src/pipeline-test-support.ts`                      | `f02b9b9d618c3d9d74ab50acc393d832f3f4ed1614f5c250568a91f36662b90b` |
| `packages/db/src/index.ts`                                      | `314a726462f7407f4a608104634e1a3e6945a63a0bb9ac18c85077d2f6a1dc2d` |
| `packages/db/src/publish-jobs-schema.test.ts`                   | `8c0609853aa150a6d7fd532e41f387fb152462758d35f4d860a80685f932c5d8` |
| `packages/db/src/repositories/publish-jobs.integration.test.ts` | `60f109af4c944409f7cfe348c697299a3f34a83a008b1c3478581d43f6e36c7c` |
| `packages/db/src/schema.ts`                                     | `21c8b510142bf891215df98175e1a168df6016a6a325b7a3b7a45457599034ee` |
| `packages/jobs/src/cloudflare-queue.ts`                         | `1f17ed387564268afbdf82c4354a04d7e27b0525d0d2a5dfc613c925796f1b43` |

Automated tests prove the exact baseline passes, each changed source/hash fails, and a new unformatted file fails. Final format proof evaluated 131 changed release files and printed exactly 12 matching waivers. No glob, directory, extension, or dynamic baseline exemption exists.

### Complete clean-checkout gate

- Dependency-inclusive database build: passed for core, SHOPLINE, and DB packages.
- Controlled local Postgres migration: passed.
- Lint: 14/14 Turbo tasks passed.
- Typecheck: 14/14 Turbo tasks passed.
- Unit/config: 484 tests passed, 0 failed.
- Service-backed integration: 6 files and 48 tests passed.
- Production build: 8/8 workspace builds passed. Worker dry-run exposed only the two preview Queue bindings and preview Hyperdrive binding. Next built 16 static/dynamic routes.
- Browser acceptance: 4 passed, 2 documented platform/optional skips, 0 failed. It crossed production-built Next, signed Worker ingress, Wrangler local Queues, Hyperdrive-to-local-Postgres, MinIO TLS, Mailpit, fake AI, and mock SHOPLINE.
- Accepted no-copy draft: `7cb0e38d-cbda-4d1a-9bf3-bb32989b0770`.
- Audit sequence: `listing.created -> listing.transition -> listing.transition -> listing.submitted_for_review -> listing.version_appended -> listing.edited -> listing.version_appended -> listing.approved -> listing.transition -> listing.csv_exported -> listing.publish_requested -> listing.publish_queued -> listing.transition -> listing.transition -> listing.published`.
- Missing action count: `0`.
- Accessible foreign record count: `0`.

### Reproducibility diagnostics

The first browser attempt failed before tests because an already-running MinIO TLS container belonged to another worktree and its Caddy CA was not present in the detached checkout. CI/local startup now force-recreates MinIO and `minio-tls` from the candidate checkout. A no-copy rerun proved the candidate generated its own 631-byte CA and passed the full browser story.

A later freshly recreated checkout initially lacked workspace `dist` outputs because the verification sequence had not yet run its required build. After running the production build, Wrangler resolved all workspace packages. The shared Windows Turbo cache then replayed the known baseline `@wukong/web#build` cache entry without restoring `.next` because web outputs are not declared in `turbo.json`; a direct `next build` recreated the candidate output and the exact Playwright command passed. CI uses a fresh runner and executes its production build before Playwright. The missing web-output cache declaration remains a non-blocking baseline warning for a separately scoped change.

### Self-review

Reviewed the complete Task 11 diff for protected-file scope, CI order, secret boundaries, exact Cloudflare names, preview/production isolation, ingress rotation, Queue/DLQ metrics and replay, Hyperdrive caching/connection limits, controlled migration/seed, first-real-write stop, and non-destructive rollback. The MinIO TLS startup issue was the only Important finding and was fixed with a focused RED/GREEN test. No Critical or Important Task 11 issue remains in self-review.

## Task 11 review-fix release gate

Review fixes were committed as `d9f94c7` (`fix: harden Cloudflare release preflight`) and `aa11d6b` (`test: restore preview config after validation`). The final code candidate was `aa11d6b62be18da017d85a85eefc8826292775c8` in the detached checkout `C:\tmp\wukong-task11-final-aa11d6b`.

RED evidence: the consolidated Node configuration suite had 8 expected failures, and the focused real-stack boundary test had 1 expected failure. They covered missing safe Worker variables and Wrangler types, missing exact secret preflight, reused R2 credentials, unstable Compose ownership, absent required-secret metadata, unsafe renderer overrides, and the Hyperdrive local connection leaking into the Next child. A later focused assertion proved the configuration tests left downstream CI on `wukong-runtime-production`.

GREEN and release evidence:

- Configuration/runbook suite: 23/23 passed. Preview and production SHOPLINE values are renderer-locked; required secrets and remote secret names are exact; downstream CI ends on preview.
- Wrangler types: passed without environment-selection warnings and generated exact variable plus five secret bindings.
- Frozen install, hash-pinned format gate, and forbidden-runtime scan passed. The format gate checked 132 files with exactly 12 pinned waivers; the forbidden scan checked 9 manifests and 111 runtime sources with all three violation counts at zero.
- Stable Compose ownership replaced the prior worktree-named Wukong containers with `wukong-ecommerce-local`; unrelated Docker projects were inspected but not changed.
- Dependency-inclusive database build and controlled migration passed.
- Lint: 14/14 tasks. Typecheck: 14/14 tasks. Unit/config: all workspace suites passed. Integration: 6 files and 48 tests passed. Production build: 8/8 tasks passed.
- A direct cache-bypassed Worker dry-run proved preview Queue and Hyperdrive bindings, `AI_PROVIDER=fake`, `SHOPLINE_ADAPTER=mock`, and `SHOPLINE_PUBLISH_ENABLED=false`. A direct Next production build passed.
- The first browser attempt used an incorrect shell override, `S3_ENDPOINT=http://127.0.0.1:9010`. Trace evidence showed the expected pre-approval `409 approval_required`, followed after approval by `422 validation_error` because SHOPLINE rejects non-HTTPS image URLs. No code change was needed. Removing the override restored the harness's `https://localhost:9012` TLS boundary.
- Final no-copy Playwright: 4 passed, 2 documented platform/optional skips, 0 failed.
- Accepted draft: `64e47064-94e9-42bb-98ed-95fd53c9ef87`.
- Exact-draft audit: missing action count `0`; accessible foreign-record count `0`.
- Candidate services and disposable Task 11 worktrees were removed. The stable Wukong services were recreated from the feature worktree. No Cloudflare, Vercel, Neon production, or SHOPLINE external mutation occurred.

## Task 11 final plaintext replacement and R2 endpoint review

The final focused review fix was committed as `514ec22e592179e9bf854b18956aa1e5d448a90b` (`fix: replace stale Cloudflare plaintext vars`). Generated Wrangler configuration now omits `keep_vars`, so deployment replaces the exact nine approved plaintext variables and removes arbitrary stale dashboard plaintext variables. The five encrypted secrets remain independent and fail closed through the exact-name secret preflight.

`S3_ENDPOINT` now accepts only the standard Cloudflare R2 S3 API root `https://<32-hex-account-id>.r2.cloudflarestorage.com` with an optional root slash. Generic HTTPS hosts, credentials, ports, non-root paths, queries, and fragments are rejected. Validation uses the complete raw string because URL normalization hides an explicit default `:443` port. No jurisdiction variant was added because none exists in the approved design.

RED/GREEN evidence:

- First focused RED: 5 passed and 2 expected failures; `keep_vars: true` remained and unsafe endpoints were accepted.
- Renderer GREEN: 7/7 passed after omitting `keep_vars` and enforcing the R2 root.
- CI/runbook RED: 15 passed and 2 expected failures; CI used a generic `ci` host and the runbook omitted the stale-plaintext replacement contract.
- Final combined configuration/runbook suite: 24/24 passed.
- Production and preview renders each proved exactly nine plaintext variables, no `keep_vars`, locked SHOPLINE values, and exact five-secret metadata. Wrangler types completed without environment-selection warnings, and the Worker dry-run showed the exact preview Queue, Hyperdrive, and variable bindings.
- The exact detached candidate passed the 132-file format gate with 12 exact waivers, the forbidden-runtime scan with all three counts at zero, the 24/24 focused suite, dependency-inclusive Worker build/dry-run, then Worker lint and typecheck after required workspace dependency outputs existed.
- The first detached lint/typecheck invocation reproduced the documented clean-checkout dependency-order condition because `@wukong/core` and other workspace outputs had not yet been built. The dependency-inclusive build resolved it; the post-build lint and typecheck both passed.
- Full E2E was not rerun because this change affects only generated deployment configuration, validation tests, CI safe input, and operator documentation; no Worker source or local runtime harness behavior changed.
- The disposable `C:\tmp\wukong-task11-final-514ec22` worktree registration and residual directory were removed. No deployment or external mutation occurred.
