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

4. Upload it:

   ```bash
   curl -X POST "$WUKONG_BASE_URL/api/listings/import" \
     -H "Cookie: $WUKONG_SESSION_COOKIE" \
     -H "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
     --data-binary @bulk-update-form.xlsx
   ```

   Requires the operator role. The response reports `parsedRows`,
   `createdDrafts`, `refreshedProducts`, and up to 100 parse issues.

5. Re-running the same file is safe. A product already imported keeps its
   existing draft and only refreshes its row snapshot; `refreshedProducts`
   counts the ones whose content actually changed since the last import.

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

Once an enriched draft is approved, export it as a bulk update form and
re-import that file into SHOPLINE by hand — the same download-then-upload
shape as CSV delivery, using the same route:

```bash
curl -X POST "$WUKONG_BASE_URL/api/listings/<draft-uuid>/deliver" \
  -H "Cookie: $WUKONG_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"method":"bulk_form"}' \
  -o export.xlsx
```

This only applies to a listing imported from an existing SHOPLINE product —
one with a linked `platform_products` row. A listing authored fresh in
Wukong has no known remote product ID, so there is nothing for a bulk-form
row to update; use `shopline_api` or `csv` for those, unchanged. Requesting
`bulk_form` for an unlinked listing returns `409 no_remote_link`.

Requires the listing to be `approved` (or `published`), the same review gate
CSV and API delivery already enforce.

**Re-import the catalog immediately before exporting.** The exported file
carries every non-enriched column exactly as it stood at the listing's last
import — price, stock, everything except the eight fields Wukong enriched.
If the merchant changed a price or stock level directly in SHOPLINE since
that import, uploading this export will silently revert it. This is not
validated or warned about automatically; re-importing right before exporting
is the operator's responsibility for now.

## 7. Approving many listings at once

From the dashboard's work queue, an `in_review` listing with no open blocking
compliance flags can be selected via its checkbox. "Select all eligible"
selects every flag-free `in_review` listing currently loaded, up to 50 at a
time — the API refuses more than 50 IDs in one request. Selecting more than
50 requires approving in batches.

Approving a selection calls the same single-listing approval logic once per
listing, sequentially, each in its own transaction. A listing whose flags
changed since the queue last loaded (for example, a compliance re-scan
opened a new flag between page load and clicking approve) fails on its own
without blocking the rest of the batch — the result list shows exactly which
listings succeeded and which didn't, and why.

Nothing about single-listing review changes: this is a faster way to approve
many already-eligible listings, not a new kind of approval.

## 8. Workspace admin area

The `/admin` page (visible to `admin` and `owner` roles only) replaces three
manual steps this runbook used to require: inviting a teammate, connecting or
rotating the SHOPLINE credential, and setting the brand background color.

**Inviting a teammate.** From the Members tab, enter their email, pick a role
(`viewer`, `operator`, `reviewer`, or `admin` — `owner` is not assignable
here), and submit. This creates a pending invite row; Wukong does not send an
invitation email itself. Share the app's `/register` URL with the teammate
manually (Slack, a ticket comment, etc.) and have them submit the exact email
address that was invited there — the register flow checks it against the
pending invite and, if eligible, sends them an enrollment email; setting a
password on that email's link is what actually completes enrollment. Revoke
a pending invite from the same tab if it's no longer needed.

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
