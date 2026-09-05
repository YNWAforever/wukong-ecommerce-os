# Domain Context

## Shopline delivery

Shopline delivery is the listing decision that determines whether a specific
listing version may be delivered through `shopline_api` or CSV. The decision
uses one workspace-scoped view of the listing, active version, review flags,
connection metadata, and current publish job.

The decision is bound to the exact active-version ID and content digest. The
worker re-evaluates the same decision after queueing. An unavailable Shopline
connection produces an explicit CSV fallback; delivery never switches methods
silently.

## Shopline bulk form

The Shopline bulk form is the 71-column round-trip artifact for a catalog that
already exists on Shopline: export, edit cells, re-import keyed by `Product ID
(DO NOT EDIT)`. It is a different artifact from the 15-column create CSV, which
pushes new products out and carries descriptions and images.

The bulk form is how Wukong reads existing platform listings in and writes
enrichment back. Reading it is a total function over a cell matrix that reports
issues instead of throwing. Writing it is a diff: only the eight enrichable
content columns may change, the ten `DO NOT EDIT` columns are echoed verbatim,
and stock delta columns retain blank values while nonblank values are reset to
`+0`. Merchant acceptance of blank versus `+0` remains an authorized re-import
UAT decision. This is normalized string-grid preservation, not preservation of
original XLSX bytes, numeric cell types, styles or whitespace-only cells.

Export writes back only through a listing's `platform_products` link — the
join the importer records between a listing and the remote product it came
from. A listing with no such link has no known remote product ID, so there is
no bulk-form row to update; it is not a bulk-form case at all. Every
non-enriched column in an exported row is exactly what the last import saw,
not SHOPLINE's current state, so a merchant-side change since import is
silently reverted on re-upload unless the catalog is re-imported first.

`platform_products` is no longer an import-only mirror: it is the one place
any listing's known SHOPLINE remote-product link lives. A row's `origin` is
either `import` (written by the bulk-form importer) or `created` (written the
first time a `shopline_api` delivery successfully creates a remote product for
a listing that had no prior link). Either origin means the listing has a known
remote product, so a later `shopline_api` delivery calls `updateProduct`
against it instead of creating a duplicate. Only `import`-origin rows carry a
SKU, spec version, raw row, and content digest — a `created`-origin row has
none of that, since there was no imported sheet to derive it from.

## Bulk import browser contract

/listings/import retains the selected workbook until a separate submit. Operators
must explicitly enter SHOPLINE export time in Hong Kong UTC+08:00; the browser
converts it to an ISO UTC instant and sends merchantAttestedExportAt plus the
exact filename in URLSearchParams, with the raw workbook body. No timestamp is
inferred from upload time or file metadata. Validation/API/network failures
preserve file and time for retry; an in-flight guard prevents duplicate submits.
Native fetch is invoked without the dependency object as its receiver.
/listings/new remains the separate create-intake route. This attestation does
not verify merchant-side freshness or replace source-bound approval eligibility.

## Bulk approve

Bulk approve selects fully confirmed in_review listings with no open blocking
flags. The queue captures each item's observed version, confirmation revision
and imported source ID/digest at selection. It submits {items: [...]}; legacy
ID-only requests receive 400 review_context_required. Batches are limited to
50 distinct UUIDs, including case-insensitive duplicate rejection.

Both approval routes use the shared service's mandatory version, complete
checklist, revision and applicable source checks. Imported source must match
both the current platform link and confirmation ledger. A lost/overwritten
import origin cannot erase an existing request or ledger source binding.
Single approval retains its early checks before optional product-shot I/O.

Each item has its own workspace transaction, preserving valid approvals when
another item fails. Failed selections retain their original review context
across reloads; only successes clear automatically. Explicit reselection can
adopt newly reviewed context. Approval remains whole-listing, all-or-nothing.
Approval and Bulk Update eligibility acquire the listing draft lock. Database
triggers serialize platform source, confirmation and compliance flag changes
with that lock. Imported approval appends a receipt bound to the immutable
source row, exact approved version and reviewed checklist revision. A product-shot
promotion may inherit the reviewed predecessor checklist only until the promoted
version receives a checklist of its own; that requires renewed approval.

## Bulk Update source and artifact history

Each import preserves every parsed row in source_row_snapshots before updating
the current platform mirror. Old imports and their approved receipts remain
immutable to the runtime role. Missing historical source or approval evidence
fails closed; reimport and renewed approval are required. Reconfirming a new
source alone cannot reuse a previous approval. Receipt insertion order uses a
database identity ordinal rather than transaction timestamps.

Multi-export builds from the approved immutable rows, verifies their full row
hashes and uses canonical listing order. Its versioned provenance and workbook
SHA-256 determine the attempt identity. Attempts start pending and become ready
only after conditional object creation/read-back and hash verification. Failed
uploads remain failed or pending if the state database is unavailable; matching
retries recover identical bytes without overwriting existing objects. New
downloads require readiness and matching bytes. Legacy all-null provenance rows
remain historical downloads explicitly marked incomplete.

Single Bulk Update delivery uses the same durable eligibility rules but retains
its direct workbook response. The operator UI now uses stable multi-export
attempt references for Bulk Update delivery and result reconciliation. Generated XLSX is not proof of SHOPLINE acceptance
or of current merchant-side protected fields.

## Workspace roles

A workspace membership has one of five ranked roles: `viewer` < `operator` <
`reviewer` < `admin` < `owner`, enforced by
`apps/web/lib/session-context.ts`'s `roleOrder` and, at the database layer,
by CHECK constraints on `memberships.role` and `workspace_invites.role`.
`owner` is a bootstrap-only role — it is assigned once per workspace outside
of any UI, and no route in the admin area can grant it, change a member into
it, or change an `owner` member's role away from it; it is simply not one of
the roles the invite and role-change routes accept.

The rule that a workspace can never end up with zero `admin`-or-`owner`
memberships, and that an admin can never change or remove their own
membership, is enforced in the `memberships` repository itself
(`packages/db/src/repositories/memberships.ts`'s `updateRole`/`remove`,
via `MembershipGuardViolation`) — not only at the
`apps/web/app/api/workspace/members/[userId]/route.ts` route layer — so the
guarantee holds for any caller of the repository, not just the current UI.

## Bulk Update export eligibility

Single-listing bulk-form delivery and multi-product export share the same
eligibility policy and workbook builder. They require an approved/published
active version, no open blocking flags, all eight field and seven negative
confirmations for that listing/version, an import-origin remote link, matching
confirmation/source metadata, explicit freshness attestation and the current
header contract. Create CSV/API delivery keeps its separate policy.

Export prepares request-local evidence and rechecks version, confirmation
revision, flags and source/link identity at the final audit/attempt boundary.
An all-excluded or all-no-op multi-export returns a manifest with rowCount 0
and exportAttemptId null; it creates no object or successful export event.
Single bulk_form requests must explicitly send freshnessAttested: true.

Durable approved-source receipts and pending/ready/failed artifact records
now enforce source/approval binding, verified workbook hashes and retry identity;
see Bulk Update source and artifact history above. Object-store publication is
verified through the recoverable artifact lifecycle, not an atomic cross-store
transaction. Merchant-side freshness and SHOPLINE acceptance remain unverified.

## Bulk Update result reconciliation

Catalog reviewers select imported listings and attest freshness for that exact selection. The UI generates through the shared multi-export API, retains the attempt reference across detail-loading failures and downloads only ready artifacts. Imported listings expose Bulk Update XLSX; Create CSV and API controls follow their separate origin capabilities.

Operator reports bind to included manifest members and the exact exported version, rather than a later active version. Idempotency keys protect retries; corrections append against the observed predecessor. Jobs derives accepted/rejected/unreported totals from included members and complete relevant report history. Rejection and correction reasons remain visible after reload. All reports remain independently unverified against a fresh SHOPLINE export.

Historical/manual entry is explicitly unlinked and cannot close attempt reconciliation. Its per-listing revision history is durable; legacy reports are never promoted into trusted export receipts. Migration 0017 preserves append-only reports and is replay-safe, including protection during earlier privilege regrants. It has only been rehearsed in disposable local databases.

Task 5 verification: docs/superpowers/plans/2026-09-05-result-reconciliation-verification.md. Subsequent local Tasks 6/7 are described below; production migration and deployment remain unauthorized.

## Workbook fidelity and catalog usability (local Tasks 6/7)

Independent synthetic output comparison covers all 71 Bulk Update columns. Nonblank extra headers are refused; normalized blank stock deltas remain blank and nonblank deltas become +0. Raw Excel types/styles are not preserved, and merchant acceptance of neutral blanks is unverified. Runbooks retain exact source/artifact/digests and require current protected-field comparison plus authorization before restoration.

Catalog/listing/Jobs reads have workspace-scoped counts and deterministic pagination; quality gaps scan all active versions in bounded batches with an observed interval. Source-readiness views use server evidence but never attest freshness or independently verify SHOPLINE acceptance. Read recovery preserves filters, observed selections and imperative refresh failures. The existing locale cookie drives affected pages/forms, HK formatting and keyboard-accessible shell/table behavior. Capability labels describe implementation maturity separately from operational verification.

GET /api/quality adds retained-evidence reviewMetrics: version-cohort approval fraction, creation-to-first-approval elapsed time and qualified complete-content edit field-change fraction. Missing or over-limit edit evidence is explicitly unavailable; these are not model-quality or reviewer-effort metrics. See docs/superpowers/plans/2026-09-05-review-quality-metric-contract.md and docs/superpowers/plans/2026-09-05-fidelity-usability-verification.md for exact populations, limits and synthetic checks. No production migration, provider calls or SHOPLINE writes were authorized.

## Fresh-export comparison evidence

Ready Bulk Update attempts with complete provenance can retain a comparison with a later supplied Default-sheet workbook. The authenticated reviewer/admin/owner explicitly attests the same store and export time; the time must follow artifact readiness and cannot be in the future. The server verifies the exact delivered artifact digest and every included version binding again when recording. No source import, approval, operator report or publish state changes.

Products match by exact product ID. Eight intended content fields and 61 protected fields are compared as normalized strings; two quantity-delta instruction fields remain separate observations. Missing, duplicate or variant target products are inconclusive. Protected-field differences do not establish causation, stock neutrality or authenticated live SHOPLINE acceptance. Operator report totals and their unverified status retain their existing meaning.

Migration 0018 adds append-only, workspace-scoped evidence and transactional audit records. Identical evidence retries retain the first record; different snapshots append. History returns bounded summaries with exact totals, and full evidence is loaded by workspace and attempt. Uploads are limited to 4 MiB and 5,000 rows; the complete retained evidence envelope is limited to 2 MiB, with explicit rejection rather than truncation. The supplied workbook digest and normalized relevant rows are retained, but original supplied XLSX bytes, types and styles are not. Store and export time remain operator-attested.

This phase is local synthetic development only. Migration 0018 has not been authorized or applied to production, and no deployment or merchant write is implied. Verification is recorded in docs/superpowers/plans/2026-09-05-fresh-export-verification-results.md.

## Attempt evidence packets

A reviewer/admin/owner selects an exact retained comparison for a ready export, previews its evidence summary, then downloads canonical JSON. The packet combines the manifest, artifact digest, included source/version/approval references, complete applicable operator receipt chains, explicit unreported members and the selected normalized comparison. It never substitutes the latest comparison or changes report/comparison state.

Attempt, comparison and receipts are read in one database statement with an as-of timestamp. The delivered artifact bytes are checked against its digest. Preview snapshotSha256 excludes only asOf; changed evidence requires a new preview before download. The downloaded envelope contains payload and payloadSha256; sorted-json-v1 sorts object keys and preserves deterministic array order. Payload SHA-256 includes asOf. Complete packets are capped at 3 MiB and 1,000 receipt revisions; excess is refused, never truncated. A content-free download audit means a response was prepared, not proof of client receipt. No new schema or evidence storage is added.

Packets are supplied-snapshot review evidence, not UAT sign-off or merchant-write authorization. Store/time remain operator-attested; original supplied XLSX bytes are not retained or revalidated. Normalized cells and delta observations do not establish live SHOPLINE state, causality or stock neutrality. This phase is local synthetic development, stacked on 88c3b0b. Exact checks are recorded in docs/superpowers/plans/2026-09-05-attempt-evidence-packet-results.md.

## Inline store setup during catalog import

The import page shows a store-status card above file selection. Signed-in workspace members can see the connected domain; admin/owner users can open the existing connection form inline when credential storage is configured. Other roles see guidance to ask an administrator. Missing or invalid credential-storage configuration is shown before token entry.

The setup summary is read-only, workspace-scoped and not cached. It exposes no token or encryption key. Connection creation/rotation retain the existing admin authorization and audit boundary. Unknown or missing store status prevents sending the workbook, while file selection and the entered export time stay mounted during setup and refresh. A connected store does not require token decryption for spreadsheet import; the operator permission and existing server import checks still apply.
