# Conversation Studio runbook

Status: pilot operations guide for the Conversation Studio implementation on branch
`claude/conversation-studio`. Everything here is local/preview guidance; production activation,
deployment, live provider calls and external MCP connections remain separate explicit approvals.
Design: `docs/superpowers/specs/2026-11-08-conversation-studio-design.md`. Plan and results:
`docs/superpowers/plans/2026-11-08-conversation-studio.md`, `...-results.md`.

## Surfaces

| Route                         | Access                                            | Purpose                                                      |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `/studio`                     | any member, when enabled                          | conversation home, deterministic records overview, templates |
| `/studio/t/[threadId]`        | any member (private threads: creator/admin/owner) | thread, trace, evidence, review/output cards                 |
| `/studio/threads`             | any member                                        | thread list/search                                           |
| `/studio/outputs`             | any member                                        | versioned artifacts, review and sign-off                     |
| `/studio/connections`         | any member                                        | honest tool/MCP availability catalogue                       |
| `/studio/settings`            | admin/owner                                       | tokens, external MCP registry, read-only workspace state     |
| `/api/mcp`                    | workspace bearer token                            | hosted MCP server (read/propose tools only)                  |
| `/api/studio/tokens`          | admin                                             | hosted MCP token lifecycle                                   |
| `/api/studio/mcp-connections` | admin                                             | external MCP registry (disabled by default)                  |

A disabled workspace or deployment flag answers 404 on every Studio route; middleware is not the
boundary.

The composer accepts up to eight attachments per message (JPG, PNG, WebP or PDF, 20 MB each) through
the existing `/api/assets/presign` → direct bucket `PUT` → `/api/assets/finalize` flow. Only ids
returned by finalize are sent in `attachmentAssetIds`, an upload in progress blocks Send with a
stated reason, and a failed send keeps both the draft and the finalized ids for the retry. No new
flag, env var or provider call is involved.

## Enablement (both halves are required)

1. Deployment flags (Vercel env; do not set values in git):
   - `CONVERSATION_STUDIO_ENABLED=true` — the feature exists at all.
   - `CONVERSATION_STUDIO_AI_ENABLED=true` — only when a reviewed live model is configured below.
   - `CONVERSATION_STUDIO_DEFAULT_HOME=true` — optional; makes `/studio` the post-sign-in home.
   - `STUDIO_MCP_SERVER_ENABLED=true` — hosted MCP endpoint.
   - `STUDIO_EXTERNAL_MCP_ENABLED=true` — external MCP transport (still gated per connection).
   - `STUDIO_MCP_ENCRYPTION_KEY` — base64 32-byte AES-256-GCM key, **separate from SHOPLINE's**;
     absent means external connections cannot be approved or used.
2. Workspace row in `studio_workspace_settings` with `enabled = true`. No admin UI writes this row
   yet (the settings page is read-only for workspace state); a pilot enablement is an authorised
   SQL operation. Example, reviewed by the operator, on a non-production database first:

```sql
insert into studio_workspace_settings(
  workspace_id, enabled, allowed_skills, monthly_budget_usd, run_ceiling_usd,
  retention_days, default_home, updated_by
) values (
  '<workspace-id>', true, '{}', null, null, null, false, '<operator-id>'
)
on conflict (workspace_id) do update set
  enabled = excluded.enabled,
  updated_by = excluded.updated_by,
  updated_at = now();
```

`allowed_skills = '{}'` means "all pilot skills"; a non-empty list restricts execution. Unknown or
missing workspace rows fail closed (disabled).

## Live model configuration (optional)

Without a model the Studio is fully deterministic: records answers, gap reviews, dispatches,
merchant audit and copy-proposal _targets_ work; live analysis and copy proposals stay off with an
honest "model required/not configured" notice.

To enable live turns, an authorised operator sets the workspace AI columns (same strict
all-or-none set the repository enforces):

```sql
update studio_workspace_settings set
  ai_provider = 'opencode-go',            -- or 'openrouter'
  ai_model = 'deepseek-v4.1-flash',       -- must be in the reviewed cost registry
  pricing_version = '<reviewed-version>',
  max_input_tokens = 1048576,
  input_usd_per_million = 0.3,
  output_usd_per_million = 1.2,
  max_output_tokens = 4096,
  monthly_budget_usd = 5.000000,
  run_ceiling_usd = 1.000000,
  updated_by = '<operator-id>',
  updated_at = now()
where workspace_id = '<workspace-id>';
```

Admission fails closed when the provider/model pair is not in
`packages/core/src/paid-listing-policy.ts`, when pricing is below the reviewed bound, when a
budget/ceiling is missing, or when the AI flag is off. Provider credentials are server-only env
(`OPENROUTER_API_KEY` / `OPENCODE_GO_API_KEY`); they never reach the browser, model context or logs.
The turn holds one reviewed reservation per model call and settles actual usage once; unknown cost
keeps the hold (`uncertain`).

## Hosted MCP tokens

Admins create tokens on `/studio/settings` (label + scopes `read`/`propose`). The plaintext
`wuk_<prefix>.<secret>` is shown exactly once; only a SHA-256 hash is stored. Revoking is immediate
and audited; `last_used_at` is informational. Clients use
`Authorization: Bearer wuk_<prefix>.<secret>` against `POST /api/mcp` (protocol version
`2026-07-28`, stateless JSON-RPC, JSON responses; GET is 405). Only `read`/`propose` tools are
listed and callable; `dispatch` tools are never exposed. Every call writes a content-free
`studio_mcp_calls` ledger row (now including the calling `token_id`) and `studio.mcp.call` audit
event; arguments/outputs/tokens are never logged.

### Client setup

1. Admin creates a token on `/studio/settings` (optionally with quotas, see below) and copies the
   plaintext immediately.
2. Configure the MCP client with endpoint `https://<deployment>/api/mcp` and header
   `Authorization: Bearer wuk_<prefix>.<secret>`. There is no SSE stream; use plain HTTP POSTs for
   every request.
3. Handshake and call, for example:

```jsonc
// initialize
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2026-07-28" } }

// list the tools the token's scopes and the creator's current role allow
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }

// call a read tool
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "catalog.search", "arguments": { "query": "margaux" } } }
```

`read` tokens can only call read tools; `propose` tokens can only call propose tools; neither can
reach dispatch/write/approve tools even by naming them. The creator's current workspace role is
re-checked on every request (a removed or demoted creator fails closed). Notifications get `202`
with no body.

### Quotas

Each token may carry two optional limits, editable on `/studio/settings`:

- `rate_limit_per_minute` — rolling 60-second window, integer 1–600;
- `monthly_call_quota` — UTC calendar month, integer 1–1,000,000;
- `NULL` means unlimited (the admin form's blank input).

Before executing a `tools/call`, the server counts the token's own `studio_mcp_calls` rows in the
window/month. Over the minute limit it answers HTTP 200 with JSON-RPC error `-32029`; over the
monthly quota it answers HTTP 200 with `-32030`. A denied call executes no tool, writes no success
ledger row and no audit call event. The check uses a count snapshot taken when the request resolved
the token, so two concurrent calls can both pass at the boundary — the limit is honest but
deliberately approximate under concurrency. The panel shows each token's quotas next to its actual
minute/month usage from the ledger.

Creation also stops at **100 active tokens per workspace** (`409 token_limit_reached`); revoke or
rotate an existing token instead. Rotation is exempt from the count check so it can exceed the cap
by one transiently and never dead-ends on the last token.

### Rotation

`Rotate` (or `POST /api/studio/tokens/<id>/rotate`) creates a replacement token with the same label,
scopes and quotas, revokes the old token in the same transaction, and returns the new plaintext
**once**. The old plaintext is unrecoverable (only its SHA-256 hash was ever stored); clients must
switch their `Authorization` header immediately. Quota updates audit
`studio.mcp.token.limits_updated` (before/after values), rotation audits `studio.mcp.token.rotated`
(old and replacement ids), and revocation stays `studio.mcp.token.revoked`. The settings panel
shows the new plaintext in the same once-only block as creation.

## External MCP connections (disabled by default)

1. Admin creates a draft connection on `/studio/settings` with an HTTPS endpoint, transport and a
   tool allowlist. Schema hashes may be supplied now or collected by a probe.
2. The admin binds the workspace-owned credential (bearer token). It is encrypted server-side with
   `STUDIO_MCP_ENCRYPTION_KEY` as an AES-256-GCM `v1.<iv>.<ct>` envelope; no API returns it and the
   audit row records only that it was set/cleared plus the generation. Setting, rotating or clearing
   the credential bumps the generation and returns an approved connection to `draft`, so approval is
   repeated for the new generation.
3. **Probe** (explicit admin click) calls `initialize` + `tools/list` through the reviewed outbound
   client and shows the advertised input-schema sha256 per tool. It never invokes a tool and a draft
   may be probed so hashes can be pinned before approval. The probe is gated by
   `STUDIO_EXTERNAL_MCP_ENABLED=true`, the enabled workspace Studio row and a valid
   `STUDIO_MCP_ENCRYPTION_KEY`; a disabled connection is never probed.
4. **Pin advertised hashes** stores the `{tool -> sha256(inputSchema)}` snapshot (allowlisted names
   only); pinning also bumps the generation and returns an approved connection to `draft`.
5. Approval requires: `STUDIO_EXTERNAL_MCP_ENABLED=true`, the workspace Studio row enabled, a valid
   `STUDIO_MCP_ENCRYPTION_KEY`, and a pinned 64-hex schema hash for every allowlisted tool.
6. Every probe appends a `studio_mcp_calls` ledger row (`tools/list`, status, latency, request and
   response digests, caller `external_mcp`) and a `studio.mcp.connection.probed` audit event with the
   outcome and counts. Endpoint, credential and provider payloads are never written to either.
   Credential and pinning actions audit `studio.mcp.connection.credential_set` /
   `credential_cleared` / `schemas_pinned`.

**No skill call site yet.** The admin probe is the only outbound call: an approved connection is
dormant until a later explicit decision wires a reviewed skill (or the C5 ads connector design) to
it, and the UI never shows a "connected" state. Wrapping existing direct adapters (Tavily,
Photoroom, SHOPLINE) in MCP is not automatic.

### Endpoint destination guard

`approvedEndpoint` (shared by registration and the outbound client) accepts HTTPS only, rejects
embedded credentials, and rejects non-public destinations: `localhost`/`*.localhost`/`*.local`/
`*.internal`, IPv4 loopback, private, CGNAT, link-local (including `169.254.169.254`), benchmark,
multicast and reserved ranges, and IPv6 loopback, ULA, link-local, multicast and `::ffff:` private
maps. A draft pointing at one of these fails `400 invalid_endpoint`.

The guard is textual: DNS names that resolve to a private address — including DNS rebinding — are
not detected. Approved connections remain admin-gated and the outbound client is still not
instantiated; before the first live connector, add an egress policy or a resolve-and-verify check
for that residual risk.

## Operating the Studio

- **Deterministic first.** Home/overview and records answers never call a model or reserve budget.
  A model card is separate and labelled; ungrounded claims are dropped and counted.
- **Home templates follow the skill registry.** Each role-template card's Pilot/Planned/Unavailable
  label is derived from the reviewed skill registry at render time, not hard-coded: a pilot card
  fills the composer with its starter text and selects that skill, and a planned/blocked card
  states its limitation. Filling never sends.
- **Connections page reports the real deployment state.** `/studio/connections` derives hosted-MCP
  (`STUDIO_MCP_SERVER_ENABLED`), external-MCP (`STUDIO_EXTERNAL_MCP_ENABLED`) and encryption-key
  presence from the environment instead of a hard-coded snapshot, links to `/studio/settings` for
  token and connection management, and never renders a connect toggle or green "connected" state.
- **Every reviewed read tool executes.** `imports.list` reads recent workspace source-import
  receipts (id, `received` state, received time) and `exports.get` reads one export attempt by id,
  so the hosted-MCP `tools/call` path no longer advertises a read tool that only answers
  `unavailable`. `exports.get` reports `reconciliation: "unknown"` because this read layer has no
  reconciliation signal; a foreign or missing attempt id is `unavailable`, never invented.
- **Copy proposals** never write canonical data. Open the listing in the existing review screen to
  apply anything; the Studio artifact is versioned and can be saved (operator) and signed off
  (reviewer+); sign-off is an artifact state, not a listing approval or publish action.
- **Reproduction/replay.** Re-sending the same `clientMessageId` returns the persisted reply and
  never starts a second run. A failed/unknown run is shown explicitly; nothing auto-retries.
- **Threads** are workspace-visible by default; `private` threads are readable by their creator and
  admins/owners only. Ids from another workspace answer 404.
- **Limits today**: turns are synchronous and bounded by a 45 s wall-clock deadline, six first-class
  tool steps, a bounded 20 read per-listing detail fan-out and at most two model calls; exceeding a
  limit persists a failed run with a distinct error code (`studio_turn_timeout` /
  `studio_step_budget_exceeded`). No token streaming; no retention enforcement yet
  (`retention_days` is stored only); hosted-MCP quotas are per-token rolling-minute/monthly limits
  plus the 100-active-token cap (no global per-workspace MCP concurrency cap).

### Studio API cross-site guard

`POST`/`PATCH`/`PUT`/`DELETE` requests under `/api/studio/` pass through middleware before any route
handler. Browser requests whose `Sec-Fetch-Site` header is `cross-site` or `same-site` are rejected
with `403 {"code":"cross_origin_blocked"}`; `same-origin`, `none` and absent headers (non-browser
clients) continue to the route-level session/bearer checks. `/api/mcp` is excluded because its
JSON-RPC clients are cross-origin by design and authenticate with a bearer token. Other app APIs
still rely on the Better Auth session cookie's SameSite policy.

## Copy-proposal handoff and artifact exports (B2)

- **Handoff is read-only.** The review card links to
  `/listings/<listingId>?studioOutput=<outputId>`. The listing page resolves that optional UUID
  server-side: only a same-workspace `copy_proposal` for that same listing produces a banner with
  the raw field ids and `current → proposed`; every invalid, foreign, mismatched, disabled-Studio or
  read-error case fails closed to no banner. The banner can copy values and be dismissed (the link
  drops the query parameter); it never writes canonical data and never seeds the review form.
- **Exports are digest-gated.** `GET /api/studio/outputs/[id]/export?digest=<contentDigest>` keeps
  the original canonical `sorted-json-v1` JSON contract (default `format=json`). `format=pdf`
  renders the same packet server-side with `pdf-lib`; both formats require a `saved`/`signed_off`
  artifact, re-hash the persisted payload, return `409` if it changed since the preview, and `404`
  for a foreign/disabled-Studio id. An unknown `format` value is a `400`; missing `format` still
  means JSON.
- **PDF text uses the standard font.** No Unicode font is bundled and no dependency was added, so
  characters outside Latin-1 in proposed values appear as `[U+XXXX]` code points in the PDF; the
  canonical JSON export is the exact-text form. The PDF is generated only on the server, never in a
  browser, and contains no secrets.
- The review card exposes per-field "Copy proposed", "Copy all proposed values", an explicit
  not-applied state, and JSON/PDF links only when the artifact is saved/signed off (with the latest
  digest). Unsaved artifacts show "save before exporting" instead of a disabled claim of success.

## Merchant audit periods and signed exports (B3)

- **Period parsing is deterministic.** The audit turn reads the operator's text and accepts
  `last|past|previous N day(s)/week(s)/month(s)/year(s)` bounded to 1–365 days (a month is 30 days,
  a year 365) or one explicit ISO range `YYYY-MM-DD to YYYY-MM-DD` (ordered, inclusive, at most 365
  days). The artifact stores `period: {from, to, label}` in UTC days. No match, an unbounded value or
  an invalid/reversed range stores `period: null` and the report says it is showing current totals —
  it never guesses a silent window. The turn text itself is forwarded to the audit evidence only.
- **Only export attempts are period-scoped.** `exports` lists attempts whose `createdAt` falls inside
  the period (up to 20 read), `attemptsInPeriod` counts them, and the payload limitations explicitly
  say listing-status counts (`listings`) and the quality summary (`quality`) are **current snapshots**,
  not period statistics. When no period is named, `exports` are the latest five attempts and
  `attemptsInPeriod` is `null`.
- **Payload schema is `wukong-merchant-audit/v2`** (B2 exports keep the same digest/status/foreign-id
  checks; only the packet gains the optional receipt below).
- **Signed export receipt.** When `STUDIO_EXPORT_SIGNING_KEY` (64-char hex or base64, ≥16 bytes) is
  set, `format=json` exports add `signed: true` and a `receipt`:
  `{alg:"HMAC-SHA256", keyId, signedAt, payloadSha256, signature}` where `keyId` is
  `STUDIO_EXPORT_SIGNING_KEY_ID` (default `v1`) and `signature` is the hex HMAC-SHA256 of the exact
  canonical JSON
  `{"asOf":…,"keyId":…,"outputId":…,"payloadSha256":…,"revision":…,"schemaVersion":"wukong-studio-output-export/v1"}`
  (sorted keys, no whitespace; `payloadSha256` is the persisted version digest). Without the key the
  packet says `signed:false` and has no `receipt`; a configured but malformed key/id fails the export
  with `500 export_signing_misconfigured` rather than silently serving unsigned bytes. PDF exports are
  unchanged (payload digest header only, no receipt).
- **In-app receipt preview.** `GET /api/studio/outputs/[id]/receipt?digest=<contentDigest>` (viewer+)
  returns `{schemaVersion, payloadSha256, outputId, revision, asOf, keyConfigured, signed, receipt}`
  under the same Studio/session/status/digest/re-hash gates as the JSON export: 400 for a missing or
  invalid preview digest, the usual 401/403/404, 409 `output_not_saved`/`output_changed`, and 500
  `export_signing_misconfigured` for a malformed key. It never returns the key or the payload. The
  output/report card calls it only for `saved`/`signed_off` artifacts and shows pending, signed
  (key id + signature prefix), unsigned, or "could not read the receipt; the JSON download still
  carries it" — it never claims external verification beyond what the server returned.
- **Verification recipe** (never use a production key in a shell history on a shared host):

  ```bash
  # Copy message+receipt fields out of the downloaded JSON, then:
  MESSAGE='{"asOf":"2026-11-08T10:00:00.000Z","keyId":"v1","outputId":"<id>","payloadSha256":"<digest>","revision":1,"schemaVersion":"wukong-studio-output-export/v1"}'
  printf '%s' "$MESSAGE" | openssl dgst -sha256 -mac HMAC \
    -macopt hexkey:"$STUDIO_EXPORT_SIGNING_KEY" -hex
  # The printed HMAC must equal receipt.signature.
  ```

  The receipt only proves the file was produced by this deployment's signing key; it is not external
  verification, approval or proof of correctness.

- **Rotation/absence.** Rotate by replacing `STUDIO_EXPORT_SIGNING_KEY` and bumping
  `STUDIO_EXPORT_SIGNING_KEY_ID`; old receipts remain verifiable only with the old key (keep it for
  the retention window if past exports must stay verifiable). Absence is honest: exports and receipts
  say `signed:false`/`keyConfigured:false`, and the card shows the unsigned state instead of claiming
  a signature.
- The audit report is read-only: it never applies, publishes or changes canonical listing data.

## Search, filters and sharing (B5.1)

- **Search/filter happens on the server.** `/studio/threads?q=` searches the workspace's thread
  titles and skill keys case-insensitively, and `/studio/outputs?q=&kind=&status=` searches artifact
  titles and filters by exact kind/status. Both pages are plain `GET` forms (no client JavaScript
  required) and the query is applied before the page limit, so a match beyond the first 50 rows is
  still found. `GET /api/studio/threads` and `GET /api/studio/outputs` validate the same parameters
  strictly: an over-120-character `q`, an unknown key, or an unsupported kind/status is a
  `400 invalid_query` rather than being silently ignored. `%`, `_` and `\` in `q` are treated as
  literal characters (LIKE escaping), never as wildcards.
- **Visible rows stay scope-limited.** Thread search still applies the existing visibility rules
  (workspace threads, or private threads for the creator/admin/owner only); artifact reads still go
  through `forWorkspace`. A foreign workspace's rows cannot appear in a search result.
- **Share links copy the current address only.** The thread page's "Copy link to conversation"
  button copies the absolute (or, without a browser origin, relative) `/studio/t/<threadId>` address
  with honest copied/failed states. It performs no server call, publishes nothing and changes no
  visibility; a private thread shows "only you and admins can open this link" beside the action.
- The forms, selects and share control are labelled, keyboard-usable and wrap at 390 px using the
  existing Studio CSS patterns (new styles are limited to `studio.module.css`).
- **Lists are offset-paginated pages.** `/studio/threads` and `/studio/outputs` read one
  `STUDIO_PAGE_SIZE` page (50 rows) at `offset` and render Newer/Earlier links that preserve the
  active `q`/`kind`/`status` filters; `GET /api/studio/threads|outputs` accepts `offset` 0..100000
  (an out-of-range or non-integer value is `400 invalid_query`, never silently clamped).
- **Thread visibility is applied in SQL before the page is read.** Private threads are visible
  only to their creator and to admin/owner roles; the filter runs in `threads.list` before
  `ORDER BY`/`LIMIT`/`OFFSET`, so a page is never silently shortened by rows the viewer cannot see
  and the list/inbox reads never reveal another user's private conversation.

## Orchestration inbox (P3.1)

- **Read-only.** `/studio/inbox` (rail "Inbox") calls `service.inbox()`, which performs **one**
  `db.forWorkspace` transaction and reads existing records only: `listings.countByStatus`,
  `qualityProjection.read`, `pipelineRuns.listForWorkspace(20)`, `studio.outputs.list({limit:50})`
  and `studio.threads.list({limit:20, viewerId, includePrivate})` (the same SQL visibility filter, so
  recent conversations only include threads the viewer may see). A pure `buildStudioInbox` classifies/bounds them. There is
  no new table or migration, no write, no model call and no budget reservation.
- **Sections.** Needs attention (quality gaps, listings without an active version, unassessable
  active versions, plus the awaiting-review sum from listing statuses; links to `/quality` and
  `/dashboard`), recent non-success pipeline jobs (≤5, `/jobs`), draft artifacts needing save and
  saved artifacts awaiting sign-off (≤10, `/studio/outputs`), and recent conversations (≤5,
  `/studio/t/<id>`). Conversations are labelled recent — no reply/sign-off status is invented.
- **Honest bounds.** Each bounded list says when it is truncated; a source that cannot be read is
  marked unavailable and never rendered as a zero. A failed read collapses to one failure line and
  logs only `studio_inbox_read_failed` (no records or content). The home overview links to the inbox.

## Deploy and rollback order

1. Apply migrations `0054_conversation_studio.sql` and `0055_studio_mcp_token_lookup.sql` **before**
   deploying code that reads them (`pnpm --filter @wukong/db db:migrate` with the controlled-set
   procedure in the production recovery runbook). `0055` creates the dedicated
   `wukong_mcp_token_lookup` role, so the migration role needs `CREATEROLE`; it must not be a
   login/bypass-RLS role.
2. Deploy `apps/web` (and any Worker change separately; this feature adds no Worker message).
3. Enable the workspace row and flags; verify `/studio` and a records-only turn with the AI flag
   off first, then enable AI in a test workspace.
4. Rollback: set flags off and/or the workspace row `enabled=false`; routes return 404 and the nav
   item disappears. Migrations are additive and stay; no data is deleted by rollback.

## Workspace activation CLI

`scripts/studio-activation.mjs` flips an **existing** workspace's
`studio_workspace_settings.enabled` row after the migrations are applied. It never creates users,
workspaces or memberships, and the database URL is read from `DATABASE_ADMIN_URL` (environment
only). Without `--confirm` it prints a dry-run plan and touches nothing; a remote database also
requires `--allow-remote` so production mutation is always explicit.

```powershell
# 1. Dry run: prints the exact steps and changes nothing.
pnpm studio:activate -- --workspace-id <workspace-id> --owner-email <owner@example.com>

# 2. Live activation (requires the reviewed DB window, DATABASE_ADMIN_URL and both flags).
pnpm studio:activate -- --workspace-id <workspace-id> --owner-email <owner@example.com> --allow-remote --confirm

# 3. Rollback to disabled (same guards); feature flags are deployment env vars, not settings.
pnpm studio:activate -- --workspace-id <workspace-id> --owner-email <owner@example.com> --disable --allow-remote --confirm
```

The tool verifies the user, workspace and membership first and only then upserts `enabled` +
`updated_by`; it never edits budgets, skills, AI settings or any other column. A readback mismatch
exits non-zero. Run `pnpm --filter @wukong/db db:migrate` against the same database before it.

## Verification commands

```powershell
# Unit suites (run vitest directly in this environment; the .cmd wrapper breaks on "(app)")
node <repo>/node_modules/vitest/vitest.mjs run apps/web --exclude "**/*.integration.test.ts" --pool=threads --no-file-parallelism
node <repo>/node_modules/vitest/vitest.mjs run packages/core packages/ai --pool=threads --no-file-parallelism
node <repo>/node_modules/vitest/vitest.mjs run packages/db/src --exclude "**/*.integration.test.ts" --pool=threads --no-file-parallelism

# Studio integration (disposable local Postgres; never production)
# docker compose up -d postgres; create role wukong_app and database wukong_studio_test
$env:STUDIO_TEST_DATABASE_ADMIN_URL = "postgres://wukong:wukong@127.0.0.1:54329/wukong_studio_test"
$env:STUDIO_TEST_DISPOSABLE = "yes"
node <repo>/node_modules/vitest/vitest.mjs run --config ../../vitest.integration.config.ts `
  packages/db/src/studio-migration.integration.test.ts `
  packages/db/src/repositories/studio.integration.test.ts `
  packages/db/src/studio-mcp-migration.integration.test.ts --pool=threads --no-file-parallelism

# Types
<repo>/apps/web/node_modules/.bin/tsc.cmd --noEmit -p apps/web/tsconfig.json
<repo>/node_modules/.bin/tsc.cmd -p packages/core/tsconfig.json --noEmit

# Browser acceptance (needs an enabled workspace fixture and a running app)
# PLAYWRIGHT_BASE_URL=... node <repo>/node_modules/@playwright/test/cli.js test tests/e2e/studio.spec.ts
```

## Escalation notes

- Incident playbooks (activation rollback, provider/cost incidents, MCP token compromise, failed
  migration, release rollback and evidence collection) live in
  [studio-incident-response.md](./studio-incident-response.md).
- Any use of a real provider key, external MCP server, SHOPLINE write, production migration or
  deployment needs separate explicit approval and its own recorded acceptance run.
- Stop and record rather than improvising: if a turn ever appears to write canonical listing data
  or approve/publish from inside the Studio, disable the Studio flags immediately and preserve the
  audit/ledger rows.

## Local flags-on browser acceptance (verified 2026-11-09)

The Studio was driven end-to-end in a real Chromium session against a production build with only
`CONVERSATION_STUDIO_ENABLED=true` (no AI flag, no MCP, no SHOPLINE): password sign-in, Studio home,
a deterministic records question, the engine/evidence/trace reply, `Answered` status, follow-ups,
the "live analysis not configured" suggestion card, a full reload restoring the thread from
Postgres, the 390 px layout without horizontal overflow, and the thread appearing on
`/studio/threads`. Evidence screenshot:
`docs/superpowers/plans/assets/2026-11-08-studio-browser-acceptance-390.png`.

Reproduce locally (never against a shared/production database):

```powershell
# 0. disposable local Postgres only (docker compose up -d postgres), database `wukong`
#    with the migration set applied and the `wukong_app` role present
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@wukong/web          # package dists + production web build

# 1. seed a local-only owner, an enabled Studio workspace row and its invite-eligibility row
node tests/e2e/studio-browser-acceptance-seed.mjs  # BROWSER_E2E_DATABASE_ADMIN_URL defaults to local

# 2. production server with the Studio flag on (terminal A)
$env:DATABASE_URL="postgres://wukong_app:wukong-app-local@127.0.0.1:54329/wukong"
$env:AUTH_SECRET="local-browser-e2e-auth-secret-at-least-thirty-two-chars"
$env:AUTH_SMTP_URL="smtp://127.0.0.1:1026"
$env:AUTH_EMAIL_FROM="Wukong Auth <auth@local.invalid>"
$env:BETTER_AUTH_URL="http://127.0.0.1:49300"
$env:CONVERSATION_STUDIO_ENABLED="true"
pnpm --filter @wukong/web exec next start --hostname 127.0.0.1 --port 49300

# 3. run the gated acceptance spec (terminal B)
$env:PLAYWRIGHT_BASE_URL="http://127.0.0.1:49300"
$env:STUDIO_BROWSER_ACCEPTANCE="1"
pnpm exec playwright test tests/e2e/studio-browser-acceptance.spec.ts
```

The same authenticated flow now runs in CI as the `Studio flags-on browser acceptance`
step (after "Install Chromium", before the Opak browser steps, on its own port
49300; 49217/49218/49219 stay with the existing modes). The step seeds the job's
already-migrated `wukong` database with
`node tests/e2e/studio-browser-acceptance-seed.mjs` (which now falls back to
`DATABASE_ADMIN_URL`), starts the production build on `127.0.0.1:49300` with
`CONVERSATION_STUDIO_ENABLED=true`, waits for `/signin`, and runs the gated spec
with `STUDIO_BROWSER_ACCEPTANCE=1`. The AI flag and every MCP flag stay unset,
so no model provider or MCP server is called; the server is killed on exit.

Notes learned from the run:

- Sign-in eligibility is not just a user + credential: `auth_get_eligible_user` also requires a
  `workspace_invites` row (pending/accepted) for that address. The seed fixture creates it.
- Run this against `next build && next start`, not `next dev`: the dev server (Turbopack, development
  export condition) resolves workspace package sources and cannot handle their NodeNext `.js`
  relative specifiers, so any page importing `@wukong/db` fails to compile in dev. That is a
  pre-existing dev-server limitation, unrelated to the Studio, and does not affect the production
  build/browser acceptance or the deployed app.
- The seeded password is local-only fixture data; never reuse it or point this flow at a shared
  database.

## Observability and budget alerts

Every Studio turn writes exactly one content-free operational log line in addition to its durable
run/trace/audit rows:

```json
{
  "event": "studio.turn.metrics",
  "status": "answered",
  "durationMs": 842,
  "toolSteps": 3,
  "detailReads": 1,
  "modelCalls": 1,
  "traceSteps": 5,
  "outputCount": 0,
  "limitationCount": 0,
  "settledUsd": "0.020000"
}
```

`status` is the reply status (`answered`, `partial`, `needs_input`) or `failed`; failed turns carry a
safe `errorCode` (for example `studio_turn_timeout`, `studio_step_budget_exceeded`) and
`settledUsd: null`. The line never contains the question, model output, customer content, ids,
tokens or URLs, so it is safe to route to a log drain and chart.

When a workspace has a budget cap configured (`monthlyBudgetUsd` is the committed-USD admission cap;
it is not an auto-resetting calendar budget), each turn also evaluates utilisation and emits an alert
line below the rates:

```json
{
  "event": "studio.budget.alert",
  "level": "warning",
  "scope": "workspace",
  "committedUsd": "8.500000",
  "budgetUsd": "10.000000",
  "utilizationPercent": 85
}
```

- `warning` at 80% of the cap, `exhausted` at 100% (a new model call is refused at the cap).
- Raise the cap in `/studio/settings` (A1 admin settings) if the pilot needs more headroom; lowering
  it below current committed spend is allowed and shows `exhausted` until the ledger drains.
- Recommended alerting: forward `studio.turn.metrics` and `studio.budget.alert` to the log drain and
  alert on `errorCode` rates and `level` events. The readiness-gate log scan remains a human sign-off
  item; these lines are designed to pass it.

## Skill: `category.map_proposal` (pilot v1.1.0)

Reads the target listing (`catalog.get`) plus similar catalog rows (`catalog.search`). The current
category is shown as **unknown** because canonical listing content carries no category field; the
turn never invents one. Without a configured model the turn still persists a versioned finding
artifact with explicit empty suggestions and limitations; with a model enabled, only
evidence-ref-grounded, de-duplicated suggestions with confidence 0–1 are kept (dropped suggestions
are counted in the reply limitation). Nothing is ever applied — a person must change the category in
the existing catalog flow. Findings render as read-only cards linked to the listing review screen.

## Skill: `product_shot.prepare` (pilot v1.1.0)

Deterministic **prepare/handoff** only. The turn reads the target listing (`catalog.get`), the assets
attached to it (`assets.list`, now executable server-side) and the persisted image-review attempt, then
records a `product_shot_handoff` dispatch: usable source image ids (PNG/JPEG/WebP, at most eight), the
current attempt state (`queued` … `approved`/`failed`/`outcome_unknown`, or unknown when no attempt
exists) and a `ready` flag. It never calls the Photoroom provider, never mints a signed URL, never
approves an image and persists no artifact; the read-only thread card links to the existing gated
product-shot screen where the operator continues. Derived cutouts/candidates are counted but never fed
back as sources, and a missing asset or attempt read is reported as unknown/partial, never as zero.
`assets.list` also becomes available to the hosted MCP `tools/call` surface with the same read-only,
workspace-scoped, ids-only shape.

## Skill: `supplier.intel_proposal` (pilot v1.1.0)

Deterministic finding from the listing's **linked workbook row**. The bulk-form importer stores the
canonical row (including `supplier`, `brand`, `sku`, `barcode`, `mpn`, `productCost`, `tradePrice`)
in `platform_products.raw_row` and links its source-import receipt, so the turn reads the listing
(`catalog.get`) plus that row and receipt through the workspace read surface. It persists a versioned
`wukong-supplier-intel/v1` finding with the fields that have a stored value, lists the missing fields
as unknown, and states its limitations: nothing is applied, no supplier or listing record is written,
and workspace-level website records are not listing-linked so they are never used as evidence. No
model is called; without a linked row the turn stays **partial** and saves no artifact. The finding
renders as a read-only card linked to the listing review screen.

## Activation dry run (preview) — verified 2026-11-09

Steps 1–5 of the production activation sequence were rehearsed end-to-end on a **fresh disposable
database** (never production, all local):

1. created an empty local Postgres database (`wukong_activation_dry_run`);
2. replayed the full migration set through `0057_studio_mcp_token_quotas.sql` with the normal
   `@wukong/db db:migrate` runner (`DATABASE_URL` runtime role + `DATABASE_ADMIN_URL` admin role);
3. seeded a workspace, owner user/credential, a second **viewer** member for the authorization
   acceptance, invite-eligibility rows and an enabled `studio_workspace_settings` row with
   `tests/e2e/studio-browser-acceptance-seed.mjs`;
4. built the web production bundle and started it with `CONVERSATION_STUDIO_ENABLED=true`
   (AI/MCP flags unset) against that database;
5. ran the authenticated acceptance spec (`STUDIO_BROWSER_ACCEPTANCE=1`, production build):
   **4 passed** — sign-in, Studio home, deterministic records answer, checks/follow-ups,
   execution trace, reload persistence, 390 px layout, threads list; the **supplier-intel
   finding** (template fill → send → quoted workbook fields/unknown list/no-write boundary,
   read-only with no button control, reload persistence, artifact listed on `/studio/outputs`);
   a route smoke over every Studio surface (`/studio`, threads, outputs, inbox, connections,
   owner settings) asserting the real heading renders instead of a server error, plus the A5
   usage projection on settings; and the **viewer authorization** boundary (shell "New
   conversation" and composer Send disabled with the honest role note, every read surface still
   rendering, `/studio/settings` rendering the not-found boundary with no admin content).

Post-run evidence in the disposable database: 2 threads with their user+assistant messages (4
messages), 2 `succeeded` runs and audit events `studio.thread.created`, `studio.message.received`,
`studio.run.completed`. Rollback was
also rehearsed (`UPDATE studio_workspace_settings SET enabled=false`) and returned the workspace to
disabled before dropping the database. The exact commands are the A2 activation commands above; only
the **production** execution (real connection/credentials/migration window) remains gated on the
operator decision.

## Skill authoring

How to add, version, review and promote a Studio skill (registry vs runtime, evidence contract, prompt pins, artifact/readback, tests, workspace allowlist and the promotion gate): see [docs/studio-skill-authoring.md](../studio-skill-authoring.md).

## Automated log scan

The readiness gate's log review has an automated first pass:

```powershell
vercel logs --environment production --limit 1000 --json > production-logs.jsonl
node scripts/scan-runtime-logs.mjs production-logs.jsonl
```

The scanner looks for OpenAI-style keys, AWS access key ids/signatures, bearer tokens, Postgres URLs,
signed query parameters, SHOPLINE token prefixes, unmasked password/API-key JSON fields and prompt
injection markers. It reports pattern names with line/column positions only — never the matched
value — and exits non-zero when anything is found. This is a best-effort sample; a person must still
review deployment-specific logs for the release gate.

## Admin usage summary (A5.2)

`/studio/settings` (admin/owner only) renders a read-only **Usage — last 30 days** section computed
server-side from the existing Studio tables: turns by status with input/output tokens, settled and
reserved USD, MCP calls by status, and threads/messages created in the window. It is a projection
only — no new table, write, model call or migration — and structured turn/budget events remain the
authoritative observability source for investigations. If the aggregate read fails, the page logs
`studio_metrics_read_failed` and shows one localised failure note while the settings form still
renders.
