# Conversation Studio — production activation package (2026-11-12)

Status: **prepared, not executed for production.** Every Studio flag is off in production, no live
model call, external MCP connection, SHOPLINE write or workspace activation has been performed. A
read-only preview-branch dry run has been performed (section 8): it is blocked because the only
surviving non-primary Neon branch predates the Studio migrations. This package is the operator
handoff for the remaining A2/A3/C3 work; it changes nothing by itself.

## 1. Current production posture

| Item                          | Value                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Main commit                   | `4cd989a9be1bf48aee4b58a343f0820b9dfb0346`                                                                         |
| Production deployment         | `dpl_3NUqmAwMPdRaiRwTv1CheppX8Zn7` (Ready)                                                                         |
| Project alias                 | `https://wukong-ecommerce-os.vercel.app`                                                                           |
| `GET /signin`                 | 200                                                                                                                |
| `GET /` unauthenticated       | 307 → `/signin?callbackUrl=%2F`                                                                                    |
| `GET /studio` unauthenticated | 307 → `/signin?callbackUrl=%2Fstudio`                                                                              |
| Studio REST APIs unauth       | 401                                                                                                                |
| `POST /api/mcp`               | 404 (hosted MCP flag off)                                                                                          |
| Vercel env names present      | `DATABASE_URL`, `DATABASE_ADMIN_URL`, `S3_*`, `AI_PROVIDER=opencode-go`                                            |
| Vercel env names absent       | all `CONVERSATION_STUDIO_*` / `STUDIO_*` flags; no `OPENCODE_GO_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` |
| Preview                       | has `DATABASE_URL` but no preview `DATABASE_ADMIN_URL`; the branch-scoped values belong to an old review branch    |

Latest evidence: post-merge main CI run `43151250977` is green, including the flags-on browser
acceptance and the read-only activation preflight step.

## 2. What is ready to activate

| Area                  | Delivered                                                                                                                                                                                                                                                                                                                       | Verified by                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A1 admin settings     | owner/admin settings API + UI (budget, skill allowlist, read-only workspace state)                                                                                                                                                                                                                                              | browser acceptance test 9, CI                                                                                             |
| A2 activation tooling | `scripts/studio-activation.mjs` (`--preflight`, plan, guarded live/disable with a content-free `studio.settings.updated` audit row), runbook sequence                                                                                                                                                                           | preflight tests + CI preflight step, fresh-DB `ready`/`blocked` runs, audited live run on local and Neon-branch databases |
| A3 boundary           | deterministic Studio works with no model; live model columns are all-or-none and admission fails closed                                                                                                                                                                                                                         | turn-service tests, `needs_input`/model-required copy                                                                     |
| A4 acceptance         | authenticated flags-on browser suite (10 tests) in CI                                                                                                                                                                                                                                                                           | CI step `Studio flags-on browser acceptance`                                                                              |
| A5 observability      | one content-free `studio.turn.metrics` line per turn, `studio.budget.alert` above the cap, usage projection on settings                                                                                                                                                                                                         | observability/turn-service tests, route smoke                                                                             |
| B1 attachments        | composer upload via presign → PUT → finalize, ids persisted with the turn                                                                                                                                                                                                                                                       | browser acceptance test 3, CI                                                                                             |
| B2 handoff/export     | read-only copy-proposal handoff on the review screen; JSON/PDF exports bound to the previewed digest                                                                                                                                                                                                                            | browser acceptance tests 4–5, CI                                                                                          |
| B4 hosted MCP         | quota/rotation/revoke, read-tool JSON-RPC server behind `STUDIO_MCP_SERVER_ENABLED`                                                                                                                                                                                                                                             | browser acceptance test 10, CI                                                                                            |
| C1 skills             | **eight pilot skills** (`catalog.find`, `catalog.gap_review`, `listing.copy_proposal`, `listing.draft_from_sources`, `merchant.audit`, `product_shot.prepare`, `category.map_proposal`, `supplier.intel_proposal`), two blocked (`customer.reply_draft`, `logistics.followup`), zero planned; reviewed registry + skill harness | unit tests, browser acceptance                                                                                            |
| C3 admin side         | external MCP connection registry, encrypted credential envelope, schema pinning, call ledger; transport still off                                                                                                                                                                                                               | unit/route tests, settings route smoke                                                                                    |

## 3. Activation sequence (deterministic Studio first, no model)

Prerequisites: the A2 database-access decision below, a reviewed window, the production workspace id
and its owner email, and an operator available for the authenticated acceptance.

1. **Snapshot and preflight (read-only).** Load the production admin URL into the operator shell as
   `DATABASE_ADMIN_URL` (never argv, never committed) and run:
   `pnpm studio:activate -- --workspace-id <id> --owner-email <owner> --preflight --allow-remote`.
   Expected: `"outcome":"ready"`, `schema.ok`, `roles.ok`, owner membership. A `blocked` report lists
   exactly what is missing — stop and fix before touching the window.
2. **Apply additive migrations** `0054`–`0057` with the normal
   `pnpm --filter @wukong/db db:migrate` against the same admin URL. They create tables, indexes,
   functions and roles only; no existing row is rewritten.
3. **Preflight again**, then **enable the workspace row** with the same command plus
   `--allow-remote --confirm` (print the plan first by omitting `--confirm`). The tool verifies
   user/workspace/membership, upserts `enabled=true` and reads it back.
4. **Enable the deployment flag**: `CONVERSATION_STUDIO_ENABLED=true` in Vercel and redeploy.
   Keep `CONVERSATION_STUDIO_AI_ENABLED`, `STUDIO_EXTERNAL_MCP_ENABLED` and `STUDIO_MCP_SERVER_ENABLED`
   off for this first activation; `CONVERSATION_STUDIO_DEFAULT_HOME=true` is optional and can wait.
5. **Authenticated production acceptance** (the step not yet performed): sign in as the pilot owner,
   open `/studio`, ask a deterministic records question, check the trace/evidence/limitations, reload
   and confirm persistence, open `/studio/outputs` and `/studio/settings`, and confirm no model call
   and no write. Record ids/counts only; do not paste customer content into tickets.
6. **Record the result** by appending a dated section to this package: deployment id, flag state,
   workspace id, acceptance outcome and rollback path. If anything is unclear, set
   `CONVERSATION_STUDIO_ENABLED=false` and redeploy.

Hosted MCP (`STUDIO_MCP_SERVER_ENABLED=true`) is a separate, later decision: it exposes read tools to
`wuk_…` bearer tokens and should be enabled only after the deterministic Studio acceptance and a token
ownership decision.

## 4. Decisions the operator must supply

| ID               | Decision                                                                                                                                                  | Needed to proceed                                           | Consequence if withheld                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A2               | **Database access**: approve the production/migration window and provide the admin URL (or a Neon branch URL) plus the pilot workspace id and owner email | Steps 1–4 above                                             | Activation stays off; the preflight continues to run in CI only              |
| A3               | **Live model**: provider/model in the reviewed cost registry, pricing version, credential and total budget cap                                            | `CONVERSATION_STUDIO_AI_ENABLED=true`, workspace AI columns | Deterministic Studio only; analysis/copy proposals stay honestly unavailable |
| C3               | **External MCP**: which provider/endpoint is approved, who owns its credential, and `STUDIO_MCP_ENCRYPTION_KEY`                                           | external connection approval + transport flag               | Registry stays read-only; no external connection exists                      |
| P3.2 / B5.2 / C5 | scheduled-run host+skills+cadences+notifications, streaming/long-turn presentation, connector sequence                                                    | next phase implementation                                   | No scheduled runs, streaming or new connectors                               |

## 5. Rollback

- **Web**: set the Studio flags off and redeploy (or promote the previous production deployment).
  Routes return 404; the nav item disappears; middleware is not the boundary.
- **Workspace**: `pnpm studio:activate -- ... --disable --allow-remote --confirm` sets
  `studio_workspace_settings.enabled=false` with the same guards and readback.
- **Schema**: migrations `0054`–`0057` are additive and stay; no data is deleted by rollback. The
  Studio ledgers (`studio_messages`, `studio_run_events`, `studio_output_versions`, `studio_mcp_calls`)
  are append-only by trigger and stay readable for evidence.
- Incident playbooks (provider/cost, MCP token compromise, failed migration, release rollback) live in
  [studio-incident-response.md](./studio-incident-response.md).

## 6. Invariants that stay true during activation

- The Studio never approves, publishes or writes canonical listing data on its own; its only write is
  the human-confirmed draft dispatch, which hands off to the existing review screen.
- SHOPLINE publication remains `SHOPLINE_PUBLISH_ENABLED=false` until a separate explicit write gate.
- Logs never contain prompts, model output, customer content, tokens or signed URLs.
- Every domain mutation still writes an audit row; `audit:verify` remains a release gate.

## 7. Local rehearsal record (2026-11-12)

The sequence above was rehearsed end-to-end against a **fresh disposable local database**
(`wukong_activation_rehearsal` on the local Postgres, never a shared or production database), starting
from an empty schema; the fixture owner row was created by the browser-acceptance seed so the rehearsal
had a real user/workspace/membership to target.

| Step                                   | Result                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Preflight, before migrations           | `blocked` (exit 2): every Studio table and both resolver functions missing; identity checks skipped honestly |
| Apply migrations `0054`–`0057`         | all applied; schema check then passed                                                                        |
| Preflight, after migrations            | `blocked` (exit 2): schema and roles OK, `userExists`/`workspaceExists` false                                |
| Seed a workspace/owner/membership      | —                                                                                                            |
| Preflight, after seed                  | `ready` (exit 0): `schema.ok`, `roles.ok`, owner membership, settings `enabled:true`                         |
| Dry-run plan (no `--confirm`)          | exit 0, printed the six steps and touched nothing                                                            |
| `--disable --confirm` then `--confirm` | both exit 0 with readback; row went `enabled=false` → `enabled=true`                                         |

A later 2026-11-12 refresh of the live tool added the audit write; it was verified end-to-end on a
fresh local database and on the Neon rehearsal branch (see section 8): each enable/disable appended
one `studio.settings.updated` row with `source: "studio-activation-cli"` and the before/after
`enabled` value, in the same transaction as the settings write.

Notes for the production window:

- Database **roles are cluster-scoped**, not per-database. The local cluster already had `wukong_app`
  and the two lookup roles, so their check passed even before the fresh database had migrations;
  in production, create the runtime role per the local-development runbook before migrating.
- The rehearsal used only localhost, so no `--allow-remote` was needed. Every non-localhost target
  (including a preview branch) requires `--allow-remote`, and the live mutation also requires
  `--confirm`.
- No production database, credential or flag was used. The authenticated production acceptance
  (step 5 of the sequence) is still unperformed and remains part of the A2 decision.

## 8. Preview-branch dry-run record (2026-11-12)

Authorization for this round was explicitly **read-only preflight** on a preview/branch database — no
migrations, no settings writes, no deployment flags, no model calls. The dry run therefore verifies
readiness reporting against a real remote branch, not the activation itself.

Target: the Neon project `weathered-lake-51694428`, existing non-primary branch
`codex/recovery-rehearsal-20260916` (`br-proud-smoke-atewisu1`, created 2026-09-16, endpoint
`ep-damp-bar-atgdojx6.c-9.us-east-1.aws.neon.tech`, database `neondb`). The admin connection URL was
read through the Neon CLI into `DATABASE_ADMIN_URL` only; it was never printed, committed or reused
against the production endpoint.

Result: **`blocked`, exit 2** — the branch is a September snapshot that predates the Studio
migrations:

- missing tables: `studio_workspace_settings`, `studio_threads`, `studio_messages`, `studio_runs`,
  `studio_run_events`, `studio_outputs`, `studio_output_versions`, `studio_budget_reservations`,
  `studio_mcp_connections`, `studio_mcp_calls`, `studio_api_tokens`
- missing functions: `studio_resolve_api_token`, `studio_resolve_api_token_limits`
- missing role: `wukong_mcp_token_lookup` (created by migration `0055`); `wukong_app` and
  `wukong_image_lookup` are present and safe (no `SUPERUSER`/`BYPASSRLS`)

So the branch needs the full replay-safe `db:migrate` before it can rehearse activation; running it
was not authorised this round.

### Preview isolation finding (needs an operator decision)

The preview and production Vercel environments resolve to the **same Neon endpoint** (`neondb` on the
project's `main` branch): the preview `DATABASE_URL` (`Preview, Development` scope) has the production
endpoint, and the production `POSTGRES_URL`/`DATABASE_URL_UNPOOLED` resolve to that same endpoint.
The only branch-scoped preview `DATABASE_URL` points at `codex/opak-isolated-staging-20261002`, a
branch that **no longer exists** in the Neon project.

Consequences:

- A preview deployment is **not** a safe rehearsal target today; exercising activation or mutating
  acceptance there would touch production data.
- Recommendation before the next A2 attempt: create a dedicated Neon branch (per rehearsal, or a
  preview branch) and set the preview-scoped `DATABASE_URL` to it, then run `db:migrate` and the
  preflight there first. That is a configuration change in the operator's control, and it also
  protects future preview testing.
- The read-only preflight itself is safe to point at any such branch; only `--confirm` mutations
  need the production window.

### Dedicated branch rehearsal (2026-11-12, after the replay fix)

A fresh Neon branch was created from the project's `main` snapshot and used to rehearse the whole
sequence without touching the production endpoint:

| Step                                                                                                                | Result                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create branch `studio-a2-rehearsal-20261112` (`br-steep-haze-atpzdgck`, endpoint `ep-delicate-waterfall-athydni9…`) | created from `main`; production endpoint never used                                                                                                                                                                                                   |
| First `db:migrate` attempt                                                                                          | **failed** at `0021_product_shots.sql` with `42501`: the Neon owner role has no superuser and cannot act as / transfer ownership to the lookup role                                                                                                   |
| Fix (migrations `0021`, `0055`, `0057`)                                                                             | lookup-owned functions are now created/replaced **as the owning role** via `SET ROLE`; the migration grants its admin a `SET` membership edge once and revokes the temporary schema `CREATE` privilege afterwards. A `packages/db` test pins the rule |
| `db:migrate` after the fix                                                                                          | **green**: `0021`–`0057` applied, including role creation and both resolver functions                                                                                                                                                                 |
| Immediate second `db:migrate` (replay)                                                                              | **green** — replay is no longer blocked by function ownership                                                                                                                                                                                         |
| `--preflight --allow-remote`                                                                                        | `ready`, exit 0: schema/roles/functions ok, `ws_opak` + its member exist (membership `operator`), settings row absent                                                                                                                                 |
| Dry-run plan                                                                                                        | exit 0, six steps, no writes                                                                                                                                                                                                                          |
| `--allow-remote --confirm` (enable)                                                                                 | `outcome:"ok"`, `enabled:true`, `audited:true`, readback verified                                                                                                                                                                                     |
| `--preflight` after enable                                                                                          | `ready`, settings `{exists:true,enabled:true}`                                                                                                                                                                                                        |
| Audit row after enable                                                                                              | one `studio.settings.updated` row, `source:"studio-activation-cli"`, `before.enabled:false` → `after.enabled:true`, actor = member                                                                                                                    |
| `--disable --confirm`                                                                                               | `outcome:"ok"`, `enabled:false`, `audited:true` (branch left migrated and disabled)                                                                                                                                                                   |
| Audit row after disable                                                                                             | second `studio.settings.updated` row, `before.enabled:true` → `after.enabled:false`; settings row and audit trail agree                                                                                                                               |

The branch is left in place as the ready preview/rehearsal candidate — the operator can point the
preview `DATABASE_URL` at it (see the isolation finding above) or delete it with
`neonctl branches delete studio-a2-rehearsal-20261112`. Its settings row is disabled; no deployment
flag points at it, so nothing is activated for users.

## 9. Evidence index

- Runbook: [conversation-studio.md](./conversation-studio.md) (enablement, activation CLI with
  `--preflight`, observability, local acceptance reproduction, rollback).
- Acceptance spec: `tests/e2e/studio-browser-acceptance.spec.ts` (10 tests) and its seed.
- Release record: [conversation-studio-release-2026-11-09.md](./conversation-studio-release-2026-11-09.md).
- Recent merge chain (all PR CI green, main CI green): #193 hosted-MCP acceptance, #194 handoff,
  #195 attachments + CI fixes, #196 exports, #197 dispatch, #198 preflight, #199 role posture,
  #200 CI preflight step.
