# Catalog Control Center — Sprint Acceptance Criteria

## In scope

- Show the 100 most recent platform-product mirror records for the signed-in workspace.
- Join each mirror record to its Wukong listing status when a draft link exists.
- Show a product title, SKU, remote product ID, source, workflow status, and blocking-flag count.
- Provide client-side search across title, SKU, remote product ID, and connector specification version.
- Provide cohorts for all products, attention required, review required, unlinked products, and published products.
- Link an existing draft to its review route and an unlinked product to the existing new-draft flow.
- Keep this sprint read-only: it must not approve, publish, or mutate remote product data.

## Safety and tenancy

- Every catalog read must resolve an authenticated session.
- Every database query must run through the existing workspace-scoped repository boundary.
- The control center must not bypass current compliance flags, approval rules, or publishing jobs.
- No database migration is introduced in this sprint.

## Verification gates

- Runtime formatting passes.
- Type checking and linting pass for every workspace package.
- Catalog API authentication and join behavior are covered by unit tests.
- Catalog filtering and status labels are covered by unit tests.
- Existing integration, production-build, and Playwright acceptance suites remain green.

## Explicitly deferred

- Cursor pagination and server-side search.
- Creating a linked draft directly from a platform-product mirror record.
- Remote-versus-local field comparison and reconciliation states.
- Bulk enrichment, approval, publishing, and retry actions.
- Cross-channel catalog comparison.
