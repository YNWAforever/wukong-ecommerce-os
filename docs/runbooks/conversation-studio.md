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
`studio_mcp_calls` ledger row and `studio.mcp.call` audit event; arguments/outputs/tokens are never
logged.

## External MCP connections (disabled by default)

1. Admin creates a draft connection on `/studio/settings` with an HTTPS endpoint, transport and a
   pinned tool allowlist plus advertised-schema hashes.
2. Approval requires: `STUDIO_EXTERNAL_MCP_ENABLED=true`, the workspace Studio row enabled, a valid
   `STUDIO_MCP_ENCRYPTION_KEY`, and a pinned 64-hex schema hash for every allowlisted tool.
3. Credentials are encrypted server-side (AES-256-GCM envelope, new key) and never returned by any
   API; disabling removes transport eligibility.

**No call site instantiates the outbound client yet.** An approved connection is dormant until a
later explicit decision wires a reviewed skill to it; the UI must not show a "connected" state.
Wrapping existing direct adapters (Tavily, Photoroom, SHOPLINE) in MCP is not automatic.

## Operating the Studio

- **Deterministic first.** Home/overview and records answers never call a model or reserve budget.
  A model card is separate and labelled; ungrounded claims are dropped and counted.
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
  (`retention_days` is stored only); no MCP token rate-limit ledger yet; no workspace-settings
  admin API (SQL above).

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
