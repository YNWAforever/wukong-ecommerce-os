# Next development roadmap — from deployed Studio to a commerce orchestration OS

Status: proposed plan, 2026-11-09. Baseline: Conversation Studio merged into `main` (`e53d2026`)
and deployed to production with every flag off; hosted MCP server and external-MCP registry built
but dormant; five pilot skills and one live browser acceptance recorded. This document sequences the
next development so the product can move from "deployed but not activated" to the intended
operator surface: **conversation → grounded evidence → proposed artifact → human-approved action
across commerce connectors**, with every action auditable.

## Product north star

> An operator asks a question in Conversation Studio. The Studio answers from canonical workspace
> records with evidence and an execution trace, proposes a reviewable artifact (copy, draft, audit,
> report), and — only after explicit confirmation — dispatches an action through a reviewed
> connector or MCP server. Nothing is fabricated, nothing writes silently, and every step is
> replayable and auditable.

Reference shape the user asked for: a Wukong "commerce orchestration" workspace (like the Lovable
reference) where Studio, versioned skills and MCP tools replace ad-hoc screens; and an
Ads-Copilot-style assistant that can inspect, recommend and act on paid/marketing operations once a
connector exists.

## Current baseline (shipped and verified)

- **Studio surfaces**: `/studio`, `/studio/t/[id]`, `/studio/threads`, `/studio/outputs`,
  `/studio/connections`, admin `/studio/settings`.
- **Pilot skills**: `catalog.find`, `catalog.gap_review`, `listing.copy_proposal`,
  `listing.draft_from_sources`, `merchant.audit`, `category.map_proposal`, `product_shot.prepare`,
  `supplier.intel_proposal`; blocked pending a source/write decision:
  `customer.reply_draft`, `logistics.followup`.
- **Versioned outputs** with digest/readback/sign-off and canonical JSON export; confirmed
  listing-draft dispatch through the existing intake service.
- **Hosted MCP server** (`2026-07-28`, hashed workspace tokens, read/propose only, ledger + audit)
  and an **admin-approved external MCP registry** (credentials encrypted, disabled by default, no
  call site).
- **Hard limits**: 45 s turn deadline, six first-class tool steps, bounded detail fan-out, two model
  calls; reviewed budget admission with reserve/settle/uncertain holds (fake-model verified only).
- **Operational gates**: CI green on Node 24 (including root `pnpm test`, production build, real
  stack Playwright and the synthetic-draft `audit:verify`); production deployment live with flags
  off; readiness log scan best-effort clean.
- **Known gaps that shape this roadmap**: no admin API/UI for workspace Studio settings (manual SQL);
  no live provider/model run ever; attachment upload UI absent; no production migration applied;
  no authenticated flags-on acceptance in CI; no retained-output enforcement/quotas; no external MCP
  live connection; no orchestration/scheduling layer.

## Workstreams

### P0 — Activation readiness (weeks 1–2; blocking the pilot)

Goal: turn the deployed-but-off build into a safely operable pilot, without crossing the gates that
need a human decision.

| #   | Deliverable                                                                                                                                                                                                                   | Notes                                                                     | Exit criterion                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A1  | Admin **workspace settings API + UI** (enable, allowed skills, budgets, retention, default home, all-or-none AI block validated against the reviewed cost registry) with audit and readback                                   | Replaces the manual SQL runbook; needed before any activation             | Admin can configure a workspace in the UI; viewer/operator denied; invalid pricing/model rejected |
| A2  | **Production activation runbook automation**: controlled migration set (0054–0056) applied via the hash-pinned migration CLI, seeded pilot workspace, staged flags (preview → pilot workspace → default home), rollback steps | Needs production DB admin access + a maintenance window (user decision)   | Preview/test workspace activated and rolled back cleanly; exact commands recorded                 |
| A3  | **Live model onboarding**: provider credential in the deployment secret store, live smoke turn (records + one labelled analysis), cost guard rails, kill switch; capability moves to pilot only after the recorded run        | Needs provider credential + reviewed budget (user decision)               | One live provider turn recorded end-to-end with spend/limit evidence, or explicitly deferred      |
| A4  | **Authenticated flags-on acceptance in CI**: seeded fixture workspace + Playwright flags-on flow (deterministic and one fake-model analysis), 390 px, reload persistence                                                      | Closes the last local-only acceptance gap and protects activation changes | Flags-on spec runs in CI and gates the PR                                                         |
| A5  | **Observability**: per-turn deadline/step/latency counters, run/ledger dashboards, budget-hold alerts, error taxonomy; log-scan automation for the readiness gate                                                             | Content-free metrics only                                                 | Dashboard/alerts exist for the pilot; readiness scan automatable                                  |

**Gate for P0:** user approves production migration window + provider credential/budget + pilot
workspace/users. No activation before A1–A4 are green.

### P1 — Studio completion (weeks 2–5)

Goal: remove the rough edges operators will hit on day one.

| #   | Deliverable                                                                                                                                                                        | Notes                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| B1  | **Attachment/source upload** in the composer (presign/finalize → evidence binding → dispatch assets; progress + failure states)                                                    | Uses existing asset APIs; replaces "pin a UUID in text" |
| B2  | **Copy-proposal apply handoff**: deep-link into the existing review screen with the proposal preloaded, diff/export (canonical JSON + printable PDF), explicit "not applied" state | No Studio canonical writes                              |
| B3  | **Merchant audit v2**: date range/period, scheduled run, signed export receipt (HMAC/verifiable), saved report history                                                             | Deterministic first, optionally model summary           |
| B4  | **Hosted MCP production hardening**: token quotas/rate limits + usage ledger, rotation UI, scope enforcement tests, client setup docs; production hosted MCP remains flag-gated    | No external MCP live connection yet                     |
| B5  | **UX polish**: streaming/progress presentation for long turns, thread search/share, outputs centre, mobile/a11y pass, bilingual copy completeness                                  | Keeps the honest, traceable feel                        |

**Gate for P1:** full web suite + integration + CI; browser acceptance for new flows; no regression in
existing routes; staged flag rollout.

### P2 — Skills and MCP expansion (weeks 5–9)

Goal: make the Studio actually useful beyond listing QA.

| #   | Deliverable                                                                                                                                                                                   | Notes                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| C1  | Finish **planned skills**: `product_shot.prepare`, `category.map_proposal`, `supplier.intel_proposal` (deterministic evidence first, optional model, review gates, versioned artifacts)       | All three are pilot v1.1.0; no planned skills remain |
| C2  | **Blocked-skill decisions**: `customer.reply_draft`, `logistics.followup` — resolve source data ownership, privacy, write gates; either build or keep blocked with documented reasons         | User decision on data sources                        |
| C3  | **External MCP first connection**: allowlisted provider, schema pinning, egress/timeout/quota policy, credential ownership, live acceptance; admin approval workflow exercised                | Requires explicit approval + provider decision       |
| C4  | **Skill authoring harness**: manifest/versioning, fixture-driven evals, dry-run, per-workspace enablement (ties to A1), rollback                                                              | Makes skill sprawl governable                        |
| C5  | **Connector expansion**: ads/marketing connector design (Ads-Copilot direction), analytics read path, and the SHOPLINE write gate plan (first real write still a separate human confirmation) | Scope depends on user priorities                     |

**Gate for P2:** each skill/MCP addition has: capability-registry state change only with recorded
verification, tests including negative/grounding cases, and a documented cost/risk note.

### P3 — Commerce orchestration OS (weeks 9–14)

Goal: the "workbench" ambition — orchestrated tasks, not just chat.

| #   | Deliverable                                                                                                                                       | Notes                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| D1  | **Orchestration inbox**: tasks/approvals queue, runbooks/templates, scheduled/triggered Studio runs (Queue/worker), retry/idempotency, SLA states | Reuses queue + audit primitives |
| D2  | **Cross-tool workflows**: e.g. audit → gap review → copy proposals → dispatch drafts → reviewer handoff; visible DAG/trace and approvals          | Deterministic steps first       |
| D3  | **Unified home**: workspace overview → inbox → Studio; alerts for budget, stale runs, quality regressions                                         | Replace placeholder overview    |
| D4  | **Multi-workspace administration**: roles/permissions, audit analytics, retention/export, quotas, cost allocation                                 | Admin/owner surfaces + tests    |

**Gate for P3:** end-to-end orchestration acceptance with fake provider + preview connector; security
review of cross-tenant flows; load/soak test.

### P4 — Production maturity (ongoing from P1)

- Feature-flag service and staged rollout policy; backup/restore drills; incident runbooks; secrets
  rotation; dependency/security reviews; model eval harness with live-provider golden sets; cost
  dashboards; SOC-style security review/pen test before any paid pilot expansion.

## Short-term sequence (next 10 tasks)

1. **A1** admin Studio settings API + UI (in progress in a separate worktree).
2. A4 authenticated flags-on acceptance in CI (fixture workspace).
3. A2 production activation runbook automation + preview dry run (needs DB access decision).
4. A5 observability minimum (turn metrics + budget alert).
5. B1 attachment upload end-to-end.
6. B2 copy-proposal apply handoff + export.
7. A3 live model onboarding (credential/budget decision).
8. B4 hosted MCP quotas/rotation.
9. C1 planned skills: `category.map_proposal` (pilot, #153), `product_shot.prepare` (pilot,
   deterministic handoff) and `supplier.intel_proposal` (pilot, linked-workbook finding) are done;
   no skill remains planned.
10. C3 external MCP first provider (decision + approval flow).

Each task ships as its own branch/PR with the repository gates (format, forbidden-runtime,
typecheck, `pnpm test`, integration, production build, Playwright) and a capability-registry update
only when its verification is recorded.

## Decisions required from the user (blocking P0)

1. **Pilot scope**: which workspace(s) and operator/reviewer accounts get Studio first (Opak pilot?).
2. **Provider + budget**: reviewed provider/model and the monthly/run ceilings; provision the
   provider credential in the deployment secret store.
3. **Production database window**: approval to apply additive migrations `0054`–`0056` to the
   production Neon database (required before any flag-on activation) and the rollback plan.
4. **First external MCP / connector**: provider, credential ownership, and whether ads/marketing
   data is the next business priority.
5. **Retention/export policy**: how long Studio threads/outputs are kept, who can export, and
   whether a signed export receipt is required.
6. **Write gates**: confirm the sequence for the first SHOPLINE production write (still separate
   explicit confirmation; Studio only deep-links to review/approval screens).

## Success metrics (pilot)

- **Activation**: pilot workspace enabled; ≥3 operators/reviewers with recorded turns/week.
- **Quality**: ≥95% of model claims resolve to evidence; dropped-field rate visible; <1% turns
  cancelled by deadline/step budgets.
- **Trust**: zero canonical writes without explicit confirmation; `audit:verify` 0 missing/0 foreign
  on every release; every output sign-off/export reproducible from digest.
- **Cost/reliability**: spend per turn within reviewed ceiling; no stuck budget holds; run success
  rate ≥99% for deterministic flows; p95 turn latency within 45 s bound.
- **Operator value**: copy-proposal accept/edit rate, dispatch completion rate, audit export usage.

## Risks and mitigations

- **Model hallucination/ungrounded claims** → deterministic-first, evidence refs, drop/report policy,
  evals with golden fixtures, visible trace.
- **Cost/latency** → reviewed pricing registry, budget holds, 45 s bound, optional streaming with
  honest progress.
- **Tenant/RLS regressions** → `forWorkspace` rule, forced RLS, foreign-id tests, `audit:verify`.
- **Skill sprawl / prompt drift** → versioned skills, prompt-version pins, authoring harness,
  registry states tied to recorded verification.
- **MCP/external security** → disabled by default, allowlists, schema pinning, hashed tokens,
  content-free logs, approval audit.
- **Ops burden** → runbooks, observability, automated acceptance, staged flags, rollback drills.

## Working agreement

- Branch `claude/<topic>`/`codex/<topic>`, PR into `main`, CI on Node 24 green before merge; no
  direct pushes to `main`.
- Production migrations, activation, live provider/MCP calls and SHOPLINE writes stay behind explicit
  user approval and are recorded in `docs/runbooks/`.
- The runbook (`docs/runbooks/conversation-studio.md`) remains the operating source of truth; every
  activation-affecting change updates it in the same PR.

## Progress status — 2026-11-09

- **Done and deployed:** A1 admin settings (#146), A4 flags-on CI acceptance (#147), A5 observability
  (#148), B1 attachment uploads (#149), B2 copy-proposal handoff/exports (#150). Each PR passed CI
  (including the authenticated flags-on Studio browser step) and redeployed production with all
  flags off.
- **In progress:** B4 hosted MCP quotas/rate limits/rotation.
- **Blocked on the user:** A2 production activation runbook + migration window (needs production
  database access approval), A3 live model onboarding (needs a reviewed provider credential/budget),
  C3 first external MCP connection (needs provider choice and credential ownership).
- **Queued:** C1 first planned skill (`product_shot.prepare` / `category.map_proposal`), remaining
  P1/P2 items (merchant-audit v2 period/signed receipt, streaming/progress UX, skill authoring
  harness, connectors).

### Status update — later 2026-11-09

B4 (hosted MCP quotas/rotation, #152) and C1 (`category.map_proposal`, #153) are merged and deployed
with flags off. The A2 preview activation dry run was executed end-to-end on a fresh disposable
database (migrations through 0057, seeded workspace, production build with Studio on, authenticated
acceptance passed, workspace-disable rollback, database dropped) and is recorded in the runbook.
A2 production execution still needs an authorised migration window/credentials; A3 still needs the
reviewed provider credential/budget; C3 still needs a provider/credential-ownership decision.
B3 (merchant-audit periods + signed export receipt) is in progress.

### Status update — later still (2026-11-09)

B3 (merchant-audit periods + signed export receipt, #155), B5.1 (server-side search/filters, thread sharing, a11y, #156), C4 (skill manifest + authoring guide, #157), the signed-receipt read endpoint/UI (#158) and the automated readiness log scanner (#159) are merged and deployed with flags off. All six known post-release P1/P2 gaps are now closed; the full web suite is at 294 files / 2927 tests and each PR pass green CI.

Remaining work is either user-gated (A2 production execution, A3 live model, C3 external MCP) or the next planned phase: P3 orchestration inbox/scheduled runs, B5.2 streaming/long-turn progress, and C2/C5 connector decisions.

### Status update — final hardening pass (2026-11-09/10)

P3.1 (read-only orchestration inbox, #161 + acceptance coverage #162), B5.3 (thread/output offset pagination, #163), the query-level thread-visibility privacy fix (#164) and inbox partial-read resilience (#165) are merged and deployed with flags off. The Studio lists now paginate with filter-preserving links, visibility is enforced in SQL before pagination so private threads never leak or shorten a page, and the inbox degrades per section instead of failing whole-page. The full web suite is at **296 files / 2957 tests**, repository integration at 12/12, and every PR merged green (with occasional unrelated pre-existing e2e flakes rerun).

Remaining work is user-gated (A2/A3/C3) or the next planned phase: P3.2 scheduled/triggered runs and B5.2 streaming/long-turn progress.

### P3.2 design proposal

The next phase (scheduled/triggered Studio runs) now has a reviewed design
proposal: [`2026-11-10-studio-scheduled-runs-design.md`](../specs/2026-11-10-studio-scheduled-runs-design.md).
It compares cron-to-web vs queue/worker execution, proposes a durable
`studio_schedules` + `studio_run_requests` model (migration 0058) with the same
budget/audit/RLS guarantees, and lists the operator decisions required before
implementation (skills, cadences, notifications, cron host, activation window).
No code or schema change accompanies it; implementation starts only after those
decisions.

### C5 design proposal

The ads/marketing connector (Ads-Copilot direction) now has a reviewed design
proposal: [`2026-11-10-ads-marketing-connector-design.md`](../specs/2026-11-10-ads-marketing-connector-design.md).
It recommends a **read-only** external-MCP connection behind a default-off
`STUDIO_ADS_CONNECTOR_ENABLED` flag, reusing schema pinning, encrypted credentials,
quotas and the public-host SSRF guard, plus an `ads.performance_review` skill/artifact
with deterministic evidence and a labelled narrative. All ad-platform writes are out
of scope, and it lists the five operator decisions (provider, credential ownership,
read-only confirmation, data policy, pilot/budget) required before implementation.
No code or schema change accompanies it either.

### C1 product-shot prepare activation (PR #181)

`product_shot.prepare` is now **pilot v1.1.0** as a deterministic prepare/handoff skill (PR #181). It
reads the listing, its source assets and the persisted image-review attempt, then records a
`product_shot_handoff` dispatch with usable source image ids and the current state; it never calls the
provider, mints no signed URL and writes nothing. `assets.list` is executable server-side (and for the
hosted MCP `tools/call`), and the thread renders a read-only handoff card linked to the existing gated
screen. `supplier.intel_proposal` was the only planned skill; C1 is otherwise complete. Still
user-gated: A2 production migration window, A3 live model credential/budget, C3 external MCP decision,
plus the P3.2/C5 operator decisions.

### C3 external-MCP admin workflow (PR #182)

The external MCP admin workflow is now implemented end-to-end, with the transport still disabled by
default: workspace credential binding/rotation/clearing (encrypted `v1.<iv>.<ct>` envelope, plaintext
never returned), an explicit admin probe (`initialize` + `tools/list` only) that reports advertised
schema hashes and drift, and hash pinning before approval. Credential/pin changes bump the generation
and return approved connections to `draft`; every probe writes a digest-only `studio_mcp_calls` row
and a content-free audit event. Probe availability requires the global flag, the workspace Studio row
and the encryption key, but not approval — a draft can be validated first. New endpoints:
`PUT|DELETE /api/studio/mcp-connections/[id]/credential`, `PUT .../schemas`, `POST .../probe`.
No skill or connector calls an approved connection yet. Remaining C3 work is still user-gated: a
provider/credential-ownership decision and the live-acceptance run.

### Template availability follows the skill registry

The Studio home role-template cards now derive their Pilot/Planned/Unavailable label from the
reviewed skill registry instead of a hard-coded snapshot. That corrects stale cards: the five
skills that reached pilot after the first release (`listing.draft_from_sources`,
`product_shot.prepare`, `listing.copy_proposal`, `category.map_proposal`, `merchant.audit`) are now
shown as interactive with their own starter text, `supplier.intel_proposal` stayed Planned (it later
reached pilot in its own change), and the two blocked skills stay Unavailable. Filling a card still
only fills the composer and never sends; the limitation copy on each card now states the shipped
deterministic boundary instead of "not implemented yet".

### Connections page reflects the flag-gated MCP reality

`/studio/connections` no longer hard-codes "hosted MCP is not implemented / planned": it now
derives hosted-MCP (`STUDIO_MCP_SERVER_ENABLED`), external-MCP (`STUDIO_EXTERNAL_MCP_ENABLED`) and
encryption-key presence from the deployment environment, links to `/studio/settings` for token and
external-connection management, and states per-tool execution honestly (read: skills plus the
flag-gated hosted endpoint; propose: advertised but unavailable until a reviewed skill wires it;
dispatch: never exposed over MCP). The page still renders no connect control or connected state.

### Read tool plane completes (`imports.list`, `exports.get`)

Two reviewed read tools were registered and advertised over hosted MCP but always answered
`unavailable`. They now execute on the same workspace-scoped read surface as the other reads:
`imports.list` returns recent source-import receipts (bounded, newest first, id/`received`/received
time only) and `exports.get` returns one export attempt's reviewed state, with reconciliation
reported as `unknown` because no reconciliation read exists yet. This removes the last gap between
the reviewed tool registry and executable reads, so the connections-page read-state copy is true for
every read tool; propose/dispatch tools remain deliberately outside the tool plane.

### C1 completes: `supplier.intel_proposal` pilot (linked-workbook finding)

The last planned skill is now **pilot v1.1.0** as a deterministic finding. The data-linkage question
that kept it planned is resolved by the bulk-form import path: importing a supplier workbook writes
the canonical row (including `supplier`, `brand`, `sku`, `barcode`, `mpn`, `productCost`,
`tradePrice`) into `platform_products.raw_row` and links the source-import receipt, so the turn can
quote stored cells for a listing without a model, a write or a new connector.

The turn reads the listing (`catalog.get`) plus the linked row/receipt through the workspace read
surface, persists a versioned `wukong-supplier-intel/v1` finding with present values and an explicit
missing-field list, and states its boundaries: nothing applied, no supplier record written, and
workspace-level website records excluded because they are not listing-linked. Without a linked row
the turn is partial and saves no artifact. `studio-home` picks the new pilot status up from the
registry, so the supplier template is now interactive with starter text. The authenticated flags-on
CI acceptance now also drives this path end to end (template fill → send → read-only finding with
quoted workbook fields and unknown list → reload → `/studio/outputs`), on a seeded listing whose
canonical workbook row and source-import receipt are linked. That exposed and fixed a pre-existing
server/client boundary bug on `/studio/outputs`: `toOutputStatus` lived in the client output card but
was called by the server page, so any workspace with artifacts got a 500. It now lives in the
server-safe `lib/studio/output-status` module, and a root-suite guard (`tests/client-boundary.test.mjs`,
part of `pnpm test`) scans `apps/web` for any server module that imports a function from a
`"use client"` module and calls it, so the class of 500 cannot silently return. The flags-on
acceptance also carries a route smoke over every Studio surface (home, threads, outputs, inbox,
connections, owner settings), asserting the real heading renders instead of a server error and that
the A5 usage projection appears on settings; and a viewer-role authorization pass (disabled
create/send controls with the honest note, read surfaces available, admin settings rendering the
not-found boundary with no admin content); the A1 settings write path (owner saves a budget and
one allowed skill through `PATCH /api/studio/settings`, reload shows the canonicalised server
readback, fixture values restored); and the **B4 hosted MCP** path with the deployment flag on
(owner mints a read token, a JSON-RPC client calls `initialize`/`tools/list`/`tools/call` over
`POST /api/mcp`, the 3rd call hits the 2/min quota, rotation invalidates the old plaintext, revoke
answers 401), the **B2 copy-proposal handoff** (listing review page renders the read-only
proposal banner from a saved artifact with current/proposed values and no apply control, dismiss
removes the query parameter, unknown id fails closed), the saved artifact's **JSON and PDF
exports** (real downloads carrying the previewed version digest, unsigned receipt without a
signing key, stale digest 409, missing digest 400, unknown id 404), and the **B1 composer
attachment** path (a real PNG uploads through presign → S3 PUT → finalize, an unsupported type is
rejected with the honest reason, and the sent turn persists the finalized asset id across a
reload), and the **draft-from-sources dispatch** (nothing is created before the explicit review and
confirm, the created listing opens in the existing screen, the queue outcome is reported honestly,
and an asset-set replay returns the same listing instead of a duplicate). No planned skills
remain; C1 is complete. Still user-gated: A2, A3, C3 and the P3.2/C5 operator decisions.

### Activation preflight automation (2026-11-12)

The A2 activation helper gained a read-only `--preflight` mode (`scripts/studio-activation.mjs`):
it connects to the reviewed `DATABASE_ADMIN_URL`, proves the Studio schema objects from migrations
`0054`–`0057` exist (tables, quota columns, token-resolver functions) plus the security-relevant
role posture (`wukong_app` must not be SUPERUSER/BYPASSRLS; both lookup roles must be
NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOINHERIT), checks the target user/workspace/membership and reports
the current settings state — with `SELECT` statements only, no writes, sanitised single-line JSON
and exit `2` when the target is not ready. Verified locally against a fresh disposable database:
migrated-empty reported `blocked` with the missing identity, the seeded workspace reported `ready`
with an unchanged settings row, and temporarily making `wukong_app` `BYPASSRLS` turned the same
check into `blocked` until the attribute was restored. CI now runs the same read-only preflight
against the seeded flags-on acceptance database on every build, so schema or role-posture drift
fails the build. This closes the runbook automation half of A2; the remaining step was the real
preview/production dry run, which needed the operator's database-access decision (`--allow-remote`,
admin URL and the reviewed window). That decision was given and the production window was executed on
2026-11-13 (see below).

### Production activation package (2026-11-12)

The operator handoff for the remaining A2/A3/C3 work now exists as
[conversation-studio-activation-package-2026-11-12.md](../../runbooks/conversation-studio-activation-package-2026-11-12.md):
current production posture and smoke status, what is verified and how, the exact deterministic-first
activation sequence (preflight, additive migrations, workspace enablement, deployment flag, authenticated
acceptance), the four decisions only the operator can make, rollback steps and the invariants that stay
true. It performs and changes nothing; every Studio flag remains off. The sequence itself was
rehearsed end-to-end on a fresh disposable database (blocked before migrations, blocked until the
identity existed, ready after seeding, then guarded disable/enable with readback), recorded in the
package. Production execution still needs the A2 database-access decision.

A read-only preview-branch dry run on 2026-11-12 (existing Neon branch
`codex/recovery-rehearsal-20260916`) reported `blocked`: the branch predates the Studio migrations
(no Studio tables/functions, `wukong_mcp_token_lookup` missing), so it needs `db:migrate` before it
can rehearse activation. The same investigation found that preview and production Vercel envs resolve
to the same Neon endpoint, while the only branch-scoped preview override points at a deleted branch:
preview deployments are not isolated and must not be used for mutating rehearsal until a dedicated
branch is configured. Both findings are recorded in section 8 of the activation package.

A dedicated Neon branch (`studio-a2-rehearsal-20261112`) was then created from the `main` snapshot
and the full sequence was rehearsed on it. The first `db:migrate` exposed a real production blocker:
as the non-superuser Neon owner, migrations `0021`/`0055`/`0057` failed with `42501` because they
created lookup-owned functions and then transferred ownership — replay could not work. The fix
creates/replaces those functions **as the owning lookup role** via `SET ROLE` (granting the migration
admin a `SET` membership edge once, revoking the temporary schema `CREATE`), with a `packages/db`
regression test pinning the rule. After the fix: apply green, immediate replay green, preflight
`ready` (`ws_opak`, `operator` membership), plan green, guarded enable and disable both
`outcome:"ok"` with readback. The branch stays migrated and disabled as the preview candidate; the
production endpoint and all deployment flags were untouched.

The activation CLI now also appends a content-free `studio.settings.updated` audit row
(`source: "studio-activation-cli"`, before/after `enabled`) in the same transaction as the settings
write, so the bootstrap enable/disable that happens before the admin API is reachable is still
auditable. Verified on a fresh local database and again on the Neon rehearsal branch (enable + disable,
two audit rows, settings row and audit trail agree). The read-only preflight reports that last
activation as `checks.lastActivation` (`{at, enabled, source}` or `null`) so the window starts from the
known posture; verified against the rehearsal branch's disable row.

### Production deterministic activation executed (2026-11-13)

The operator approved the full deterministic window on 2026-11-13 and it was executed the same day:
the production Neon database received migrations  054– 057 (60 files replayed idempotently, exit
0), ws_opak was enabled with exactly one audited studio.settings.updated row (efore.enabled:null
→ fter.enabled:true, source:"studio-activation-cli"), the resolver functions ended up owned by
wukong_mcp_token_lookup, CONVERSATION_STUDIO_ENABLED=true was added to Vercel Production and
redeployed as dpl_B54p7dNZPvs3MQGLpyRLUga4hagk (Ready, aliased to wukong-ecommerce-os.vercel.app).
Route smoke: /signin 200, /studio 307, / 307, /api/studio/settings 401, /api/mcp 405.
Authenticated owner acceptance is the remaining A2 action; CONVERSATION_STUDIO_AI_ENABLED,
STUDIO_MCP_SERVER_ENABLED, STUDIO_EXTERNAL_MCP_ENABLED and STUDIO_MCP_ENCRYPTION_KEY remain off,
so no model call or external MCP connection has happened. The dated record lives in section 10 of the
activation package.
