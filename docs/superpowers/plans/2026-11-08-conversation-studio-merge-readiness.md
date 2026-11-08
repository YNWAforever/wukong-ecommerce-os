# Conversation Studio merge readiness

Status: **merge prepared and verified locally with a real pnpm install and production build;
nothing pushed, merged into `main`, deployed or activated.** Updated 2026-11-09 (Asia/Singapore)
after the user approved merge preparation and kept every activation off.

- Feature branch: `claude/conversation-studio` at `6d4b92e9` (30 commits), isolated worktree
  `.worktrees/conversation-studio`.
- Branch base: `a12ad1c5` — the tip of `claude/production-recovery-spec`, which is **11 commits
  ahead of `main`** (`main` = `8e1777ad`). The branch therefore already contains `main`.
- Working tree clean; secret-pattern scan clean; branch was never pushed (no remote tracking ref).

## What changed during merge readiness

A throwaway worktree from the branch was given a **real pnpm 11.7.0 install** (bootstrapped locally
from the npm registry tarball into the temp directory; the machine has no working corepack/npm
shim) using the repository's existing `.pnpm-store` **offline** and the lockfile as committed.

1. **Frozen-lockfile install: PASS.** `pnpm install --frozen-lockfile --offline --ignore-scripts`
   resolved 203 packages from the store, ran the supply-chain policy check (401 entries) and
   completed in ~20 s — the hand-added `@wukong/ai` web dependency/lockfile entry is consistent.
2. **`pnpm typecheck`: PASS** (14/14 turbo tasks) and **`pnpm lint`: PASS** (14/14).
3. **Production build initially FAILED and was fixed.** Turbopack could not resolve the `.js`
   relative import specifiers used by 14 build-graph files under `apps/web/lib/studio` (unit tests
   and `tsc` resolve them, so this was invisible until `next build`). Commit `6d4b92e9` converts
   those web files to extensionless relative imports (repository web convention); the two
   pre-existing web files with the same pattern were aligned too.
4. **`pnpm --filter @wukong/web build`: PASS** after the fix — Turbopack compiles all routes,
   including `/studio`, `/studio/t/[threadId]`, `/studio/threads`, `/studio/outputs`,
   `/studio/settings` and `/api/studio/*`, `/api/mcp`.
5. Re-verified after the fix: web typecheck clean; 279 files / **2737 web unit tests pass**;
   Studio scoped suite 31 files / 252 tests; Studio integration on disposable Postgres **20/20**;
   typecheck/lint/build as above.

`pnpm test` (the root script that starts with `node --test tests/*.mjs` and then runs turbo) is the
one command that cannot pass in this environment: Node here is **26.13**, while the project targets
Node 24. The root `node --test` step fails inside pre-existing scripts with
`ERR_INVALID_ARG_VALUE` (`stripTypeScriptTypes` in `scripts/benchmark-opak-maintenance.mjs`), before
any Studio code runs; `turbo run test` under Node 26 also hit parallel worker collection failures in
this sandbox. Per-package direct vitest runs passed: web 2737, core+ai 770, db 196, assets 82,
shopline 287, jobs 53; worker 419 tests passed in 33 files with 11 environment-dependent collection
failures. This is a Node-version/sandbox limitation, not a Studio regression; CI uses the pinned
Node 24.

## Topology

| Group | Commits | Files changed | Notes |
| --- | --- | --- | --- |
| Production recovery (`main..a12ad1c5`) | 11 | 20 | DB migration tooling/inventory/verifier + docs; not previously merged |
| Conversation Studio (`a12ad1c5..HEAD`) | 30 | 159 | Studio feature; base intentionally includes the recovery worktree state |
| Combined merge (`main..HEAD`) | 41 | 178 (≈ +39.8k / −0.3k) | One overlapping file between groups: `packages/db/src/client.ts`; git auto-merges it |

## Dry-run results

Both merge strategies were rehearsed in throwaway worktrees from `main`; the main checkout was
never switched, merged, reset or otherwise modified. The rehearsals were run before commit
`6d4b92e9` (import fix), which only changes relative import specifiers in web source and therefore
cannot introduce a merge conflict; merge cleanliness was re-checked afterwards.

| Strategy | Result |
| --- | --- |
| **A. Merge the whole branch** into `main` (`git merge --no-ff claude/conversation-studio`) | **Clean — no conflicts** ("Automatic merge went well"). Verification merge candidate `fb30f860` was created only on a temporary branch (green at that revision), then removed. |
| **B. Studio-only**: cherry-pick the 30 Studio commits (`a12ad1c5..claude/conversation-studio`) onto `main` | **Clean — no conflicts** at the time of the rehearsal (27 commits then; the three later commits are an import fix, docs and capability states and apply cleanly by construction). Not fully re-verified separately. |

**Recommendation: strategy A**, because the recovery commits are the user's own pending work on the
same line, the combined merge is clean, and the branch content (which already contains `main`) was
fully verified with real dependencies and a production build.

## Verification summary at `6d4b92e9` (real pnpm install)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline --ignore-scripts` | PASS (203 packages; 401-entry supply-chain check) |
| `pnpm typecheck` / `pnpm lint` | PASS 14/14, 14/14 |
| `pnpm --filter @wukong/web build` (Turbopack) | PASS |
| Full `apps/web` unit suite | 279 files / 2737 tests PASS |
| Studio scoped suite | 31 files / 252 tests PASS |
| `packages/core` + `packages/ai` / `packages/db` / assets / shopline / jobs | 770 / 196 / 82 / 287 / 53 PASS |
| Studio integration on disposable Postgres | 20/20 PASS |
| Playwright `tests/e2e/studio.spec.ts` | BLOCKED: 2 clean skips (flags-on fixture unavailable) |
| Root `pnpm test` | BLOCKED by Node 26 vs pinned Node 24 (pre-existing root-script incompatibility; see above) |

## Preconditions before the actual merge

1. Run the merge and its CI on **Node 24** (the project's pinned runtime); the frozen-lockfile
   install itself is now proven.
2. Confirm whether the recovery branch should land together with Studio (strategy A) or Studio alone
   (strategy B, re-run the full verification on the rebased tree).
3. Decide whether the 30-commit history should be preserved (`--no-ff`) or squashed.
4. No production migration/deploy/live activation is part of this merge; all flags stay off until
   separately approved.

## Exact merge steps (local, user-run or user-authorised)

```bash
# In the primary checkout, after the Node 24 install/typecheck baseline:
git checkout main
git pull --ff-only                 # only if origin/main is reachable and up to date
git merge --no-ff claude/conversation-studio -m "feat: add conversation studio (pilot, flags off)"

# Post-merge verification (no deploy):
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint
pnpm --filter @wukong/web build
pnpm test                          # Node 24 CI runtime
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

## Still-BLOCKED items after merge prep

- Root `pnpm test`/full CI on the pinned Node 24 runtime (this machine has Node 26 only).
- Flags-on authenticated browser acceptance (needs seeded auth + enabled workspace fixture; the
  production build and all Studio routes now compile successfully, which was the main gap).
- `audit:verify` CLI gate / readiness-gate log scan (need a seeded pilot workspace/deployment env).
- Live provider, hosted-MCP client calls and external MCP transport (deliberately never activated).

See `docs/superpowers/plans/2026-11-08-conversation-studio-results.md` for the task-by-task record,
commits and acceptance matrix; `docs/runbooks/conversation-studio.md` for operating it after an
approved enablement.
