# Task 1 Report: Shared Shopline delivery policy tests and contract

## Status

DONE

## Implementation

- Added a pure `packages/shopline/src/delivery-policy.ts` contract with typed snapshots, plans, audit facts, and discriminated business outcomes.
- Added `evaluateDeliveryPolicy`, preserving the SHA-256 digest of `JSON.stringify(CanonicalListing)` via `hashCanonicalListing`.
- The policy uses existing `projectToShopline` and `validateShoplineProduct` for both API and CSV plans; it has no app, database, asset, queue, connector, or network imports.
- Worker evaluation returns `stale_plan` for a missing job, version drift, absent digest, or digest drift before projection and any host-side connector operation can be reached.
- Exported only the policy API and types from `packages/shopline/src/index.ts`.

## Files

- `packages/shopline/src/delivery-policy.test.ts` (new)
- `packages/shopline/src/delivery-policy.ts` (new)
- `packages/shopline/src/index.ts`

## RED evidence

Command:

```powershell
npm.cmd run test -- src/delivery-policy.test.ts
```

Result: exit 1; 1 failed test file and 19 failed tests. Each failure was caused by the intentionally absent `evaluateDeliveryPolicy`/`hashCanonicalListing` exports, confirming the new policy contract did not yet exist.

## GREEN evidence

Focused policy command:

```powershell
npm.cmd run test -- src/delivery-policy.test.ts
```

Result: exit 0; 1 passed file, 19 passed tests.

Package regression command:

```powershell
npm.cmd run test
```

Result: exit 0; 5 passed files, 45 passed tests.

Typecheck command:

```powershell
npm.cmd run typecheck
```

Result: exit 0; `tsc -p tsconfig.json --noEmit` completed without errors.

Scoped whitespace command:

```powershell
git diff --check -- packages/shopline/src/delivery-policy.ts packages/shopline/src/delivery-policy.test.ts packages/shopline/src/index.ts
```

Result: exit 0; no whitespace errors.

## Self-review

- Checked that only the requested Shopline source files are staged for this task; pre-existing worktree modifications and untracked artifacts remain untouched.
- Confirmed all policy outcomes are data-only objects and JSON-serializable.
- Confirmed API connection eligibility uses supplied metadata only; the policy has no probe or connector seam to call.
- Confirmed resolved compliance flags are not blocking, while open blocking flags retain the original structured flag data.

## Concerns

None for Task 1. Host adapter migration, publish-job state translation, and connector side-effect assertions remain intentionally deferred to Tasks 2–5.
