# Task 7 verification regression fix report

Date: 2026-08-08
Worktree: `C:/Users/laich/Documents/WukongEommerce/worktrees/shopline-ai-listing-mvp`

## Root cause

Commit `a9cf991` made `createDeliverySnapshotReader` resolve image URLs eagerly and removed the preparation-only deferred resolver. Consequently, the default API route called `sourceAssets.getByIds` before policy could return the disconnected CSV fallback. This regressed the behavior preserved by `927ad3e`.

## Fix

- `apps/web/lib/delivery-service.ts`: added an opt-in `deferImageUrls` reader mode and a resolver used only by `prepareShoplineDelivery`.
- Preparation now evaluates an empty-image preflight, returns every non-ready result immediately, and only resolves assets then evaluates final policy when preflight is ready.
- `deliverListing` continues using the default eager reader and one policy evaluation.
- `apps/web/lib/delivery-service.review-fix.test.ts`: preserved direct-delivery eager/single-policy coverage and added the preparation preflight/final-policy contract.

The two-phase ensure, ingress, and mark-queued flow, fallback response, and shared policy authority are unchanged.

## Commands and results

| Command | Result |
| --- | --- |
| `npm.cmd run test --prefix apps/web -- "app/api/listings/[id]/deliver/route.test.ts" -t "uses default delivery to return the CSV fallback without queue or CSV side effects"` (before fix) | RED: failed because `sourceAssets.getByIds` was called once. |
| `npm.cmd run test --prefix apps/web -- "lib/delivery-service.review-fix.test.ts" -t "preflights Shopline preparation before resolving image URLs"` (before fix) | RED: expected two policy calls, received one. |
| Both targeted commands after the fix | PASS: 1/1 each. |
| `npm.cmd run test --prefix apps/web -- "app/api/listings/[id]/deliver/route.test.ts" "app/api/listings/[id]/deliver/route.review-fix.test.ts" "lib/delivery-service.review-fix.test.ts"` | PASS: 3 files, 30 tests. |
| `npm.cmd run typecheck --prefix apps/web` | PASS. |
| `git diff --check` | PASS; only pre-existing LF/CRLF and global-ignore permission warnings. |

## Self-review

The deferred mode is opt-in and invoked solely by `prepareShoplineDelivery`. Its early return precedes asset resolution, job ensure, audit write, queue ingress, and queued confirmation. The ready path evaluates the same shared policy a second time with resolved URLs before job creation. Direct delivery retains its eager snapshot and existing single-policy behavior.

## Concerns

No code concerns found. The worktree contains unrelated tracked and generated changes that were intentionally left unstaged. Git continues to emit existing LF/CRLF and global-ignore permission warnings.
