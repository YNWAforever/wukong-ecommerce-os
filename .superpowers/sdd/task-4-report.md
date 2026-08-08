# Task 4: Worker snapshot access and post-queue policy evaluation

## Scope

Implemented only the Task 4 worker publish/consumer files and their focused tests. `apps/worker/src/index.ts` required no change: it already routes queue work to `consumeShoplineMessage`.

## Implementation

- Added the minimal workspace-scoped SHOPLINE connection snapshot adapter to `PublishRepositories`; the consumer maps a workspace-bound database connection to the shared policy's `{ id, workspaceId, verified }` contract without probing SHOPLINE.
- `publishApprovedProduct` now reads the current listing, claimed job, resolved image URLs, and connection snapshot, then calls `evaluateDeliveryPolicy` in `worker` phase after lease/job ownership checks and before all connector status/create calls.
- Removed the worker-local target, status, blocking-flag, projection, and digest branches. The connector receives only the shared policy's canonical plan payload and digest.
- Maps shared policy rejections to the existing sanitized worker outcomes: approval/not-found to `not_approved`, blocking flags to `blocking_flags`, validation to `invalid_payload`, disconnection to `invalid_connection`, and binding mismatch to `stale_plan`.
- Persists policy rejections through `markFailed`; stale-plan rejection also writes audit facts including expected and observed version/digest values.
- Classified `stale_plan` and `invalid_connection` as terminal consumer outcomes so they are acknowledged rather than retried.
- Preserved existing lease, expected-version, idempotency, begin/complete/fail, remote status, create retry, and sanitized connector-error behavior.

## TDD evidence

### RED

Added worker tests for an active-version mismatch and persisted digest mismatch, then ran:

```powershell
.\node_modules\.bin\vitest.cmd run apps/worker/src/publish-product.test.ts apps/worker/src/shopline-consumer.test.ts
```

Before implementation the focused run failed as expected:

- Active-version mismatch returned `not_approved`, not `stale_plan`.
- A mismatched persisted digest incorrectly published `remote_123`.

### GREEN

After integrating the shared policy, expanded the digest test to cover both a missing (`null`) digest and a mismatched digest. The focused run passed:

```powershell
.\node_modules\.bin\vitest.cmd run apps/worker/src/publish-product.test.ts apps/worker/src/shopline-consumer.test.ts
```

Result: 2 test files passed, 39 tests passed.

## Verification

```powershell
.\node_modules\.bin\vitest.cmd run apps/worker/src/publish-product.test.ts apps/worker/src/shopline-consumer.test.ts
pnpm.cmd --filter @wukong/worker typecheck
git diff --check
```

Results:

- Focused worker tests: 2 files / 39 tests passed.
- Worker typecheck: passed.
- Diff check: passed.

## Acceptance mapping

- Matching claimed version and digest reaches the connector only with the policy plan's payload and digest.
- Current-version, missing-digest, and mismatched-digest jobs end as `stale_plan` before connector side effects; stale audit metadata contains binding facts.
- Target, status, flag, image/projection, validation, and disconnected outcomes are evaluated by the shared policy and mapped to sanitized worker errors with no CSV fallback.
- Consumer passes the workspace-scoped snapshot adapter and acknowledges terminal `stale_plan`.
- Existing focused coverage keeps lease, idempotency, retry, remote-status/create, and connector-failure paths intact.

## Concerns

- Task 5 remains responsible for any repository/database terminal-code persistence changes beyond the worker's typed `stale_plan` handling.
- The worktree had unrelated pre-existing edits and generated/untracked directories; they were preserved and excluded from this task commit.
