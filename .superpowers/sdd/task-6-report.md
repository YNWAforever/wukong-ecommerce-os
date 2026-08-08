# Task 6 report: remove strangler duplication and preserve public compatibility

## Outcome

Completed the remaining web-adapter strangler removal. The adapter now resolves its host-specific snapshot, including signed image URLs, before one shared `evaluateDeliveryPolicy` call. The duplicate pre-resolution policy branch and `withResolvedImageUrls` helper were removed from both `prepareShoplineDelivery` and `deliverListing`.

Public exported function names, dependency-injection seams, result translations, audit writes, job transitions, queue behavior, and CSV serialization are unchanged. The worker and shared policy source were inspected and required no Task 6 changes: target, status, blocking-flag, projection, validation, digest, and stale-plan decisions remain centralized in `packages/shopline/src/delivery-policy.ts`.

## TDD evidence

Baseline focused run failed in `apps/web/lib/delivery-service.review-fix.test.ts` (5 failures): the snapshot reader returned empty image URLs, the shared policy was called twice, and published/disconnected exits skipped image resolution. The existing focused tests therefore reproduced the intended seam before the production edit.

After the minimal change, the same focused run passed: 3 test files, 66 tests.

## Verification

- `npm.cmd exec -- vitest run packages/shopline/src/delivery-policy.test.ts apps/web/lib/delivery-service.review-fix.test.ts apps/worker/src/publish-product.test.ts` — pass (3 files, 66 tests).
- `pnpm.cmd --filter @wukong/shopline typecheck` — pass.
- `pnpm.cmd --filter @wukong/web typecheck` — pass.
- `pnpm.cmd --filter @wukong/worker typecheck` — pass.
- `npm.cmd run format:runtime:check` — exit 0. It reports existing format-debt files, including the Task 6 policy/adapters/tests; no formatter rewrite was applied to avoid broad churn.
- `git diff --check` — pass.

## Scope and concerns

- Only `apps/web/lib/delivery-service.ts` and this report are staged for the Task 6 commit.
- Existing unrelated tracked changes and generated untracked directories (`.wrangler/`, `graphify-out/`, and `test-results/`) remain unstaged and untouched.
- The runtime-format check's reported debt is a pre-existing repository concern; it is not changed by this task.
