# Pilot lead intake

Status: runtime endpoint shipped; the marketing site still has to call it before
its form may show success. Until that wiring is deployed and verified, the
marketing site keeps the mailto/contact fallback from
`docs/product/2026-11-18-marketing-alignment.md`.

## What the endpoint owns

`POST /api/pilot-leads` is the only public write surface outside authentication.
It persists a sales lead and returns a receipt. It does not create a workspace,
send an email, call a model, enqueue a job, or accept product files.

The record is internal sales intake, not tenant data: it has no `workspace_id`,
is not reachable from `forWorkspace`, and is not readable through any merchant
API. Internal operators read it at `/ops/pilot-leads`; the SQL below is the
fallback.

## Request

`Content-Type: application/json`. Unknown fields are rejected.

| Field            | Required  | Rules                                                                              |
| ---------------- | --------- | ---------------------------------------------------------------------------------- |
| `name`           | yes       | Trimmed, 1–120 characters                                                          |
| `email`          | yes       | Valid address, ≤254 characters; stored lower-case                                  |
| `company`        | yes       | Trimmed, 1–160 characters                                                          |
| `platforms`      | no        | Up to 6 unique values from `shopline`, `shopify`, `carousell`, `hktvmall`, `other` |
| `skuVolume`      | no        | `under_100`, `100_500`, `500_2000`, `over_2000`                                    |
| `message`        | no        | Trimmed, ≤2,000 characters; not for product data or credentials                    |
| `locale`         | no        | `en` (default) or `zh-Hant`                                                        |
| `source`         | no        | Lower-case campaign slug, 1–80 characters; default `marketing`                     |
| `consent`        | yes       | Must be `true`; the server records `consent_at`                                    |
| `turnstileToken` | see below | Required when `PILOT_LEAD_TURNSTILE_SECRET` is set                                 |
| `website`        | no        | Honeypot; must be empty or the request is rejected                                 |

```json
{
  "name": "Ada Merchant",
  "email": "ada@example.com",
  "company": "Example Cellar",
  "platforms": ["shopline"],
  "skuVolume": "100_500",
  "message": "We need a bilingual catalog review.",
  "locale": "en",
  "source": "wukong-ops-suite",
  "consent": true,
  "turnstileToken": "..."
}
```

Success is `201 {"ok":true,"id":"<uuid>","receivedAt":"<ISO-8601>"}`. The
response never echoes the email or message.

| Status  | Meaning                                                                               |
| ------- | ------------------------------------------------------------------------------------- |
| 201     | Persisted                                                                             |
| 400     | Invalid body, filled honeypot, or malformed JSON                                      |
| 403     | Turnstile failed or is missing while configured                                       |
| 413     | Body larger than 16 KiB                                                               |
| 429     | More than three submissions in ten minutes by email or request IP; `Retry-After: 600` |
| 500/503 | Intake unavailable; keep the form retryable and do not show success                   |

The endpoint is not idempotent. A resubmission inside the window is rate-limited
rather than creating a second lead, so the marketing form needs a retryable
error state, not an automatic repeat that will be throttled.

## Anti-abuse and privacy

- Honeypot `website` is validated server-side.
- Rolling limit: 3 submissions per 10 minutes for the same email **or** the same
  hashed request IP. The advisory lock makes concurrent submissions for one
  email race-safe.
- `PILOT_LEAD_ALLOWED_ORIGINS` is an exact-match allowlist for browser CORS;
  HTTPS only, except `http://localhost` development origins. Empty means a
  browser on another origin cannot read the response.
- `PILOT_LEAD_IP_SALT` enables pseudonymous IP rate limiting. Without it the
  endpoint stores no IP and limits only by email.
- Set `PILOT_LEAD_TURNSTILE_SECRET` before the public form goes live. The
  marketing widget sends its one-time token; the route calls Cloudflare
  `siteverify` and fails closed if the verifier is unavailable. Never expose the
  secret to the browser.
- Only the fields above are stored. Do not add phone, address, product files,
  screenshots, credentials or customer records without updating the privacy
  notice, this runbook and the schema constraints.
- Do not log the form body or response; route diagnostics already report only a
  request id and error class.
- Retention and deletion are operator actions, not automatic. Agree the period
  in the privacy notice before launch. Inspect and delete with an admin
  connection:

```sql
select id, created_at, name, email, company, platforms, sku_volume, locale,
       source, consent_at
  from pilot_leads
 order by created_at desc
 limit 50;

delete from pilot_leads where created_at < now() - interval '12 months';
```

The retention interval above is an example, not a published policy.

## Configuration

| Variable                      | Where  | Required       | Purpose                                        |
| ----------------------------- | ------ | -------------- | ---------------------------------------------- |
| `PILOT_LEAD_ALLOWED_ORIGINS`  | Vercel | no             | Exact browser origins allowed to POST          |
| `PILOT_LEAD_IP_SALT`          | Vercel | no             | Salt for the IP hash used by the rolling limit |
| `PILOT_LEAD_TURNSTILE_SECRET` | Vercel | before launch  | Cloudflare Turnstile server secret             |
| `OPS_LEAD_EMAILS`             | Vercel | to use console | Exact signed-in emails allowed to read         |

Names only are listed in `.env.example` and the runtime manifest. Apply migration
`0058_pilot_leads.sql` through the normal controlled migration process; do not
run it from the Vercel app.

## Operator access

`/ops/pilot-leads` is a read-only console showing the latest 100 requests. It is
outside the merchant app shell and does not use workspace roles: a tenant owner
can never see another merchant's sales lead through its admin area.

- Set `OPS_LEAD_EMAILS` to a comma-separated exact list of staff emails on the
  server (Vercel). Absent or empty denies everyone.
- Operators need a signed-in Better Auth account. The current sign-in flow
  requires at least one workspace membership, so invite internal staff to a
  dedicated, otherwise-empty internal workspace — never a merchant workspace.
  The console itself ignores the selected workspace, its role and its data.
- The email is taken from the resolved Better Auth session, never from the URL
  or request body. Non-allowlisted signed-in users get `404`, not a redirect that
  reveals the page.
- The page is `noindex`, `force-dynamic`, and logs only a view event with the row
  count; it never logs a lead's fields.
- Remove an email from the env and redeploy to revoke access. Rotate staff
  accounts through the normal auth flow.
- If the page is unavailable, use the admin SQL in the anti-abuse section.

The page is not an approval or CRM workflow: it does not change lead status,
send email or create workspaces.

## Marketing handoff

The marketing app is `wukong-ops-suite`; this runtime remains the system of
record. For a browser form:

1. Add the Turnstile widget with the public site key and read its token.
2. POST JSON to `https://<runtime-origin>/api/pilot-leads` with
   `include` credentials off and `content-type: application/json`.
3. Show success only for `201`; map `429` to a retry-later message and any other
   failure to a retry/contact fallback. Do not show a fake success.
4. Add the production marketing origin to `PILOT_LEAD_ALLOWED_ORIGINS` and
   redeploy the web app.

If the marketing app has a server runtime, proxy from there instead: CORS does
not apply, and the Turnstile secret can stay in the runtime only.

## Verification

```bash
curl -i -X POST "$WEB_ORIGIN/api/pilot-leads" \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.test","company":"Example","consent":true,"source":"local-check"}'
```

Expected: `201`, then one row in `pilot_leads`. Unit coverage is
`apps/web/app/api/pilot-leads/route.test.ts`; the Postgres/replay/rate-limit path
is `route.integration.test.ts`; operator access is covered by
`apps/web/lib/ops-access.test.ts` and
`apps/web/app/ops/pilot-leads/page.test.tsx`.
