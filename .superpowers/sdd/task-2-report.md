# Task 2: Define host adapters and migrate web delivery preparation

## Implementation

- Added `createDeliverySnapshotReader` in `apps/web/lib/delivery-service.ts`. It composes the workspace-scoped listing read, connection metadata, existing publish-job state, and asset URL resolution into a policy snapshot while preserving the injected repository and asset seams.
- Replaced the hand-written target, status, flag, projection, validation, and digest decisions in `deliverListing` and `prepareShoplineDelivery` with `evaluateDeliveryPolicy`.
- Kept `deliverListing` as the compatibility facade. CSV serializes the ready plan payload using `createShoplineCsv`; API preparation creates the publish job from the ready plan's exact version, digest, connection, and idempotency key.
- Kept queue ingress and persistence outside the policy. `confirmShoplineQueued` still marks the job queued and now writes the ready-plan policy audit facts with the queue job ID.
- Preserved the existing response unions, explicit CSV/API paths, asset/repository error propagation, and no-image-read behavior for non-ready API outcomes.

## Files

- `apps/web/lib/delivery-service.ts`
- `apps/web/lib/delivery-service.review-fix.test.ts`

The listed route tests were run unchanged; this slice required no route-source change.

## TDD evidence

### RED

```powershell
& '.\\node_modules\\.bin\\vitest.cmd' run 'apps/web/lib/delivery-service.review-fix.test.ts'
```

Result: 5 expected failures: missing `createDeliverySnapshotReader`, policy digest facts absent from request/queue/CSV audits, and the retired resolved-blocking-flag behavior.

```powershell
& '.\\node_modules\\.bin\\vitest.cmd' run 'apps/web/lib/delivery-service.review-fix.test.ts'
```

Result: 1 expected failure: queue confirmation rebuilt audit facts with `reason: queued` rather than preserving the plan's `reason: ready`.

### GREEN

```powershell
& '.\\node_modules\\.bin\\vitest.cmd' run 'apps/web/lib/delivery-service.review-fix.test.ts' 'apps/web/app/api/listings/[id]/deliver/route.test.ts' 'apps/web/app/api/listings/[id]/deliver/route.review-fix.test.ts'
& '.\\node_modules\\.bin\\tsc.cmd' -p 'apps/web/tsconfig.json' --noEmit
git diff --check
```

Result: 3 test files / 26 tests passed; web TypeScript check exited 0; diff check exited 0.

## Self-review

- Verified no web delivery function retains a second target/status/flag/projection/digest implementation after policy evaluation.
- Confirmed ready CSV and API flows derive their version and digest from the same policy plan.
- Confirmed audit records for CSV, publish-request, and publish-queued include policy facts, including `versionId` and `payloadDigest`.
- Confirmed policy outcomes are converted back to the prior public response shapes; disconnected does not leak internal audit facts.
- Confirmed repository and asset URL exceptions are not caught in the adapter and continue through the existing infrastructure boundary.

## Concerns

- The worktree retains pre-existing unrelated changes and untracked generated folders; they were not staged or modified by this task.
- The snapshot reader intentionally resolves asset URLs only after a first pure-policy readiness check so disconnected/already-published paths retain the established no-unneeded-asset-read behavior. It re-evaluates the same shared policy after those URLs are available; it does not duplicate policy rules.
