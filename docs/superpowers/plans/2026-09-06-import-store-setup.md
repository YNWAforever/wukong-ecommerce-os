# Inline SHOPLINE Store Setup Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for implementation and independent review. The user has approved the focused design and implementation; do not reopen approval.

**Goal:** Make store setup discoverable directly in catalog import without losing selected workbook state.
**Architecture:** Authenticated, workspace-scoped setup-summary GET; reusable inline admin connection form; setup card sibling to the persistent import form.
**Tech Stack:** Existing Node 24, pnpm 11.7, Next, React, plain CSS, Vitest and Playwright.

## Global constraints

Base main 691ac1285fc24b2750b92157b674bb3828e74bfa; branch codex/import-store-setup in existing isolated worktree. Full design: docs/superpowers/specs/2026-09-06-import-store-setup-design.md. Preserve API-token requirement, server admin/owner mutation authorization and source identity. No schema/dependency or production configuration changes; no publication, real workbook or external writes.

## Task 1: Inline setup behavior and regressions

Files: new apps/web/app/api/workspace/import-setup/route.ts and tests; new apps/web/components/import-store-setup-panel.tsx and tests; modify bulk-import-panel.tsx, admin-connection-panel.tsx and related tests/CSS as needed.

- [ ] Write failing route tests for signed-in scoped summary and role capability matrix, no secret leakage, no-store, unauthenticated and invalid/missing key cases. Reuse assertShoplineEncryptionKey, expose only summary/capability booleans.
- [ ] Write failing rendered integration test: disconnected admin selects workbook/time, opens setup inline, connects, keeps actual input File and timestamp, then imports with the original bytes. Include non-admin guidance, unavailable configuration before token entry, retry and no nested forms.
- [ ] Run tests and record RED before implementing.
- [ ] Implement read-only setup endpoint with injected dependencies. Keep existing admin connection GET/POST/PATCH privileges unchanged. Return minimal connected shop domain, canManageConnection, canImport and credentialStorageConfigured fields; do not return key/token/other tenant data.
- [ ] Implement bilingual setup card with explicit configure/open/close and refresh actions; reuse connection component via completion callback. Unknown/missing connection disables upload submission but preserves file selection. Connected state permits import for operator-or-higher independently of encryption config. Handle auth/role failures and async unmounts safely.
- [ ] Run affected route/component suites, web typecheck and formatting. Commit explicit feature/test files only and write ignored task11-implementation-report.md with exact evidence.
- [ ] Independent spec and quality review; fix confirmed findings and recheck.

## Task 2: Acceptance and handoff

- [ ] Run full unit suite, typecheck, build and runtime formatting checks as appropriate. Synthetic browser verify both locales/narrow layout and selected-file preservation without merchant upload.
- [ ] Update onboarding/context and results with actual checks and remaining production key/deployment boundary.
- [ ] Independent whole-range review and clean local commit. Stop task-owned services; preserve old data/worktrees. Present finishing options without publishing automatically.
