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

Two failure codes are deliberately distinct: `upload_not_a_workbook` (400) means
the bytes are not a readable xlsx, while `bulk_form_unreadable` (422) means the
workbook parsed but held no product rows — a wrong file versus an empty catalog.

Imported drafts are **not** enqueued for AI processing. Creating 500 drafts must
not fire 500 uncapped AI runs, so enrichment is a separate budgeted batch.
