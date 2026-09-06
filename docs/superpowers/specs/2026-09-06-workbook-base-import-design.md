# Workbook base import with minimal input

Status: approved and implemented locally on 2026-09-06, with synthetic test verification and independent source review. See the implementation results report for exact checks and source-binding limits. Production migration and rollout are not included.

Verified source baseline: GitHub main and the active checkout both at 49e84a3b21c9d384dd5b6f1019441322931fbb48 on 2026-09-06.

## Outcome

A workspace operator selects a supported SHOPLINE Bulk Update XLSX, immediately sees a preview, and clicks Import products to create a Wukong base catalog. This path needs no SHOPLINE account, connection, token, store URL, manually entered export date, catalog name, or column mapping.

The first slice supports the existing recognized SHOPLINE workbook contract, its 4 MiB upload limit and 5,000 parsed-row limit. This is a workbook import, not the website scanner's 20-product limit. A paginated preview may show a sample, but must clearly state the total eligible products and the number that will be imported.

## Evidence for the current blocker

- BulkImportPanel retains the selected file but waits for a separate submit. Its importReady flag comes from ImportStoreSetupPanel, which requires a connection and operator capability.
- The current workbook route requires merchantAttestedExportAt before parsing.
- createBulkFormImporter also rejects a missing SHOPLINE connection. Current source-import records require both that connection and an attested export time.
- Read-only production investigation found zero connections in the reported workspace and no corresponding XLSX import request in the inspected logs. The selected-filename message is not an upload receipt.
- The existing setup-panel and importer suites passed 26 tests and reproduce these enforced requirements. They do not demonstrate the requested credential-free flow.

## Chosen journey

1. Show one prominent XLSX drop zone and Choose file button. Keep the Workbook tab accessible; do not show SHOPLINE setup or an export-time input in this base-import path.
2. Selecting a file automatically starts validation and preview. Show Reading workbook progress, then product names, available prices, source product IDs/SKUs, total counts, and actionable row issues. Automatically map only the supported header contract.
3. Show Import N products as the primary action, with all eligible products included by default. Optional exclusions must not require selecting every row individually. Mark blocking rows and explain what needs correction in the file; never silently invent required values or silently drop rows.
4. The Import click is the only catalog-write confirmation. Report imported, already imported, and excluded counts, and provide View catalog. A filename-only message must never be the final visible state after successful preview.
5. Keep the file and successful preview after a recoverable error. Ignore stale responses after file replacement. Disable duplicate submits and make retries idempotent. Auth/role failures explain the required access without losing the file unnecessarily.

## Automatic metadata

Record original filename, sheet name, exact file digest, normalized header contract, original row evidence, row counts, uploader and server import time automatically.

Recognize a strictly validated filename timestamp where available. For the supplied filename, the candidate is 2026-05-21 15:50. Display it only in source details as inferred from filename. A filename timestamp without an explicit timezone remains a local timestamp with unknown timezone; do not silently convert it into a verified UTC export instant.

A renamed file or one without a readable date remains importable and records export date unknown. Workbook creation/modification times, browser File.lastModified and server upload time are not evidence of the SHOPLINE export time. Only add workbook-metadata extraction if the supported format identifies an actual export-time field; do not treat generic document properties as such a field.

Do not populate merchantAttestedExportAt from inferred metadata or set any freshness-attestation boolean automatically. Keep inferred source dates, server import time and any genuine historical merchant attestations distinct. None of this requires another input from the importing user.

## Source identity and persistence

Create a workspace-scoped workbook source and base-catalog records without fabricating a SHOPLINE connection. Preserve product and variant IDs from the sheet as source identifiers; they do not, by themselves, establish the owning store or an authorized remote-product link. A filename-derived source label is display metadata only.

Reuse the existing deterministic workbook parser and header/row preservation rules. Select the declared Default worksheet through its internal workbook relationship, keeping parsed rows and the recorded sheet name bound together; reject missing or ambiguous Default sheets instead of falling back to ZIP numbering. Keep immutable imported evidence separate from any later working edits. New base records must be visible in the catalog with a Workbook source badge and usable detail view; preview-only records do not satisfy this design.

Use the exact workbook digest and workspace identity for repeated-file deduplication. A retry or re-upload of identical bytes returns the existing import result. Scope row identity to its workbook source and preserve variants. A changed workbook must not overwrite a different source, a reviewed listing or a website record by matching only filename, title, SKU or a remote ID with unknown store identity. Reconciliation across changed sources is a separate explicit operation and not a prerequisite for the first base import.

Keep the existing connected SHOPLINE import and its historical source records compatible. Choose the smallest additive source/persistence design during implementation planning; do not loosen current non-null connection constraints or insert placeholder tokens simply to bypass them.

## Review and export boundaries

Omitting a date is allowed for importing a catalog into Wukong. It does not prove freshness, ownership or permission to publish. Preserve existing approval receipts, immutable source binding and human export-freshness checks. Base-workbook records must not acquire export or publication eligibility merely by being imported or by inferring a date. Enforce this at the service/API boundary as well as in the UI.

No automatic AI enrichment, SHOPLINE writes, website crawl, remote image download or paid provider call is triggered by file selection or import. Existing unrelated runtime behavior stays intact.

## Alternatives considered

- Recommended: automatic preview followed by one Import action. Requires no typed fields and lets the operator see validation issues before creating catalog records.
- Immediate import on file selection: one fewer click, but a mistaken file immediately creates records. Retain the explicit Import action.
- Date autofill followed by confirmation: easier than manual typing but still imposes a redundant step and risks conflating inference with attestation. Keep date inference as optional source metadata instead.

## Verification and release scope

Use only synthetic workbooks and isolated services for tests. Cover recognized/renamed/missing-date/malformed-date workbooks; no connection or encryption key; role and workspace isolation; automatic preview; all-eligible default import; repeated-file idempotency; variant/row preservation; stale responses; retries; actionable invalid/oversized/unsupported file errors; catalog visibility; and server-side rejection of unsupported export/publication attempts. Existing connected-import and source-bound review/export regression checks must remain green.

Do not upload the supplied merchant workbook for tests. No production migration, deployment, provider activation or merchant-data seeding is included in this design approval. Present any required additive migration and rollout separately after source verification.
