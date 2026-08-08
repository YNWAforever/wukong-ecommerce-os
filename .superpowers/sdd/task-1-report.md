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

## Review Fix (2026-08-08)

### Status

DONE

### Files

- `packages/shopline/src/delivery-policy.ts`
- `packages/shopline/src/delivery-policy.test.ts`
- `.superpowers/sdd/task-1-report.md`

### RED evidence

```powershell
npm.cmd run test -- src/delivery-policy.test.ts
```

Result: exit 1; the new published-before-connection, audit-facts, and cross-workspace connection regressions failed as expected (5 failures). After expanding the audit matrix to unsupported-method and wrong-target outcomes, the focused test correctly failed again with 2 missing version/digest assertions.

### Fix

- Restored the legacy policy order: after target, active-version, status, and blocking-flag checks, request-phase API `published` returns `already_published` before connection eligibility.
- Made audit facts derive the active-version ID/digest whenever available and include any supplied connection ID; each result retains a specific reason.
- Reused `projectToShopline` as the single established projection-and-validation boundary, removing the redundant second `validateShoplineProduct` call without changing API/CSV payload behavior.
- Added focused coverage for a verified connection from another workspace returning `disconnected` with its connection ID in audit facts.

### GREEN evidence

Focused policy command:

```powershell
npm.cmd run test -- src/delivery-policy.test.ts
```

Result: exit 0; 1 passed file, 26 passed tests.

Shopline package regression command:

```powershell
npm.cmd run test
```

Result: exit 0; 5 passed files, 52 passed tests.

Typecheck command:

```powershell
npm.cmd run typecheck
```

Result: exit 0; `tsc -p tsconfig.json --noEmit` completed without errors.

### Self-review

- Confirmed stale-plan version/digest binding remains before projection and no policy-side connector work exists.
- Confirmed API and CSV still share exactly `projectToShopline` and the resulting validated payload.
- Confirmed the working changes are confined to the shared Shopline policy, its policy test, and this required report; existing web, worker, database, and unrelated worktree changes remain untouched.

### Concerns

None. The policy intentionally leaves remote-product lookup and host adapter side effects outside this pure contract.
