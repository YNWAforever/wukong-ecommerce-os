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
