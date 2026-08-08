# Task 7 final whole-branch review fixes

Date: 2026-08-08
Worktree: `C:/Users/laich/Documents/WukongEommerce/worktrees/shopline-ai-listing-mvp`
Starting HEAD: `e8a7e638e47acd316c5d544f342098c5cc5208ad`

## Status

Both Important findings are fixed and locally verified.

## Root causes

### Finding 1: audit identity

`DeliveryPolicyInput` carried `workspaceId` and `draftId` only inside the nullable listing snapshot. `auditFacts` therefore emitted null identity for `not_found`, even though the request already had both identifiers.

The policy input now requires request-level `workspaceId` and `draftId`. Web callers already pass these through their request input, the worker now passes them explicitly in both policy evaluations, and `auditFacts` always uses request identity independently of listing presence.

### Finding 2: worker binding drift

`publishApprovedProduct` checked published/idempotent state and claimed-job presence before invoking the shared worker policy. Missing jobs, version mismatch, and published listings lacking a matching published job therefore escaped as generic infrastructure errors before typed policy conversion, terminal persistence, or rejection audit handling.

The worker now evaluates the shared policy binding immediately after reading the listing and job, before connection checks, image resolution, mutable listing state, payload work, or connector calls. The policy treats a published listing whose matching job is not published as `stale_plan`. Stale outcomes are audited with expected/observed version and digest facts; a matching running lease is failed through `markFailed`, while absent or non-running rows are not mutated. Valid published listing/job bindings retain the existing idempotent result path.

## Files changed

- `packages/shopline/src/delivery-policy.ts`
- `packages/shopline/src/delivery-policy.test.ts`
- `apps/worker/src/publish-product.ts`
- `apps/worker/src/publish-product.test.ts`
- `.superpowers/sdd/task-7-final-fix-report.md`

No migrations, queue schemas, providers, production data, or unrelated worktree files were changed.

## RED evidence

Command:

`npm.cmd run test --prefix packages/shopline -- src/delivery-policy.test.ts; npm.cmd run test --prefix apps/worker -- src/publish-product.test.ts`

Result: expected failure.

- Policy: 1 failed, 28 passed. `not_found` returned null `workspaceId` and `draftId`.
- Worker package run: 3 failed, 86 passed. Missing claimed job threw `claimed publish job is unavailable`; published listing with running/failed job threw `published listing is missing its delivery record` instead of typed `stale_plan`.

## GREEN evidence

Focused policy, worker/consumer, and web commands:

- `npm.cmd run test --prefix packages/shopline -- src/delivery-policy.test.ts src/projection.test.ts src/validation.test.ts src/csv.test.ts` — PASS, 3 files / 41 tests.
- `npm.cmd run test --prefix apps/worker -- src/publish-product.test.ts src/shopline-consumer.test.ts` — PASS, package script 9 files / 89 tests.
- `npm.cmd run test --prefix apps/web -- "app/api/listings/[id]/deliver/route.test.ts" "app/api/listings/[id]/deliver/route.review-fix.test.ts" "lib/delivery-service.review-fix.test.ts"` — PASS, 3 files / 30 tests.

Package typechecks:

- `npm.cmd run typecheck --prefix packages/shopline` — PASS.
- `npm.cmd run typecheck --prefix apps/worker` — PASS.
- `npm.cmd run typecheck --prefix apps/web` — PASS.
- `npm.cmd run typecheck --prefix packages/db` — PASS.
- `npm.cmd run typecheck --prefix packages/jobs` — PASS.

Repository checks:

- `npm.cmd run lint` — PASS, Turbo 14 successful / 14 total.
- `git diff --check` — PASS. Only the previously documented CRLF and inaccessible global-ignore warnings were emitted.

Focused total: 160 passing tests across the reported package runs.

## Self-review

- Request identity is now a required policy contract field and remains available when `listing` is null.
- Worker binding policy runs before connection, image-resolution, listing mutation, payload, and connector work.
- Missing job and published/non-published job tests assert typed terminal errors, rejection audit metadata, and no connector or image-resolution calls.
- Running lease-backed stale jobs are persisted as failed; missing/non-running rows are not forced through `markFailed`.
- Existing version/digest stale tests remain passing.
- Valid published-result idempotency remains covered with a digest that is actually bound to the current canonical listing.
- Connection mismatch and connector retry/reconciliation tests remain passing in the worker package suite.
- The scoped diff contains no migration, queue schema, provider, or production-data changes.

## Concerns

- The worktree retains pre-existing unrelated modified and untracked files documented by the prior rerun report; they were not staged or changed by this fix.
- Verification is local only. No browser, preview, Cloudflare, SHOPLINE provider, migration, deployment, or production-data action was run.
