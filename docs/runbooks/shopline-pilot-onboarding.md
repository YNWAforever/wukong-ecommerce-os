# SHOPLINE pilot onboarding (Opak)

No production resource or credential is created by this runbook. Record the operator, date, API version, and approval ticket in the pilot change log.

## 1. Developer Center installation

1. In SHOPLINE Developer Center, create/select the app owned by the Wukong team.
2. Record the app ID, redirect URI, requested scopes, and the API version shown by the Developer Center. Keep the client secret in the approved secret manager, never in `.env`, Git, or a ticket comment.
3. Use the local/preview callback only for a synthetic workspace. Confirm the OAuth callback returns to the intended tenant and does not accept a caller-supplied workspace ID.

## 2. Merchant enablement

The merchant must separately enable the required OpenAPI product/catalog permissions in the Opak merchant admin. Developer Center installation does not grant merchant access. Have the merchant owner approve the scope list and store the approval reference.

Verify the connection with a read-only request before writing anything:

```powershell
$env:SHOPLINE_API_BASE_URL = "https://open.shopline.io/v1"
# Use the approved secret-manager injection for SHOPLINE_ACCESS_TOKEN.
curl.exe -i -X GET "$env:SHOPLINE_API_BASE_URL/shop/info" -H "Authorization: Bearer $env:SHOPLINE_ACCESS_TOKEN"
```

Record the HTTP status, API version, shop domain, and scopes. Do not log the bearer token or response fields containing customer data. A read-only failure is a stop condition; do not retry with a write scope.

## 3. Hidden test product and delivery

Before any API write, obtain explicit written approval from the Opak owner for a hidden/unpublished test product, its title, price, and deletion/rollback plan. The operator must approve the listing in Wukong; the server rejects CSV and API delivery before approval even if a button is enabled by mistake.

Use the deterministic CSV fallback when API access is not verified:

```powershell
curl.exe -i -X POST "http://localhost:3000/api/listings/<draft-uuid>/deliver" `
  -H "Content-Type: application/json" `
  --data '{"method":"csv"}'
```

Review the UTF-8/CRLF file and import it manually in SHOPLINE. For API delivery, use the recorded SHOPLINE contract version, retain only the remote product ID and payload digest, and confirm the product remains hidden. Never store raw access tokens in audit metadata.

## 4. Importing an existing catalog

Prerequisite: the workspace has a verified SHOPLINE connection.

1. In SHOPLINE admin, export the bulk update form for the catalog.
2. **Do not open the file in Excel before importing.** A re-save can retype the
   SKU column and strip the leading zeros that every Opak SKU carries.
3. Inspect the form before committing to it. This prints only aggregates — issue
   counts, content gaps, stock and margin totals — never product content:

   ```bash
   pnpm --filter @wukong/shopline bulk-form:profile <bulk-update-form.xlsx>
   ```

4. Prefer `/listings/import`: select the workbook, explicitly enter its SHOPLINE export time in Hong Kong UTC+08:00, then submit. The browser retains the file/time for a failed-request retry. For a direct request, URL-encode the original filename and actual merchant-attested export timestamp (never use upload time):

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/listings/import?filename=bulk-update-form.xlsx&merchantAttestedExportAt=<URL-encoded-ISO-timestamp>" \
     -H "Cookie: $WUKONG_SESSION_COOKIE" \
     -H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
     --data-binary @bulk-update-form.xlsx
   ```

   Requires the operator role. The response reports `parsedRows`,
   `createdDrafts`, `refreshedProducts`, and up to 100 parse issues.

5. A re-import refreshes the source snapshot without creating another draft for the same product. Source changes require renewed review confirmations and approval; re-importing alone cannot reuse the previous approved-source receipt.

Failure codes are deliberately distinct: `upload_not_a_workbook` (400) means the
bytes are not a readable xlsx, `bulk_form_unreadable` (422) means the workbook
parsed but held no product rows (a wrong file versus an empty catalog), and
`bulk_form_too_many_rows` (413) means the form exceeds the 5,000-product
per-import limit — split it and upload in batches.

The reader also refuses a workbook whose declared row or column references
exceed a spreadsheet's own limits, or whose compressed parts inflate beyond the
supported size. These bound an untrusted upload; no file a spreadsheet could
have produced is affected.

Imported drafts are **not** enqueued for AI processing. Creating 500 drafts must
not fire 500 uncapped AI runs, so enrichment is a separate budgeted batch.

## 5. Enriching an imported catalog

Enrichment costs real money proportional to catalog size, so it runs as an
explicitly budgeted batch rather than automatically at import.

1. Create a batch for one gap. `budgetUsd` is the ceiling for the whole batch;
   `waveSize` is how many products are released at a time.

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/enrichment-batches" \
     -H "Cookie: $WUKONG_SESSION_COOKIE" \
     -H "Content-Type: application/json" \
     -d '{"label":"zh names","gap":"untranslatedName","budgetUsd":5,"waveSize":25}'
   ```

   Valid gaps: `untranslatedName`, `untranslatedSeoTitle`, `seoTitleMirrorsName`,
   `seoDescriptionMirrorsSeoTitle`, `keywordsMirrorName`, `summaryMissing`.
   The response reports how many products were selected.

2. Release a wave:

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/enrichment-batches/<batch-id>/advance" \
     -H "Cookie: $WUKONG_SESSION_COOKIE"
   ```

   The response reports `enqueued`, `spentUsd`, `budgetUsd`, and `status`.
   Repeat once a wave has drained. `status: "completed"` means there is nothing
   left; `status: "budget_exhausted"` means the budget is spent and no further
   work will be released.

3. Enriched drafts land in the normal review queue as `in_review`. Nothing is
   written back to SHOPLINE by this flow.

**Budget is a stop condition between waves, not a hard ceiling within one.** A
wave already in flight can overshoot by at most the cost of that wave, so size
`waveSize` for the overshoot you are willing to accept. Spend is measured from
`ai_runs.estimated_cost_usd`, which is the actual recorded cost of each run.

## 6. Exporting enrichment back to SHOPLINE

For imported products use the catalog Bulk Update XLSX action. Review all eight field and seven negative confirmations, approve the exact version/source, select the intended listings and attest freshness for that selection. Retain the resulting export attempt reference even if detail loading fails; retry detail loading without generating another artifact. Download only the ready artifact and retain its exact bytes and SHA-256 privately.

Export requires approved/published status, no open blocking flags, matching immutable approved-source evidence and current header contract. Missing or stale evidence fails closed. Re-import current merchant data and renew review/approval when the source changes. Attestation cannot independently detect later merchant-side price, stock or logistics changes.

Single-listing direct delivery remains available with body `{"method":"bulk_form","freshnessAttested":true}`, but the operator UI uses stable multi-export attempts for reconciliation. Create CSV and direct API capabilities remain separate from this existing-product pilot.

Before an authorized manual SHOPLINE import, independently compare all 71 fields and preserve the pre-change source as described in [Opak UAT rollout](./opak-uat-rollout.md). The output is a normalized string workbook, not an exact typed-cell or byte copy. Blank deltas remain blank; nonblank deltas become +0. Merchant acceptance of these representations and actual stock neutrality require authorized re-import/fresh-export UAT. Do not open and re-save the workbook in Excel.

## 7. Recording a SHOPLINE import result

Use the attempt detail in /jobs to report each included member against its exported version. The equivalent POST /api/listings/<draft-uuid>/shopline-import-result body is:

```json
{
  "mode": "export",
  "outcome": "accepted",
  "exportAttemptId": "<export-attempt-uuid>",
  "versionId": "<exported-version-uuid>",
  "idempotencyKey": "<stable-key-for-this-report>"
}
```

Requires operator access. A rejected outcome must include rejectReason; accepted outcomes omit it. Reuse the same idempotency key for an unchanged retry. Corrections use a new key and include supersedesResultId (the observed preceding receipt) and correctionReason. Reports append instead of replacing history, and rejection/correction explanations remain visible after reload.

Historical entries use mode historical_manual and omit exportAttemptId/versionId; they remain explicitly unlinked and cannot reconcile an attempt. /jobs derives accepted/rejected/unreported totals from included members. All reports remain operator assertions, independently unverified against SHOPLINE. A fresh-export comparison records normalized evidence from a supplied snapshot; its store and export time remain operator-attested, and it does not independently establish live merchant state.

## 8. Approving many listings at once

The work queue selects fully confirmed in_review listings without open blocking flags, at most 50 distinct listings per batch. Selection captures the observed version, confirmation revision and applicable source identity/digest; legacy ID-only approval requests are rejected. Each item has its own transaction, so a conflict does not block unrelated approvals.

Failures retain their original review context across reloads. Review and explicitly reselect to adopt new context; only successful items clear automatically. Approval remains whole-listing and does not apply content to SHOPLINE.

## 9. Workspace admin area

The `/admin` page (visible to `admin` and `owner` roles only) replaces three
manual steps this runbook used to require: inviting a teammate, connecting or
rotating the SHOPLINE credential, and setting the brand background color.

**Inviting a teammate.** From the Members tab, enter their email, pick a role
(`viewer`, `operator`, `reviewer`, or `admin` — `owner` is not assignable
here), and submit. This creates a pending invite and immediately sends the
teammate a real enrollment email; setting a password on that email's link
is what completes enrollment — no link needs to be shared manually. Revoke
a pending invite from the same tab if it's no longer needed, and re-inviting
the same email resends the email if the original was lost.

**Connecting or rotating the SHOPLINE credential.** From the Connection tab,
enter the shop domain and access token once to connect a workspace that has
none, or click "Rotate token" and submit a new token to replace an existing
connection's credential — no manual DB write required. The token is encrypted
at rest with the same token-vault used elsewhere in this repo, and the API
never returns it; the panel only ever shows the shop domain and the
connection date.

**Changing the brand background color.** From the Settings tab, pick a color
and save. It takes effect immediately for the workspace's branding — no
deploy or code change required.

## 10. Re-delivering a published listing via SHOPLINE API

When a reviewer delivers a listing via `shopline_api` and that listing already
has a known remote product, delivery now calls `updateProduct` against that
same remote product instead of creating a duplicate. This applies whether the
link came from a catalog import or from an earlier `shopline_api` delivery
that Wukong made itself — either origin is enough to be recognized as an
existing product.

The delivery panel shows which action will happen — create or update — before
the reviewer confirms, so there is no need to inspect `platform_products` by
hand to know what a click will do.

No operator action changes: request delivery via `shopline_api` exactly as
before. The create-vs-update decision is made automatically from the listing's
recorded remote-product link, both when the request is made and again by the
worker immediately before it calls SHOPLINE.

### Fresh-export comparison

For a ready attempt, a reviewer/admin/owner can open its separate comparison panel, select a later SHOPLINE workbook, enter its Hong Kong export time and attest the same store. The timestamp must be after artifact readiness and no later than the current time. Retry with the same file, timestamp and attestation after a network failure; identical evidence returns the original record.

Review intended-content and protected-field differences, missing or ambiguous products, and quantity instruction observations separately. History is paged; select a record to inspect its full normalized evidence. Comparisons do not change operator accepted/rejected totals or their unverified status. A match means only that the compared normalized fields match the supplied snapshot.

The system retains the supplied digest and normalized relevant rows, not the original supplied XLSX bytes. Retain authorized original workbooks in the approved private evidence location. This feature requires the reviewed code and migration 0018 to be deployed through a separately authorized rollout; local synthetic verification does not authorize that rollout.

### Download an attempt evidence packet

Open the exact comparison to review, preview its evidence packet, then download the JSON attachment. Review the selected comparison ID, receipt and member counts, and as-of time. A newer comparison is not chosen automatically. If receipts changed after preview, refresh and review the new summary before downloading. Unavailable requests can be retried while retaining the selection.

The packet includes the selected normalized comparison and applicable operator receipt revisions, with explicit unreported members. It is bounded to 3 MiB and 1,000 receipt revisions; oversized evidence is refused. To check integrity, canonicalize the parsed payload using the declared sorted-json-v1 rules and compare its UTF-8 SHA-256 with payloadSha256. The hash detects payload changes; it is not an authenticated merchant signature.

Retain the downloaded packet only in the approved private evidence location. It does not contain original supplied XLSX bytes, replace required merchant evidence, advance a UAT stage, or authorize a write. Store/time are operator-attested and reports remain independently unverified. A download audit records response preparation, not receipt by the reviewer. Use requires a separately authorized rollout of the reviewed code; this phase adds no migration.

### Store setup on the import page

On `/listings/import`, use the store-status card before submitting a workbook. An admin/owner can choose **Set up store**, enter the store domain and access token in the inline form, and connect without navigating away. The selected workbook and Hong Kong export time remain in place. Use **Refresh status** if another administrator connected the store.

If you lack administrator access, the card explains who must complete setup. If credential storage is unavailable, ask the system administrator to configure the server before entering a token. The form does not offer tokenless registration, and connecting a store does not enable SHOPLINE writes. Existing connected stores can still import spreadsheets when credential storage is unavailable because this operation does not decrypt the token.
