# Conversation Studio merge readiness

Status: **merge prepared and dry-run verified locally; nothing pushed, merged into `main`, deployed
or activated.** Prepared 2026-11-08 (Asia/Singapore), after the user approved merge preparation and
kept every activation off.

- Feature branch: `claude/conversation-studio` at `76b66232` (27 commits), isolated worktree
  `.worktrees/conversation-studio`.
- Branch base: `a12ad1c5` — the tip of `claude/production-recovery-spec`, which is **11 commits
  ahead of `main`** (`main` = `8e1777ad`).
- Working tree clean; secret-pattern scan clean; branch was never pushed (no remote tracking ref).

## Topology

| Group | Commits | Files changed | Notes |
| --- | --- | --- | --- |
| Production recovery (`main..a12ad1c5`) | 11 | 20 | DB migration tooling/inventory/verifier + docs; not previously merged |
| Conversation Studio (`a12ad1c5..HEAD`) | 27 | 158 | Studio feature; base intentionally includes the recovery worktree state |
| Combined merge (`main..HEAD`) | 38 | 177 (+39,799 / −296) | One overlapping file between groups: `packages/db/src/client.ts`; git auto-merges it |

## Dry-run results

Both merge strategies were rehearsed in throwaway worktrees from `main` and removed afterwards; the
main checkout was not switched, merged, reset or otherwise modified.

| Strategy | Result |
| --- | --- |
| **A. Merge the whole branch** into `main` (`git merge --no-ff claude/conversation-studio`) | **Clean — no conflicts** ("Automatic merge went well"). Temp merge commit `fb30f860` was created only on a temporary branch for verification, then the worktree/branch were deleted. |
| **B. Studio-only**: cherry-pick the 27 Studio commits (`a12ad1c5..claude/conversation-studio`) onto `main` | **Clean — no conflicts** (all 27 applied). Temporary branch `tmp/studio-on-main` at `e365e30a` was then deleted. |

**Recommendation: strategy A**, because the recovery commits are the user's own pending work on the
same line, the combined merge is clean, and the merged tree was fully verified (below). Strategy B
isolates the Studio from the unmerged recovery work but would need its own full post-merge
verification and leaves two branches to reconcile later.

## Merged-tree verification (strategy A result, temporary worktree)

| Check | Result |
| --- | --- |
| Typecheck `apps/web` | PASS (after linking the new `@wukong/ai` workspace dependency the way pnpm would) |
| Typecheck `packages/{core,ai,db,shopline,assets,jobs}` + `apps/worker` | PASS (all exit 0) |
| Full `apps/web` unit suite | **279 files / 2737 tests passed** |
| `packages/core` + `packages/ai` units | 770 passed |
| `packages/db` units | 196 passed |
| Studio integration on disposable Postgres | **20/20 passed** (migration replay, repositories, MCP resolver) |

The temporary worktree, its node_modules junction farm (gitignored) and its branches were removed
after verification. No verification step wrote to production or called a live provider/MCP/SHOPLINE.

## Preconditions before the actual merge

1. **Frozen-lockfile install on a working pnpm machine** (BLOCKED here: pnpm/corepack unavailable).
   The `@wukong/ai` web dependency and its `pnpm-lock.yaml` importer entry were added by hand; run
   `pnpm install --frozen-lockfile` and the normal CI pipeline before merging.
2. Confirm the recovery branch is intended to land together with Studio (strategy A) — or choose
   strategy B and re-run verification on the rebased tree.
3. Decide whether the 27-commit branch history should be preserved (`--no-ff`) or squashed; no
   history rewrite is required for correctness.
4. No production migration/deploy/live activation is part of this merge; all feature flags and
   workspace Studio rows stay off until separately approved.

## Exact merge steps (local, user-run or user-authorised)

```bash
# In the primary checkout, after the frozen-lockfile install passes:
git checkout main
git pull --ff-only            # only if origin/main is reachable and up to date
git merge --no-ff claude/conversation-studio -m "feat: add conversation studio (pilot, flags off)"

# Post-merge verification (no deploy):
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
# Studio integration suites need a disposable local Postgres:
#   STUDIO_TEST_DATABASE_ADMIN_URL=postgres://wukong:wukong@127.0.0.1:54329/wukong_studio_test
#   STUDIO_TEST_DISPOSABLE=yes
#   pnpm vitest run --config vitest.integration.config.ts packages/db/src/studio-*.integration.test.ts \
#     packages/db/src/repositories/studio.integration.test.ts
```

Optional push (needs working GitHub credentials; **not performed**):
`git push -u origin claude/conversation-studio` (or push `main` after merge).

**Rollback before push:** `git reset --hard <sha-before-merge>`. **After push:** revert the merge
commit (`git revert -m 1 <merge-sha>`); migrations `0054`/`0055` are additive and were not applied
anywhere by this work, so no data rollback is involved.

## Merge does not activate anything

- Every flag (`CONVERSATION_STUDIO_ENABLED`, `CONVERSATION_STUDIO_AI_ENABLED`,
  `CONVERSATION_STUDIO_DEFAULT_HOME`, `STUDIO_MCP_SERVER_ENABLED`, `STUDIO_EXTERNAL_MCP_ENABLED`)
  stays unset/default-off.
- No workspace `studio_workspace_settings` row is enabled.
- No live model, external MCP, SHOPLINE write or deployment was exercised at any point.
- Migrations `0054`/`0055` are not applied to any shared/production database; `0055` creates the
  `wukong_mcp_token_lookup` role and therefore requires a migration role with `CREATEROLE`
  (documented in the runbook).

## Still-BLOCKED items after merge prep

- Frozen-lockfile install/CI (environment limitation).
- Flags-on Playwright acceptance (needs seeded auth + enabled workspace fixture).
- `audit:verify` CLI gate / readiness-gate log scan (need a seeded pilot workspace/deployment env).
- Live provider, hosted-MCP client calls and external MCP transport (deliberately never activated).

See `docs/superpowers/plans/2026-11-08-conversation-studio-results.md` for the full task-by-task
record, commits and acceptance matrix; `docs/runbooks/conversation-studio.md` for operating it after
an approved enablement.
