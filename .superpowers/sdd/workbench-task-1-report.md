# Task 1 report

## Scope

Implemented the approved Task 1 workbench read contract in the specified worktree and exported it from `@wukong/db`.

## RED

Command:

```
corepack.cmd pnpm@11.7.0 --filter @wukong/db exec vitest run src/repositories/workbench-contract.test.ts
```

Observed failure:

```
Error: Cannot find module './workbench-contract.js'
Test Files 0 passed; failed suite 1
```

The failure was caused by the missing implementation module.

## GREEN

Command:

```
corepack.cmd pnpm@11.7.0 --filter @wukong/db exec vitest run src/repositories/workbench-contract.test.ts
```

Result: 1 test file passed, 12 tests passed.

Command:

```
corepack.cmd pnpm@11.7.0 --filter @wukong/db typecheck
```

Result: `tsc -p tsconfig.json --noEmit` passed.

Self-review:

```
git diff --check
```

Result: passed with no whitespace errors.

## Files

- `packages/db/src/repositories/workbench-contract.ts`
- `packages/db/src/repositories/workbench-contract.test.ts`
- `packages/db/src/index.ts`

The contract defines the exact workbench kinds, states, query, reason, item, and page types. `classifyListing` maps all active workflow statuses and unknown values to the specified semantic reasons.

## Commit

Committed as `d4e9053 feat: define workbench read contract`.

## Concerns

The repository patch helper was blocked by the worktree ACL, so the permitted PowerShell fallback was used. No implementation concerns remain.



## Review-gap fix

The review identified that the original contract only tested `reason` values and did not provide the required total reason-to-state semantic mapping. Added the exported, exhaustive typed `workbenchStateForReason(reason: WorkbenchReason): WorkbenchState` mapping:

- `failed`, `needs_info`, `review`, `delivery`, and `result_needed` -> `attention`
- `processing` -> `progress`
- `published`, `result_reported`, `preview_ready`, `preview_partial`, and `imported` -> `completed`
- `unknown` -> `unclassified`

Expanded the contract tests to assert both reason and state for every current listing status plus an unknown status, and to cover every `WorkbenchReason` exactly once. The redundant approved/reopened/unknown sample test was removed. The helper is exported from `packages/db/src/index.ts`.

## Review-gap RED

Command:

```
corepack.cmd pnpm@11.7.0 --filter @wukong/db exec vitest run src/repositories/workbench-contract.test.ts
```

Result: failed as expected with 23 failures and `TypeError: workbenchStateForReason is not a function` before the helper was implemented.

## Review-gap GREEN and verification

Commands:

```
corepack.cmd pnpm@11.7.0 --filter @wukong/db exec vitest run src/repositories/workbench-contract.test.ts
corepack.cmd pnpm@11.7.0 --filter @wukong/db typecheck
corepack.cmd pnpm@11.7.0 exec prettier --write packages/db/src/repositories/workbench-contract.ts packages/db/src/repositories/workbench-contract.test.ts packages/db/src/index.ts
git diff --check
```

Results: focused Vitest passed with 1 test file and 23 tests; package typecheck passed; Prettier formatted all three scoped TypeScript files; diff check passed with no whitespace errors.
