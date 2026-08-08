# Task 3: Two-phase route ingress adapter

## Scope

- Updated the web ingress client contract so each ingress path accepts only its matching queue message type.
- Kept the SHOPLINE message to the four persisted identifiers: `workspaceId`, `draftId`, `versionId`, and `connectionId`.
- Kept `payloadDigest` on the publish job. The route now constructs a typed `ShoplinePublishJob` before ingress.
- Added route coverage that `ensure` receives the policy digest before ingress, while ingress receives no digest.
- Added queue-schema coverage for accepting the exact four-field SHOPLINE message and rejecting `payloadDigest` as an extra field.
- Did not change worker, database, or policy logic.

## TDD evidence

### RED

Added a compile-time negative test for a SHOPLINE ingress payload carrying `payloadDigest`.

Command:

```powershell
pnpm.cmd --filter @wukong/web typecheck
```

Result before implementation: failed with `TS2578: Unused '@ts-expect-error' directive`, proving the prior `CloudflareIngressClient` accepted the forbidden extra field at compile time.

### GREEN

Changed `CloudflareIngressClient.enqueue` to path-specific overloads and typed the route's SHOPLINE message as `ShoplinePublishJob`.

Command:

```powershell
.\node_modules\.bin\vitest.cmd run 'apps/web/app/api/listings/[id]/deliver/route.test.ts' apps/web/lib/cloudflare-queue-runtime.test.ts packages/jobs/src/cloudflare-queue.test.ts
```

Result: 3 test files passed, 17 tests passed.

## Verification

```powershell
pnpm.cmd --filter @wukong/web typecheck
pnpm.cmd --filter @wukong/jobs typecheck
```

Both commands passed.

## Acceptance mapping

- Ready API delivery persists the policy-plan digest through `publishJobs.ensure` before ingress.
- Ingress carries only the strict four-field `ShoplinePublishJob`.
- Ingress failure returns `retry_required` without `markQueued`; the job remains `pending_enqueue`.
- Successful ingress calls `markQueued` afterward and returns the existing queued result.
- Disconnected API delivery retains its explicit CSV fallback and avoids ingress.
- The queue schema accepts the four fields and rejects a digest field.

## Concerns

- The worktree contained unrelated pre-existing changes and generated/untracked directories; they were preserved and not staged.

## Review finding: disconnected default-delivery coverage

### RED

Added a route-level test using `createDeliverListingHandler` with the real `defaultDelivery` adapter, a disconnected connection, and a non-empty image fixture. The test asserted the explicit CSV fallback response and that no publish job, ingress, asset URL, or audit side effect ran.

Command:

```powershell
.\node_modules\.bin\vitest.cmd run 'apps/web/app/api/listings/[id]/deliver/route.test.ts'
```

Result before the fix: failed as expected. `sourceAssets.getByIds` was called once for `asset_csv_side_effect_probe`, proving the snapshot reader eagerly resolved payload images before returning the disconnected fallback.

### GREEN

Deferred image URL resolution until the first policy evaluation has returned `ready`, then reevaluate with the resolved URLs before CSV generation or API job creation. This preserves the strict four-field ingress payload and existing ensure -> ingress -> markQueued ordering.

### Verification

```powershell
.\node_modules\.bin\vitest.cmd run 'apps/web/app/api/listings/[id]/deliver/route.test.ts' apps/web/lib/cloudflare-queue-runtime.test.ts packages/jobs/src/cloudflare-queue.test.ts
pnpm.cmd --filter @wukong/web typecheck
pnpm.cmd --filter @wukong/jobs typecheck
git diff --check
```

Results: 3 test files / 18 tests passed; web typecheck passed; jobs typecheck passed; diff check passed.

### Self-review

- The new test uses the real `defaultDelivery` path and retains the earlier stubbed `DeliveryPort` response-mapping test.
- A disconnected API response is exactly the explicit CSV fallback and does not call `publishJobs.ensure`, ingress, asset lookup/signed URL generation, or audit writes.
- The Shopline queue message remains the existing four identifiers; no digest was added.
- Only the focused route test, delivery-service deferred resolution, and this report are intended for the commit.
