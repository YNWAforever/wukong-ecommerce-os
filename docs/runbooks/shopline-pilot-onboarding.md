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
