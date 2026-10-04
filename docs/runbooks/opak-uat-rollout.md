# Opak UAT rollout

The 2026-10-01 maintenance release uses three attended merchant stages: exactly 5 → 20 → 100 products. This replaces the older 1–5 / 30–50 / 50–100 / full-catalog sequence. Each advance requires completed result reconciliation, zero hard failures and no unresolved cost or identity issue. Completing 100 products does not authorize a full-catalog run. Source implementation and synthetic tests do not close real merchant UAT, deployment or production migration gates. Use [the maintenance release packet](./opak-release-acceptance.md) for the current version and gate record.

## 1. Scope and evidence boundaries

Product Bulk Update modifies existing SHOPLINE products through a merchant-authorized manual re-import. Create CSV, images and direct API publishing remain separate capabilities. Use [pilot onboarding](./shopline-pilot-onboarding.md) for operator mechanics and [production readiness](./production-readiness.md) for infrastructure rollback.

Retain merchant workbooks, screenshots, receipts and comparison reports only in the approved private evidence location. Never commit merchant rows or generated evidence. Repository fixtures are synthetic; committed verification records contain aggregate results only.

## 2. Current source readiness

| Gate                                          | Source evidence                                                                                                           | Remaining operational gate                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 71 columns and Default output sheet           | packages/shopline/src/bulk-form.ts; bulk-form-xlsx.ts; bulk-form-fidelity.test.ts                                         | Authorized SHOPLINE re-import acceptance                                            |
| Variant refusal                               | parseBulkForm rejects a nonblank Variant ID; bulk-form.test.ts                                                            | Exclude variant products from the pilot                                             |
| Confirmation and freshness                    | apps/web/lib/bulk-export-service.ts; CONTEXT.md approval/source binding contract                                          | Current merchant protected fields must still be checked                             |
| Immutable approved source and artifact digest | apps/web/lib/bulk-export-service.ts; CONTEXT.md source and artifact history                                               | Verify deployed version and required migrations before use                          |
| Multi-product export and ready downloads      | apps/web/app/api/listings/export/route.ts and existing attempt detail/download routes                                     | Deployed smoke check with authorized data                                           |
| Operator report reconciliation                | apps/web/app/api/listings/[id]/shopline-import-result/route.ts; /jobs; Task 5 verification record                         | Operator assertions remain independently unverified                                 |
| Synthetic regression evidence                 | docs/superpowers/plans/2026-09-05-result-reconciliation-verification.md; packages/shopline/src/bulk-form-fidelity.test.ts | No real UAT stage completed by those checks                                         |
| Merchant restoration procedure                | Section 5 below                                                                                                           | Untested against SHOPLINE; separate explicit authorization required                 |
| Stage audit                                   | packages/db/src/cli/audit-verify.ts                                                                                       | Run against actual authorized stage scope; zero missing actions and foreign records |

These source paths replace older pending-PR and missing-route entries. They do not assert that the current branch is deployed or that production migrations have run.

## 3. Fidelity acceptance and stage sequence

Before Stage 1, compare the retained pre-change source with the exact delivered workbook independently across all 71 fields: eight permitted content fields, ten locked fields, 51 pass-through fields and two neutral quantity deltas. Verify both header rows in order and the Default sheet. Validate product membership and identifiers as well as per-cell values; exclude variant rows.

The synthetic comparison reads output XML independently of the production reader. It proves string-grid preservation for leading-zero and alphanumeric identifiers, numeric lexical values such as 00100.00 and 4.20e1, unlimited/negative stock, empty optional identifiers and multiline cells. Missing product IDs are refused. It is not proof of original typed-cell fidelity: numeric cells become inline strings, styles are discarded, empty strings/whitespace-only cells normalize to blanks, and original XLSX bytes are not retained by the writer. A numeric identifier already coerced by another application cannot be recovered.

Current delta behavior is exact: a blank normalized source delta remains blank; every nonblank delta becomes +0. Whether blank versus +0 is accepted with no stock movement remains a merchant decision until an explicitly authorized re-import and fresh SHOPLINE export prove it. Do not mark stock neutrality verified solely from generated XML.

| Stage                   | Entry                                                                                                                                                                                   | Exit requiring written merchant evidence                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — 5 attended products | Reviewed/deployed code and migrations verified; freshness and all confirmations renewed for the approved source; restoration evidence retained; separate explicit first-write authority | SHOPLINE accepts all intended rows; fresh export shows intended content only, no identifier coercion or protected-field drift; blank/+0 decision recorded; zero hard failures and no unresolved cost/identity issue |
| 2 — 20 products         | Stage 1 signed off with completed result reconciliation and an explicit advance decision                                                                                                | All included members reconciled by exact attempt/version; fresh-export comparison passes; zero hard failures and no unresolved cost/identity issue                                                                  |
| 3 — 100 products        | Stage 2 signed off with completed result reconciliation; pause/retry and ready download paths verified; explicit advance decision                                                       | No unresolved rejected/unreported members or protected-field regressions; fresh-export evidence retained; zero hard failures and no unresolved cost/identity issue                                                  |

All three real merchant stages remain unchecked by synthetic verification. Never infer merchant acceptance from XLSX generation or an operator-reported accepted result. Stop rather than expand when reconciliation is incomplete or a hard failure exists.

## 4. Reconciliation

Use the catalog Bulk Update action to retain a stable export attempt, then download its exact ready artifact. Record each included member using the exported version, not its later active version. /jobs shows accepted/rejected/unreported totals and retained rejection/correction reasons. Retry with the same idempotency key; a correction appends against the observed preceding receipt and includes a reason.

Historical/manual mode is explicitly unlinked and cannot close reconciliation for an export attempt. Even an all-accepted attempt remains independently unverified. A separate fresh-export comparison records supplied-snapshot field evidence; store and export time remain operator-attested, and the comparison does not change that status or establish live acceptance. See onboarding section 7 for the request contract.

## 5. Merchant restoration procedure

1. Before any authorized write, retain the original pre-change SHOPLINE source workbook, its SHA-256, export time/filename, the exact delivered artifact and SHA-256, attempt reference, included versions and approval reference. A regenerated workbook is not a substitute. The delivered enriched artifact is not the pre-change restoration source.
2. Pause further affected manual imports when a defect appears. Identify affected products from the exact attempt manifest and retain reported outcomes, including partial acceptance. Profiling counts can aid triage but do not establish field fidelity or restoration safety.
3. Obtain an authorized fresh SHOPLINE export and compare current protected identity, commercial, inventory and logistics fields against the retained source. Investigate every difference. A stale whole-row re-import can overwrite legitimate merchant changes and must not be treated as automatically safe.
4. Prepare a reviewed restoration artifact that restores only the intended previous content while preserving current protected fields and the merchant-approved neutral-delta representation. Retain its exact bytes, digest and independent 71-field comparison. Stop if current values or product identity cannot be established.
5. Obtain explicit merchant authorization for those exact restoration bytes, product scope and differences before manually importing. Reconcile partial results and verify against another authorized fresh export. Restoration is a separate manual action, never automatic reversal.

Infrastructure rollback remains in production-readiness.md; it does not restore merchant content.

## 6. Stage sign-off

Record stage, dates, product count, deployed revision and migration evidence; private evidence references for source/delivered/fresh-export digests and all-field comparisons; blank/+0 decision; attempt reconciliation including corrections; stage-scoped audit:verify aggregate result (zero missing actions and zero accessible foreign records); remaining defects; named Opak approver and explicit written advance/stop decision.

No provider calls, production migration, deployment, merchant data import or SHOPLINE write is authorized by this document alone.

## Attempt review packet

The selected-comparison evidence packet can assemble the exact export references, applicable receipt revisions and normalized comparison for stage review. It records a database as-of time and payload digest; subsequent operator corrections require a refreshed preview. It does not select the latest comparison automatically or sign off a stage. Continue retaining authorized original workbooks and obtaining the written merchant decisions required above. Packet integrity is a payload hash, not proof of merchant origin, export time, causality, stock neutrality or client receipt.
