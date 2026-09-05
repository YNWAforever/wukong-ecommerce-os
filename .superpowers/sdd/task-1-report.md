# Task 1 backend implementation report

Base: 6bc21e0. Local branch: codex/catalog-fresh-export-verification. Synthetic development only; no push/deploy/production migration, merchant workbook, provider call or source/result/publish mutation.

## Wire contract for Task 2

Type-only browser imports from apps/web/lib/fresh-export-verification.ts:
- ExportVerificationWire (full persisted record with ISO createdAt and merchantAttestedExportAt)
- ExportVerificationSummaryWire (omits provenance; comparison contains only outcome + counts)
- ExportVerificationHistoryWire = {items: ExportVerificationSummaryWire[],total:number,page:number,pageSize:number}
- RecordExportVerificationWire = {verification:ExportVerificationWire,replayed:boolean}

Endpoint /api/listings/export/:attemptId/verifications. GET and POST require reviewer/admin/owner. Workspace/actor come only from session.

POST: raw XLSX body, URLSearchParams filename, merchantAttestedExportAt, sameStoreAttested=true. Timestamp must be valid calendar ISO with explicit Z/offset, strictly after artifactReadyAt and <= server now. Browser must convert explicit Hong Kong export time to ISO; no file timestamp inference. 201 new evidence; 200 exact identity retry. Filename/actor are deliberately not identity inputs: exact evidence retains first filename/actor.

GET ?page=1&pageSize=10 -> ExportVerificationHistoryWire. Page size 1..20; page 1..1,000,000. Exact total and rows share one SQL statement snapshot. Summary query does not load full comparison/provenance. GET ?verificationId=<UUID> -> {verification: ExportVerificationWire}, scoped by both authenticated workspace and attempt. Missing/foreign detail returns 404 comparison_not_found. Do not render summary as full evidence; request detail when selected.

Full record: id, exportAttemptId, artifactSha256, suppliedSha256, merchantAttestedExportAt, connectionId, policyVersion='fresh-export-v1', filename, recordedBy, provenance, comparison, createdAt. Provenance retains exact approved attempt/version/source/connection binding; comparison.products maps product IDs to that evidence. Original supplied XLSX bytes are NOT retained/downloadable.

comparison.outcome: matches_compared_fields | differences_found | inconclusive. Human labels: Matches compared fields / Differences found / Inconclusive. Any missing, ambiguous or variant target makes overall inconclusive while other product differences remain visible.

comparison.counts: expected, matched, differences, missing, ambiguous, unsupportedVariant, unrelatedRows, suppliedRows.

comparison.products[]: productId; outcome = matched | differences | missing | ambiguous | unsupported_variant; expectedRow={rowNumber,cells:(string|null)[]}; observedRows (all duplicates retained); fields (69 entries only for comparable targets); quantityDeltaObservations (2 entries only for comparable targets). Field = {column,category:intended|protected,expected:string|null,observed:string|null,different:boolean}. Delta = {column:updateQuantity|updateVariantQuantity,expected,observed}. 8 intended, 61 protected, 2 delta categories. Missing/ambiguous/variant fields arrays empty, never interpreted as matched. Complete rows remain retained for these outcomes.

Required scope copy: supplied snapshot; store and time operator-attested. Protected differences are observations, not causation claims. Delta values never establish stock neutrality. Normalized string comparison does not claim raw XLSX type/style fidelity, authenticated merchant origin, current live SHOPLINE truth or causal application. Existing reconciliation.verificationStatus and operator report totals remain untouched/unverified.

## Bounds and errors

4 MiB streamed upload bound, also checked in service; Default sheet with exact current en+zh header rows; 5,000 data rows; 32,767 characters/cell. All nonblank extra columns rejected. Blank cells/missing trailing cells normalize to null, meaningful whitespace and leading-zero IDs preserved. Exact ID only, never SKU/row order. Comparator normalized evidence <=2 MiB; repository checks entire input envelope +512 bytes reserved for generated ID/date so POST full record <=2 MiB. Oversized evidence rejects, never truncates. SQL defensive comparison-json bound is 3 MiB because PostgreSQL jsonb text inserts serialization whitespace; application 2 MiB wire bound is authoritative.

Safe errors:
- 401 unauthorized; 403 insufficient_role.
- 404 export_attempt_not_found, comparison_not_found.
- 400 comparison_same_store_required, comparison_filename_invalid, comparison_export_time_invalid, comparison_workbook_invalid, comparison_input_invalid, invalid_pagination, invalid_verification_id.
- 413 comparison_upload_too_large, comparison_input_too_large.
- 409 export_artifact_not_ready, export_provenance_incomplete, export_artifact_hash_mismatch, export_membership_mismatch, export_verification_binding_mismatch, comparison_identity_conflict (binding helper can also emit listing_not_in_export/export_version_mismatch).
- 503 export_artifact_unavailable, comparison_unavailable, comparison_history_unavailable. No reader/provider/SQL details in response/logs.

## RED / GREEN evidence

All commands use corepack.cmd pnpm@11.7.0 from active worktree.

1. --filter @wukong/shopline exec vitest run src/fresh-export-comparison.test.ts: RED missing module. GREEN 75 initial cases; final 77 cases after malformed localized header and serialized evidence-bound regressions. Full --filter @wukong/shopline test: GREEN 228 tests in 11 files.
2. --filter @wukong/db exec vitest run src/repositories/export-verifications.test.ts: RED missing module; GREEN 1 deterministic identity test (each identity dimension changes key).
3. --filter @wukong/web exec vitest run lib/fresh-export-verification.test.ts: RED missing module; GREEN 17 initial service cases, final 20.
4. --filter @wukong/web exec vitest run 'app/api/listings/export/[id]/verifications/route.test.ts': RED missing route; GREEN 16 route cases.
5. Combined web focused command: GREEN 36 tests in 2 files. --filter @wukong/web typecheck GREEN.
6. --filter @wukong/shopline build and --filter @wukong/db build GREEN.
7. After sourcing .superpowers/sdd/task8-db-env.ps1: --filter @wukong/db exec vitest run src/repositories/export-verifications.integration.test.ts: first run 7/8 (audit rollback assertion expected unwrapped driver message; corrected to Drizzle cause), final GREEN 9/9. Tests use shared TEST_DATABASE_* convention and check admin/runtime same database. Actual run only task8_integration, non-superuser NOBYPASSRLS runtime.
8. --filter @wukong/db exec vitest run src/export-verifications-migration.integration.test.ts with FRESH_EXPORT_REHEARSAL_DATABASE_ADMIN_URL pointing to task8_migration and FRESH_EXPORT_REHEARSAL_DISPOSABLE=yes: GREEN 2/2. Guard checks loopback:55445/task8_migration, separate from integration URL; current_database rechecked before each schema reset. Without explicit rehearsal opt-in, destructive tests skip. Proves fresh+replay; pre0017 synthetic legacy report ->0017 ->0018 upgrade preserves report and creates zero comparison receipts; full replay preserves report.
9. Full DB unit suite initially exposed tenant audit probe coverage missing export_verifications; added new table to TENANT_TABLES. Focused audit-verify suite GREEN 12/12; full DB rerun recorded below.

Real DB guarantees checked: one evidence+audit for concurrent exact retry; first actor/filename retained; new snapshot appends; complete paged total including empty page; full-detail workspace+attempt scoping; direct runtime RLS; composite foreign workspace FK (guard temporarily disabled in rollback-only admin transaction to isolate FK); update/delete rejected even after runtime privilege regrant; failed audit rolls back evidence; immutable digest/connection/membership/chronology enforced; all-migration replay preserves existing evidence; total-envelope size rejects before insert. No trusted evidence backfill.

## Review handoff / limitations

Independent spec/quality review is the next gate, owned by root after this commit. UI/E2E and full combined web suite remain root/Task2 gates. Services are root-owned and remain running for subsequent acceptance. Migration0018 has only been applied to guarded disposable local integration/rehearsal databases; operational DB and all production environments untouched by this task.

Final DB unit rerun: GREEN 69 tests in 14 files. Final formatting check and git diff --cached --check passed. Implementation commit before report inclusion: 0ffbb409a6e74bc88d3a9f28f4bf74bf9a1e2f69 (report added by amend; use current HEAD for review).

## Follow-up review fixes

P2 repeated full-attempt validation removed: service validates once before artifact I/O and once again at commit boundary; repository independently validates once at persistence. Existing validateExportResultBinding checks every included version, and now uses a listing-indexed Map plus uniqueness Set checks rather than scanning the entire evidence array for each member. Requested-member semantics and all immutable checks remain intact. Shared helper change also preserves operator-report behavior.

RED: --filter @wukong/web exec vitest run lib/fresh-export-verification.test.ts -t 'many-member' failed with 302 provenance reads for 150 products. GREEN: same regression now fewer than10 reads across both boundaries; full service+route focused suite37/37. Added 5000-member shared validator case proving a corrupt last-member version or duplicate is rejected even when checking the first member; shared binding+identity unit suites11/11. --filter @wukong/db build and --filter @wukong/web typecheck passed.

Composite FK coverage RED: --filter @wukong/db exec vitest run src/repositories/listings.integration.test.ts -t 'workspace-consistent composite foreign keys' showed exactly one additional relationship export_verifications(workspace_id,export_attempt_id)->export_attempts. Added that relationship to the exhaustive inventory. Initial scripted edit missed CRLF and had no effect; verified/reapplied. GREEN final entire listings.integration.test.ts23/23 (16.65s). Combined affected DB integration before that inventory correction had export-verifications9/9 and import-results11/11 GREEN (total42/43 with only the known FK inventory failure). The combined process completed in25.74s and pg_stat_activity was empty; no shutdown stall reproduced, no service/data cleanup performed.

Follow-up formatting and git diff --check passed. Dedicated follow-up commit; original implementation not amended.
