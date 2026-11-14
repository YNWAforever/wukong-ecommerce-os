# Locale-aware dashboard titles implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Finish U3 by displaying product names in the selected UI language.

**Architecture:** Add optional bilingual title metadata to existing read models.
Keep the legacy title and select the display name in the browser.

**Tech stack:** Existing TypeScript, Drizzle/Postgres, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-localized-dashboard-titles-design.md`

## Global constraints

- No migrations, new dependencies, production data or manual deployments.
- Preserve workspace scoping, title authority, search membership and bounded hydration.
- Fall back across missing/blank translations and support older API responses.

## Review focus

- Empty and whitespace-only translations must not hide useful names.
- Operator-owned and locked names must win over stale generated content.
- Search and empty-query paths must return equivalent bilingual metadata.
- Scan URLs, workbook filenames and website reference names remain visible.
- Language changes must preserve row identity, selection and pagination.

### Task 1: Bilingual read projections

Files: `packages/db/src/repositories/{workbench-contract,workbench-reads,workspace-reads}.ts`
and their existing integration tests; `apps/web/lib/catalog-contract.ts`.

Interface: optional `titles?: Partial<Record<'en' | 'zh-Hant', string | null>>`
alongside existing `title` on dashboard row contracts.

- [x] Add assertions for both names to Workbench and Catalog integration fixtures,
      including current-input authority, search and bounded page hydration.
- [x] Run against disposable Postgres and confirm missing-metadata failures.
- [x] Extend each UNION consistently and carry metadata through Catalog mapping.
- [x] Run affected integration suites and confirm existing boundary/paging cases pass.

### Task 2: Locale-aware rendering and delivery

Files: `apps/web/lib/product-title.ts`, Workbench list, Catalog control center,
their existing component tests, and `tests/e2e/workbench.spec.ts`. The shared
selector is exercised through its real rendering consumers.

Interface: `productTitle(item, locale): string | null`, selecting
requested locale, other locale, then existing `title`.

- [x] Add failing fallback tests and component tests for language changes without
      refetch, including Catalog selection and both imported/draft row names.
- [x] Implement the selector and use it at the dashboard title render sites.
- [x] Run targeted tests, full unit suite, typecheck and web production build.
- [x] Obtain independent review; address material findings and verify changes.
- [x] Commit, push and open one PR with evidence and no-migration rollout notes.

## Verification evidence

- Baseline: clean checkout at `9c2aa25fedb35453c61d1f3018d5d2fd37eda15a`; remote
  main still matched before publication. Existing dashboard components 48/48 and
  repository integration 22/22 passed before changes.
- Four repository assertions failed on absent bilingual metadata, then all 22
  repository integration tests passed on a new disposable Postgres 17 container,
  with the non-superuser/non-BYPASSRLS runtime role. No production database used.
- Five component cases reproduced incorrect locale rendering; the subsequent
  retained-data test also exposed Workbench refetching on locale changes. The
  localized error text was the request dependency; a stable fallback fixes it.
  Final focused components: 56/56 passed.
- `pnpm test`: 4,223 passed, 2 skipped; 14/14 Turbo tasks, 4 cached. Root tests
  require subprocess/loopback permission in this environment; the initial
  restricted run failed because Node child-process spawning returned EPERM.
- `pnpm typecheck`: 14/14 tasks passed, 8 cached.
- `pnpm build --filter=@wukong/web --env-mode=loose`: 6/6 tasks passed, zero cached.
  The initial strict-environment build could not fetch the existing Google Fonts
  because Turbo filtered proxy variables. No source/config workaround was added.
- New authenticated Playwright case in `workbench.spec.ts`: passed against that
  production build and disposable database using installed Chromium. Confirmed
  real toggle, both dashboards, bilingual search, selection and reload. Local
  runner disables optional video because FFmpeg is absent; CI config is unchanged.
- Independent review: no material findings. Formatting and whitespace checks pass.

## Rollout

No schema migration, backfill, new configuration, or dependency. `titles` is
additive and optional, and `title` remains available to older clients. Deploy
through the existing web build, which rebuilds `@wukong/db`. No Worker release
coordination is required. No merge, manual deployment or merchant/provider writes.
