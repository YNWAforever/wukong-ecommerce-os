# Conversation Studio merge readiness

Status: **merge prepared and verified locally under the project's Node 24 runtime with a real
pnpm install and production build; nothing pushed, merged into `main`, deployed or activated.**
Updated 2026-11-09 (Asia/Singapore) after the user approved merge preparation and kept every
activation off.

- Feature branch: `claude/conversation-studio` (31 commits including documentation), isolated
  worktree `.worktrees/conversation-studio`.
- Branch base: `a12ad1c5` — the tip of `claude/production-recovery-spec`, which is **11 commits
  ahead of `main`** (`main` = `8e1777ad`). The branch therefore already contains `main`.
- Working tree clean; secret-pattern scan clean; branch was never pushed (no remote tracking ref).

## What changed during merge readiness

A throwaway worktree from the branch was given a **real pnpm 11.7.0 install** (bootstrapped locally
from the npm registry tarball into the temp directory; the machine has no working corepack/npm shim)
using the repository's existing `.pnpm-store` **offline** and the lockfile as committed. A portable
**Node 24.22.2** was downloaded from nodejs.org for the final CI-equivalent runs; all other earlier
runs in this session used the machine's Node 26.

1. **Frozen-lockfile install: PASS.** `pnpm install --frozen-lockfile --offline --ignore-scripts`
   resolved 203 packages from the store, ran the supply-chain policy check (401 entries) and
   completed in ~20 s — the hand-added `@wukong/ai` web dependency/lockfile entry is consistent.
2. **`pnpm typecheck`: PASS** (14/14 turbo tasks) and **`pnpm lint`: PASS** (14/14), on Node 26 and
   Node 24.
3. **Production build initially FAILED and was fixed.** Turbopack could not resolve the `.js`
   relative import specifiers used by 14 build-graph files under `apps/web/lib/studio` (unit tests
   and `tsc` resolve them, so this was invisible until `next build`). Commit `6d4b92e9` converts
   those web files to extensionless relative imports (repository web convention); the two
   pre-existing web files with the same pattern were aligned too.
4. **`pnpm --filter @wukong/web build`: PASS after the fix**, on both Node 26 and Node 24 —
   Turbopack compiles all routes, including `/studio`, `/studio/t/[threadId]`, `/studio/threads`,
   `/studio/outputs`, `/studio/settings`, `/api/studio/*` and `/api/mcp`.

## Node 24 verification summary (final evidence)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline --ignore-scripts` (Node 24) | PASS (203 packages; 401-entry supply-chain check) |
| `pnpm typecheck` / `pnpm lint` | PASS 14/14, 14/14 |
| `pnpm --filter @wukong/web build` (Turbopack) | PASS |
| Root `node --test` suites (9 files, exact root-script list) | **145 tests PASS** |
| `apps/web` unit suite (direct vitest, threads pool) | **2763 passed, 11 skipped, 0 failed** |
| `packages/core` / `packages/ai` / `packages/db` (unit) | 326 / 444 / 196 PASS |
| `packages/assets` / `packages/shopline` / `packages/jobs` / `apps/worker` | 82(+1 skip) / 287 / 53 / 419 PASS |
| Studio integration on disposable Postgres (Node 24) | **20/20 PASS** (migration replay, repositories, MCP resolver) |
| Direct import-fix regression checks | web typecheck clean; Studio scoped 31 files / 252 tests PASS |
| Playwright `tests/e2e/studio.spec.ts` | BLOCKED: 2 clean skips (flags-on authenticated fixture unavailable) |

**The exact `pnpm test` root command is blocked by this sandbox** (not by the code): its
`turbo run test` step launches Vitest's default forked workers/temp dirs and fails with
`EPERM ... mkdir ...\ssr`. Every package suite passes under Node 24 when run directly with
`--pool=threads --no-file-parallelism`, and the root `node --test` half passes exactly as written.
A normal CI runner on Node 24 should be expected to pass; that run is the outstanding confirmation.

## Topology

| Group | Commits | Files changed | Notes |
| --- | --- | --- | --- |
| Production recovery (`main..a12ad1c5`) | 11 | 20 | DB migration tooling/inventory/verifier + docs; not previously merged |
| Conversation Studio (`a12ad1c5..HEAD`) | 31 incl. docs | 159 | Studio feature + records; base intentionally includes the recovery worktree state |
| Combined merge (`main..HEAD`) | 42 | 178 (≈ +39.9k / −0.3k) | One overlapping file between groups: `packages/db/src/client.ts`; git auto-merges it |

## Dry-run results

Both merge strategies were rehearsed in throwaway worktrees from `main`; the main checkout was
never switched, merged, reset or otherwise modified. The rehearsals ran before the import fix
(`6d4b92e9`), which only changes relative import specifiers in web source and cannot introduce a
merge conflict; merge cleanliness was re-checked afterwards.

| Strategy | Result |
| --- | --- |
| **A. Merge the whole branch** into `main` (`git merge --no-ff claude/conversation-studio`) | **Clean — no conflicts** ("Automatic merge went well"). A verification merge candidate was created only on a temporary branch (green at that revision), then removed. |
| **B. Studio-only**: cherry-pick the Studio commits (`a12ad1c5..claude/conversation-studio`) onto `main` | **Clean — no conflicts** at the time of the rehearsal; not fully re-verified separately. |

**Recommendation: strategy A**, because the recovery commits are the user's own pending work on the
same line, the combined merge is clean, and the branch content (which already contains `main`) was
fully verified with real dependencies and a production build under Node 24.

## Preconditions before the actual merge

1. Run the merge and its CI on **Node 24** (the project's pinned runtime) on a normal CI runner;
   the frozen-lockfile install, typecheck/lint, production build, root suites, per-package units and
   Studio integration are all proven locally under Node 24.
2. Confirm whether the recovery branch should land together with Studio (strategy A) or Studio alone
   (strategy B, re-run the full verification on the rebased tree).
3. Decide whether the 31-commit history should be preserved (`--no-ff`) or squashed.
4. No production migration/deploy/live activation is part of this merge; all flags stay off until
   separately approved.

## Exact merge steps (local, user-run or user-authorised)

```bash
# In the primary checkout, on Node 24:
git checkout main
git pull --ff-only                 # only if origin/main is reachable and up to date
git merge --no-ff claude/conversation-studio -m "feat: add conversation studio (pilot, flags off)"

# Post-merge verification (no deploy):
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint
pnpm --filter @wukong/web build
pnpm test                          # normal CI runner, Node 24
# Studio integration needs a disposable local Postgres:
#   STUDIO_TEST_DATABASE_ADMIN_URL=postgres://wukong:wukong@127.0.0.1:54329/wukong_studio_test
#   STUDIO_TEST_DISPOSABLE=yes
#   pnpm vitest run --config vitest.integration.config.ts packages/db/src/studio-*.integration.test.ts \
#     packages/db/src/repositories/studio.integration.test.ts
```

Optional push (needs working GitHub credentials; **not performed**):
`git push -u origin claude/conversation-studio` (or push `main` after merge).

**Rollback before push:** `git reset --hard <sha-before-merge>`. **After push:** revert the merge
commit (`git revert -m 1 <merge-sha>`); migrations `0054`/`0055` are additive and were not applied
anywhere by this work.

## Merge does not activate anything

- Every flag stays unset/default-off; no workspace `studio_workspace_settings` row is enabled.
- No live model, external MCP, SHOPLINE write or deployment was exercised.
- Migrations `0054`/`0055` are not applied to any shared/production database; `0055` creates the
  `wukong_mcp_token_lookup` role and therefore needs a migration role with `CREATEROLE` (documented
  in the runbook).

## Still-BLOCKED / open items

- Exact `pnpm test` turbo invocation in this sandbox (worker-spawn EPERM); run on a normal Node 24
  CI runner.
- Flags-on authenticated browser acceptance (needs seeded auth + enabled workspace fixture; the
  production build and all Studio routes now compile successfully, which was the main gap).
- `audit:verify` CLI gate / readiness-gate log scan (need a seeded pilot workspace/deployment env).
- Live provider, hosted-MCP client calls and external MCP transport (deliberately never activated).

See `docs/superpowers/plans/2026-11-08-conversation-studio-results.md` for the task-by-task record,
commits and acceptance matrix; `docs/runbooks/conversation-studio.md` for operating it after an
approved enablement.
