# Inline import store setup verification — 2026-09-06

Approved design implemented on codex/import-store-setup from GitHub main 691ac1285fc24b2750b92157b674bb3828e74bfa, using the existing isolated attempt-evidence-packet worktree. Earlier branches and ignored incident evidence are preserved.

## Behavior

Catalog import now starts with a bilingual numbered store-setup card. It shows connected domain, administrator guidance, loading/retry/auth failures, and unavailable credential storage before token entry. Admin/owner users open the existing connection form inline; successful setup refreshes status. Workbook and export-time inputs remain mounted outside that form. Unknown/missing store or insufficient import role prevents sending workbook bytes.

The new GET /api/workspace/import-setup is authenticated, scoped to the session workspace, and no-store for success and failure. It returns domain-only connection metadata and capability booleans. It validates storage configuration with the existing token-vault validator without revealing a key or token. Existing connection mutation permissions/audits and import server checks are unchanged. Connected spreadsheet import does not require decrypting the token.

## Reproduction and focused verification

RED reproduced a missing endpoint and four rendered UI failures for absent guidance and unguarded submission. The new route/UI suites then passed 15 tests. Final affected verification passed 63 tests in seven files: import-setup route, existing connection route, import-store-setup-panel, bulk-import-panel, bulk-import-panel.contract, admin-connection-panel and listing-intake-tabs. Web typecheck, explicit formatting and diff checks passed. Independent task review approved with no findings.

The unchanged baseline test gate passed all 14 Turbo tasks from cache (cached baseline suite). Direct web production build passed. The first managed Playwright attempt timed out during its 120-second server startup build before tests began; its log is retained. The exact managed build/environment is prebuilt before retry; no timeout or assertion is relaxed.

## Operational boundary

This is a local source change. No production environment value was configured and no deployment, migration, real workbook upload, merchant seed, paid AI call or SHOPLINE write was performed for this slice. The production credential-storage prerequisite remains separate: this UI will explain it, not bypass it. API-token-free store registration is outside the approved design.

Detailed synthetic logs and screenshots remain ignored under .superpowers/sdd/task11-* and node_modules/.task11-evidence. Final acceptance and service cleanup follow below.

## Final acceptance

- `corepack.cmd pnpm@11.7.0 test`: passed, 67 Node tests plus 1,694 package tests (1,761 total); 14 Turbo tasks successful, 13 cached. The web suite ran fresh: 124 files and 1,092 tests.
- `corepack.cmd pnpm@11.7.0 typecheck` and `lint`: passed.
- `corepack.cmd pnpm@11.7.0 format:runtime:check` and `runtime:forbidden:check`: passed.
- `corepack.cmd pnpm@11.7.0 build --filter=@wukong/web` under the managed synthetic browser environment: passed, six tasks, five cached.
- `corepack.cmd pnpm@11.7.0 exec playwright test --project=chromium --workers=1 --retries=0 --reporter=line --output=node_modules/.task11-evidence/browser-rerun`: 12 passed, two intentional skips, 2.1 minutes. The initial startup timeout was resolved by the exact managed prebuild; no assertion or timeout was relaxed.

Browser acceptance exercised real local connection and import handlers with synthetic credentials/workbook bytes, checked the persisted workbook digest and connection audit, retained native file/export-time state across inline setup, and retained viewer server-side rejection. Both locales passed at 375px and 1440px, including overflow assertions. The mobile inline setup screenshot was visually inspected. Existing attended reconciliation, listing, authentication and Worker boundary coverage also passed.

Independent implementation and whole-slice reviews found no critical, important or minor issues. No schema changed, so the separate database integration suite was not rerun for this slice. Source/store identity and export time remain operator supplied; setup visibility does not establish authenticated merchant workbook provenance or live SHOPLINE acceptance.

Task-owned PostgreSQL, MinIO and Mailpit were stopped. Managed application/Worker processes exited; no listeners remained on 55445, 9012, 9013, 8026, 1026, 49217 or 8787. Existing data was retained. Generated test-results were moved into ignored node_modules/.task11-evidence/generated-test-results. No production configuration or publication occurred.
