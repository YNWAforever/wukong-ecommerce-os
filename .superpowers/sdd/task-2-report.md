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

---

## Review-fix pass (4362b4d)

### Changes

- The snapshot reader now resolves listing asset URLs before its single policy invocation in both CSV and API delivery. The prior preflight call with `imageUrls: []` and second policy evaluation were removed.
- The adapter now invokes the connection reader itself within the workspace-scoped repository callback. The route no longer preloads connection metadata; route tests assert the adapter reads the listing before the connection.
- When `publishJobs.ensure` returns a reused pending job with a different connection ID, the publish request and both request/queued audit records use that persisted effective connection ID.

### Changed files

- `apps/web/lib/delivery-service.ts`
- `apps/web/lib/delivery-service.review-fix.test.ts`
- `apps/web/app/api/listings/[id]/deliver/route.ts`
- `apps/web/app/api/listings/[id]/deliver/route.test.ts`

### Commands and results

```powershell
& '.\\node_modules\\.bin\\vitest.cmd' run 'apps/web/lib/delivery-service.review-fix.test.ts' 'apps/web/app/api/listings/[id]/deliver/route.test.ts' 'apps/web/app/api/listings/[id]/deliver/route.review-fix.test.ts'
& '.\\node_modules\\.bin\\tsc.cmd' -p 'apps/web/tsconfig.json' --noEmit
git diff --check
```

Result: 3 test files / 28 tests passed; web TypeScript check exited 0; diff check exited 0.

### Self-review

- The focused policy spy proves CSV and API each call `evaluateDeliveryPolicy` once and only after receiving the resolved signed image URLs.
- The snapshot reader owns listing, connection, existing-delivery, and derived publish-job reads; no route-level default-connection preload remains.
- The persisted connection regression verifies the returned publish request and both request/queue audit records use the effective job connection ID.
- Existing public response unions, disconnected fallback, pure-policy boundary, and ensure -> ingress -> markQueued sequencing remain unchanged.

### Concerns

- Asset resolution now occurs before all delivery policy outcomes, including disconnected and already-published API outcomes, as required by the reviewed single-authoritative-evaluation contract.
- Pre-existing unrelated modified and untracked worktree files remain untouched and will not be committed.
