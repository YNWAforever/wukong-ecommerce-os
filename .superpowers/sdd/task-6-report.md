# Task 6 Report: Clean-Checkout Release Gate

**Date:** 2026-07-19 (Asia/Hong_Kong)
**Branch:** `codex/production-listing-workflow`
**Verified head:** `55df0d3 test: isolate auth repository integration data`
**Merge base:** `cac7400646b5f09dee852eef9d412d2a873afb7b`
**Clean runtime:** Node `v24.18.0`; Corepack pnpm `11.7.0`

## Outcome

Task 6 is **release-ready for managed preview**. A detached checkout at the verified head passed frozen dependency installation, runtime formatting, database build and migration, lint, typecheck, unit tests, service-backed integration tests, production build, browser-driven real-stack acceptance, exact-draft audit verification, and tenant-isolation verification.

The acceptance boundary used the production-built Next.js server, the real worker, Postgres, Redis, MinIO, and Mailpit. Only the external AI and SHOPLINE adapters were fake/mock, as intended for the release gate.

## Protected working-tree state

The implementation worktree still contains exactly the four pre-existing user changes below. They remained unstaged and were not included in any Task 6 commit:

```text
 M .gitignore
 M apps/web/.gitignore
 M apps/web/auth.test.ts
 M docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md
```

## Reproducible clean-checkout evidence

- Detached checkout: `C:\tmp\wukong-task6-clean-45d33fa`, advanced to `55df0d3`.
- `corepack pnpm install --frozen-lockfile`: passed with pnpm `11.7.0`.
- Final clean status after generated Playwright artifacts were removed: empty.
- `corepack pnpm format:runtime:check`: passed; merge base `cac7400`; 82 release-scope files checked.
- `.env.example`: validated semantically by `tests/railway-config.test.mjs`.
- Dependency-inclusive database build and `@wukong/db db:migrate`: passed.

## Static and unit gate

- `corepack pnpm lint`: 14/14 Turbo tasks passed.
- `corepack pnpm typecheck`: 14/14 Turbo tasks passed.
- `corepack pnpm test`: passed across all workspace packages.
- Node release/config tests: 10/10 passed.
- Web unit tests: 33 files, 193 tests passed.
- No unit-test failures.

## Service-backed integration gate

- `corepack pnpm test:integration`: 7/7 files and 46/46 tests passed.
- The gate covers Postgres repositories and Redis queue behavior.
- A prior failure was traced to integration assertions reading unrelated global auth rows left by the real browser story.
- Commit `55df0d3` scopes those assertions to their test email/user IDs.
- Focused verification after the fix: 14/14 auth-access integration tests passed.
- Full integration verification after the fix: 46/46 passed.

## Production build

- `corepack pnpm build`: 8/8 workspace build tasks passed.
- Next.js production compilation, TypeScript, page-data collection, and static generation passed.
- Worker and package artifacts compiled successfully.
- Non-blocking baseline warnings remain for the Next.js middleware-to-proxy convention and Turbo's undeclared web output cache metadata.

## Real Opak acceptance

Command:

```powershell
$env:PLAYWRIGHT_E2E = '1'
corepack pnpm exec playwright test --project=chromium --workers=1 --reporter=line
```

Result:

- 2 passed, 1 intentionally skipped, 0 failed.
- Passed the real application-boundary check.
- Passed the Opak admin journey through asset upload, listing intake, AI generation, review/edit, approval, CSV export, publish queue, mock SHOPLINE publish, and visible remote product ID.
- The separate invited-admin story remains intentionally skipped by its existing condition.

Exact accepted draft:

```text
dc6b002e-661a-4cee-bd2e-536c35296fc2
```

Audit/RLS verification:

```text
workspace: ws_opak
missing action count: 0
accessible foreign record count: 0
```

Observed audit sequence:

```text
listing.created -> listing.transition -> listing.submitted_for_review ->
listing.transition -> listing.version_appended -> listing.edited ->
listing.version_appended -> listing.approved -> listing.transition ->
listing.csv_exported -> listing.publish_queued -> listing.transition ->
listing.published -> listing.transition
```

## Release decision

**RELEASE-READY FOR MANAGED PREVIEW.**

The local and clean-checkout release gates are reproducible and green at `55df0d3`. Task 7 may now provision/configure the approved managed preview services and run the same acceptance story against the deployed preview. Production migration, Opak production seed, and production acceptance remain Task 8 and must only be marked complete after live deployment verification.
