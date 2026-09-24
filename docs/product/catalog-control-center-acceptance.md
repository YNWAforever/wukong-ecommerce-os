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

## Existing-product Bulk Update acceptance — 2026-09-05

This section extends the original read-only sprint above for the implemented catalog operations flow; the original deferred bulk-action list is historical scope, not the current source state. Task 5 source and synthetic verification are recorded in docs/superpowers/plans/2026-09-05-result-reconciliation-verification.md. This does not claim deployment or merchant UAT completion.

- Catalog selection, source-bound confirmations/approval, ready artifact download and attempt-bound operator reporting use the existing workspace/role boundaries.
- Workbook fidelity covers all 71 positions independently: eight permitted content changes, ten locked, 51 pass-through and two neutral deltas. The contract fixture supplies both ordered headers; the output sheet is Default. Extra nonempty header columns, renamed/reordered headers and variant identities are refused by the applicable parser contract.
- Exact source lexical strings are distinguished from normalized raw rows and typed XLSX cells. Numeric types/styles are not preserved; whitespace-only cells become blanks. Tests must never label successful normalized reparse as byte/typed fidelity.
- Blank deltas stay blank and nonblank deltas become +0. Merchant acceptance and stock neutrality remain an authorized UAT decision, not a passing-unit-test claim.
- Leading-zero/alphanumeric IDs, empty optional identifiers, missing product identity, numeric lexical values, unlimited/negative stock and multiline content have synthetic coverage in packages/shopline/src/bulk-form-fidelity.test.ts.
- Operator-reported accepted/rejected totals remain independently unverified. Historical/manual reports cannot close an export attempt.
- Retain the pre-change source, exact delivered bytes/digest and current protected-field comparison before separately authorized merchant restoration. A stale whole-row re-import is never automatically safe.
- Real attended, golden-set, shadow and full-catalog stages remain unchecked; use docs/runbooks/opak-uat-rollout.md for evidence and sign-off. Keep generated and merchant evidence private.
