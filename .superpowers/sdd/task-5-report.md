# Task 5 Report: stale_plan terminal persisted worker outcome

## Scope

Extended the existing worker/repository error-code contract only. No schema,
migration, queue message, provider, or unrelated worktree changes were made.

## TDD evidence

RED:

- Added a worker test requiring `PublishDeliveryError("stale_plan")` to expose a
  fixed, content-safe message and never echo a supplied cause.
- Added repository tests requiring `stale_plan` to remain terminal and be
  accepted as a safe persisted code.
- Ran `npm.cmd exec -- vitest run apps/worker/src/publish-product.test.ts packages/db/src/repositories/publish-jobs-retry.test.ts`.
- Result: 2 expected failures. The worker emitted the generic stale-plan
  message and the repository sanitizer did not exist.

GREEN:

- Added the stable worker message: `The approved listing plan is no longer current`.
- Added `stale_plan` to the repository safe-code allowlist through
  `sanitizePublishJobErrorCode`.
- Kept the retryable set unchanged (`remote_unavailable`, `rate_limited`), so
  `invalid_connection` retains its existing retry path.
- Re-ran the RED command: 31/31 tests passed.

## Acceptance verification

- Focused worker and DB tests:
  `npm.cmd exec -- vitest run apps/worker/src/publish-product.test.ts apps/worker/src/shopline-consumer.test.ts packages/db/src/repositories/publish-jobs-retry.test.ts packages/db/src/publish-jobs-schema.test.ts`
  - Passed: 54/54 tests across 4 files.
- Worker typecheck: `npm.cmd run typecheck --prefix apps/worker` passed.
- DB typecheck: `npm.cmd run typecheck --prefix packages/db` passed.
- No production database or provider action was performed.

## Result

`stale_plan` is persisted without downgrade, cannot be reclaimed as retryable,
is acknowledged by the existing consumer terminal classifier, and has a stable
sanitized worker message. Version IDs and payload digests remain in structured
audit metadata only.

## Concerns

The pre-existing unrelated worktree changes remain unmodified. The initial npm
workspace typecheck form was unsupported in this checkout; package-directory
typechecks were used successfully instead.
