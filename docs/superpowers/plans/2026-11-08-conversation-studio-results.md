# Conversation Studio implementation results

Status: **implementation complete locally; awaiting explicit user review and approval before any
merge, push, deployment, production migration, live provider call or external MCP activation.**
All plan tasks are implemented and locally verified (unit, route, component and disposable-Postgres
integration suites). Browser-level flags-on acceptance and the frozen-lockfile install remain
BLOCKED in this environment, with exact prerequisites recorded below. Last updated 2026-11-08
(Asia/Singapore), round 4.

- Branch: `claude/conversation-studio`, base `a12ad1c5` (the `claude/production-recovery-spec`
  checkout, 11 commits ahead of `main`).
- Worktree: `.worktrees/conversation-studio` (gitignored).
- Spec: `docs/superpowers/specs/2026-11-08-conversation-studio-design.md`.
- Plan: `docs/superpowers/plans/2026-11-08-conversation-studio.md`.

## Completed tasks and commits

| Plan task                         | Commit                 | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verification                                                                |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| P1 Task 1 — migration 0054        | `a352adf3`             | 11 `studio_*` tables, forced RLS + workspace policies, grants, append-only triggers, bounded payload/digest checks, `TENANT_TABLES` additions, Drizzle declarations                                                                                                                                                                                                                                                                                    | Unit schema/audit parity 3 ✅; migration integration 6 ✅ (full-set replay) |
| P1 Task 2 — repositories          | `fbd61938`             | Workspace-scoped Studio repositories and workspace-bundle wiring                                                                                                                                                                                                                                                                                                                                                                                       | Repository integration 7 ✅                                                 |
| P1 Task 3 — flags/copy/nav/shell  | `8c42027e`             | Fail-closed flags, bilingual `STUDIO_COPY`, capability entries, conditional nav item, authenticated `/studio` shell + honest static home, `.env.example` names                                                                                                                                                                                                                                                                                         | 9 scoped files / 98 tests ✅                                                |
| P2 Task 4 — skill/tool registries | `5a3213c4`             | Frozen 10-skill registry, 10-tool registry with strict schemas/roles/capability ids                                                                                                                                                                                                                                                                                                                                                                    | 30 tests ✅                                                                 |
| P2 Task 5 — evidence engine       | `2222cd57`             | Tool plane, evidence pack/coverage/trace, deterministic composers, `catalog.find` + `catalog.gap_review`                                                                                                                                                                                                                                                                                                                                               | 10 tests ✅                                                                 |
| P2 Task 8 (port) — model port     | `ae62264b`             | `STUDIO_PROMPT_VERSIONS`, reviewed 2-call budget admission, untrusted/no-write prompts, `StudioModel` + fake adapter                                                                                                                                                                                                                                                                                                                                   | 10 tests ✅                                                                 |
| P2 Task 6 — turn service + APIs   | `63bbf617`             | Session/flag gate, read-deps, idempotent turns/runs, optional grounded model analysis with budget reserve/settle, audit, replay, routes `threads`/`messages`/`runs`/`overview`; `@wukong/ai` web dependency + lockfile entry                                                                                                                                                                                                                           | 94 scoped tests ✅                                                          |
| P2 Task 7 — live Studio UI        | `cfac2ed2`             | Renderer ({key,values}→copy with safe fallback), full copy catalogue, `use-studio-session`, shell/home/composer/turn/trace/evidence/overview/thread/connections components, `/studio`, `/studio/t/[id]`, `/studio/threads`, `/studio/outputs`, `/studio/connections`, recent threads in layout, CSS (two-pane, sticky composer, 390 px, focus, reduced motion), Playwright spec with clean skips                                                       | 25 files / 232 tests ✅; web typecheck ✅                                   |
| P5 Task 12 — hosted MCP server    | `428b887c`             | Migration `0055` SECURITY-DEFINER token resolver (dedicated NOLOGIN/NOBYPASSRLS owner role per 0021 precedent), `Database.lookupStudioApiToken`, `MembershipRepository.findActiveByUserId`, JSON-RPC MCP server (`2026-07-28`) with flag→token→settings→current-membership gates, read/propose scope+role allowlists, 64 KiB cap, 20 s deadline, ledger+audit+last-used, admin token create/list/revoke routes, `wukong-mcp-server` capability → pilot | 32 MCP/token tests ✅; 7 resolver integration tests ✅; web+db typecheck ✅ |
| Fixes                             | `c60eae77`, `df890a72` | Migration-policy probe accounts for the MCP resolver policy; Studio surfaces brought inside the localisation ratchet (locale-aware not-found, shared loading, unicode-escaped routing keywords, comment cleanup)                                                                                                                                                                                                                                       | integration 20 ✅; `ui-vocabulary` 7 ✅; full web suite clean               |

## Verification snapshot (2026-11-08, round 3)

| Suite                                                                              | Result                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/web` full unit suite (integration excluded)                                  | 257 files / 2579 tests passed                                  |
| Studio web suite (UI/lib/API/MCP)                                                  | 25 files / 232 tests passed                                    |
| `packages/core` unit                                                               | 27 files / 326 tests passed                                    |
| `packages/ai` unit                                                                 | 25 files / 426 tests passed                                    |
| `packages/db` unit (integration excluded)                                          | 30 files / 196 tests passed                                    |
| Studio + MCP integration on disposable Postgres (`wukong_studio_test`)             | 20 tests passed across migration/repository/MCP-resolver files |
| Typecheck: `apps/web`, `packages/{core,ai,db,shopline,assets,jobs}`, `apps/worker` | all exit 0                                                     |

Playwright `tests/e2e/studio.spec.ts` loads and cleanly skips in this environment (flags-off case
guarded on `PLAYWRIGHT_E2E=1`; flags-on flow needs `STUDIO_E2E=1` plus
`CONVERSATION_STUDIO_ENABLED=true` and an enabled workspace row). A flags-on browser acceptance run
is still to be recorded in P6.

## Local environment notes

- Docker/Postgres is required for the integration suites: `docker compose up -d postgres` (host
  port `54329`), the runbook's `wukong_app` role, and a disposable database `wukong_studio_test`.
- Integration env: `STUDIO_TEST_DATABASE_ADMIN_URL=postgres://wukong:wukong@127.0.0.1:54329/wukong_studio_test`,
  `STUDIO_TEST_DISPOSABLE=yes`. Suites refuse any non-local or differently named target.
- In this sandbox Vitest must run with `--pool=threads --no-file-parallelism`; the `.cmd` wrapper
  breaks on `(app)` path segments, so run
  `node <repo>/node_modules/vitest/vitest.mjs run "<paths>" ...` directly.
- The worktree has no `node_modules`; verification used a gitignored junction farm mirroring the
  parent checkout's dependencies plus locally rebuilt `dist/` for changed packages. CI installs
  normally and is unaffected.
- `pnpm` is unusable here, so the `@wukong/ai` web dependency's `pnpm-lock.yaml` importer entry was
  added by hand. A frozen-lockfile install must be validated on a machine with working pnpm before
  merge.
- Migration `0055` creates a dedicated `wukong_mcp_token_lookup` role. The migration runner needs a
  role with `CREATEROLE` (the recovery runbook's admin URL has it); this must be confirmed in the
  production rollout runbook.

## Deviations and known gaps

1. **No explicit 45 s turn deadline or 6-step tool cap yet.** A workspace-wide `catalog.gap_review`
   intentionally reads beyond six steps; resolve in P6 with a step budget expressed as read-tool
   calls (excluding per-listing detail) or a documented exception, plus an overall deadline and a
   bounded workspace-wide scan.
2. **Send is not one transaction across the model call.** Thread/message/run creation, evidence
   reads and final persistence are separate `db.forWorkspace` transactions so a 25 s model call
   cannot hold a transaction; the final persist is atomic. Recorded for spec §3.2 step-9 review.
3. **Model analysis (`reply.analysis`)** is required-nullable: `null` = no live model,
   `configured:false` = model attempted and failed; ungrounded claims are dropped and counted.
4. **Evidence sources are not persisted with the reply**, so the thread UI can show coverage,
   checks and source deep links derived from check values but not a per-claim source list. Task 9
   should decide whether to persist `pack_sources` on the assistant message.
5. **MCP deviations** (Task 12): hash-first token resolution with prefix cross-check (spec wording
   says prefix-first); JSON-RPC protocol errors return HTTP 200 envelopes while parse/oversize/
   flag/auth use 400/413/404/401; the resolver function needs its dedicated owner role for
   FORCE-RLS correctness; `findActiveByUserId` was added to the membership repository because the
   plan referenced a method that did not exist.
6. **Settings/token admin UI is not built yet.** The rail's Settings item is honestly unavailable;
   Task 12's token lifecycle is API-only. A small token panel belongs with the P6 admin/runbook
   work.
7. **Capability registry**: `wukong-mcp-server` is pilot; `conversation-studio` and
   `conversation-studio-ai` remain planned until the P2/P3 acceptance checks are recorded.

## Remaining plan work

- P3 Task 9: copy-proposal output (needs a structured model proposal step or an explicit
  model-required admission), review cards, artifact persistence/readback, outputs page wiring.
- P4 Tasks 10–11: listing-draft dispatch with explicit confirmation and run-status polling;
  deterministic merchant/SEO audit report + signed export.
- P5 Task 13: admin-approved external MCP registry/client (disabled by default) + settings UI.
- P6 Task 14: deadline/step-bound hardening, retention decision, flags-on Playwright acceptance,
  token admin panel, capability-registry state updates, runbook, final results record, and the
  frozen-lockfile/role-privilege checks before any merge.

## API shapes (live)

- `GET /api/studio/threads` → `{items, truncated}`; `POST {title?, skillKey?}` → `201 {threadId}`.
- `GET /api/studio/threads/[id]` → `{thread, messages}`.
- `POST /api/studio/threads/[id]/messages` → `200 {threadId, messageId, runId, reply, trace, replayed}`.
- `GET /api/studio/threads/[id]/runs/[runId]` → run + ordered trace events.
- `GET /api/studio/overview` → deterministic counts/quality/jobs with existing deep links.
- `GET/POST /api/studio/tokens`, `DELETE /api/studio/tokens/[id]` — admin-only.
- `POST /api/mcp` — host-gated JSON-RPC (MCP 2026-07-28), bearer `wuk_<prefix>.<secret>`.

## Not authorised

No merge to `main`, push, Vercel/Worker deploy, production migration, live model call with a real
provider, external MCP connection or SHOPLINE write. Every feature flag remains default-off.

## Round 3 additions (Tasks 9 and 13)

| Plan task                  | Commit                                                      | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Verification                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3 Task 9 — copy proposals | `3112b8e8` (core/ai), `1af0132c` (backend), `cf429c11` (UI) | `listing.copy_proposal` skill promoted to pilot v1.1.0; proposer prompt + typed `StudioModel.propose` schema with identity/allowed-field/grounding validation; evidence pack records the exact listing version and current copy as an immutable target; grounded proposal filtering with dropped-field count; versioned output artifact service with canonical digest + readback + audit; `/api/studio/outputs` list/detail and save/sign-off actions (operator save, reviewer sign-off); output/review cards, thread integration, real outputs page, review links; no canonical writes | Core/ai tests 21 + 8 ✅; backend tests (evidence 13, read-deps 14, output service 2, turn service 23, output routes 6) ✅; UI tests 27 new ✅; full `apps/web` suite 272 files / 2676 tests ✅; typechecks clean |
| P5 Task 13 — external MCP  | `1ffac55b`                                                  | Outbound MCP client (https-only, no redirects, schema-hash pinning, 12 s deadline, 64 KiB cap, content-only projection, zero-fetch when disabled); AES-256-GCM credential envelopes under a new `STUDIO_MCP_ENCRYPTION_KEY`; admin registry lifecycle with audits and fail-closed approval gates; `/api/studio/mcp-connections` routes; admin `/studio/settings` page with token panel, connection panel and tool catalogue; Settings rail link enabled; external MCP stays disabled by default and no call site instantiates the client yet                                            | 81 task tests across 12 files ✅; `packages/ai` + `apps/web` typecheck ✅; no live network call                                                                                                                  |
| Docs                       | `87cff226`, this update                                     | Progress/verification record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                |

Verification snapshot after round 3: `apps/web` 272 files / 2676 tests; `packages/core` 326; `packages/ai` 444; `packages/db` 196; typecheck clean for web/core/ai/db/shopline/assets/jobs/worker. Playwright `studio.spec.ts` runs and cleanly skips (2 skipped: flags-off needs `PLAYWRIGHT_E2E=1`, flags-on needs `STUDIO_E2E=1` plus an enabled workspace row). The Studio integration suites (20 tests across migration/repository/MCP-resolver files) were last run green after migration `0055`; a same-session rerun could not connect because the local Docker Desktop engine became unavailable (`ECONNREFUSED 127.0.0.1:54329`). No integration test or migration file changed since that green run; the rerun is recorded as BLOCKED by environment, not failed.

Additional deviations from round 3:

- Copy-proposal sign-off is only enabled for a `saved` artifact (UI-side rule; the backend also allows signing off a draft version, so this can be relaxed deliberately later).
- No live model/provider call or external MCP transport call was made in any verification; the proposer and external client are exercised only through injected fakes.
- The admin settings page reads workspace settings up to three times per render (gate + panel data); acceptable for an admin page, noted for the P6 performance pass.
- Sign-off is a Studio artifact status only, not a SHOPLINE/listing approval and not a publish action.

## Round 4 additions (Tasks 10 and 11, runbook)

| Plan task                                     | Commit     | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verification                                                                                                              |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P4 Task 10 — confirmed listing-draft dispatch | `45a792e3` | `listing.draft_from_sources` pilot v1.1.0; listing intake extracted into `apps/web/lib/listing-intake-service.ts` with `/api/listings` delegating unchanged; `POST /api/studio/dispatch/listing-draft` (operator+, Studio gates, visible thread/run, `confirmed:true`, owned assets only, audit + dispatch trace, honest `queueState`); deterministic draft turns that prepare a card (`reply.dispatch`) with asset validation and `needs_input`/partial states; two-step confirmation dispatch card with run-status polling that stops on terminal state/unmount | Scoped suite green; existing intake routes (4) + replay tests (11) + sharp-bundling guard pass; full web suite 2730 tests |
| P4 Task 11 — merchant/SEO audit report        | `423fbbb6` | `merchant.audit` pilot v1.1.0; deterministic report from listing counts, quality projection and export attempts (unread = null/missing, never zero); `createReportOutput()` versioned artifact with canonical digest/readback/audit; `GET /api/studio/outputs/[id]/export?digest=…` canonical `sorted-json-v1` packet with `payloadSha256`, saved/signed-off only, 409 on changed preview/content, foreign 404; report card with tables, evidence, limitations and export link                                                                                    | Scoped suite green; full web suite green; typechecks green                                                                |
| Operations                                    | `b8e1e453` | `docs/runbooks/conversation-studio.md`: enablement flags + workspace SQL, model configuration and reviewed-budget admission, hosted MCP token lifecycle, external MCP disabled-by-default procedure, operating/replay rules, deploy/rollback order, verification commands, known limits and escalation                                                                                                                                                                                                                                                            | —                                                                                                                         |

Verification snapshot after round 4: `apps/web` **278 files / 2730 tests**; `packages/core` 326; `packages/ai` 444; `packages/db` 196; Studio integration **20/20** (Docker Postgres restarted for the run; the engine stops between sessions and must be started with `docker compose up -d postgres` before integration suites); `apps/web` and `packages/core` typecheck clean; sharp-bundling guard 0 failures (3 skipped without a `.next` build).

Round 4 deviations / open decisions:

- Attachment upload UI is still absent: the Studio accepts asset ids from the send contract or UUIDs pinned in the message text. A real upload flow remains a separate task.
- Dispatch confirmation is an inline two-step panel (not a modal dialog); the dispatch body adds optional `runId` and the response adds `replayed` (additive).
- `listing.create_draft` is deliberately not exposed as a tool executor: canonical writes only happen through the confirmed dispatch route.
- The extracted intake service duplicates a small dispatch-outbox loop rather than editing the existing helper (out of that task's file scope); behaviour matches the original and can be unified later.
- Merchant audit v1 has a null period with an honest limitation; export is canonical JSON only (no PDF).
- `merchant.audit` required sources were narrowed to catalog/quality/export_attempt because no canonical SHOPLINE-projection read exists; the report does not claim one.
- Two commits by `studio-ui-builder` were reported as "pushed" in its closing note but no `git push` was performed by any session; the branch is local-only.

Remaining plan work: P6 Task 14 only (explicit deadline/step bounds, flags-on browser acceptance or recorded BLOCKED, capability-registry state updates, final results record, pre-merge checks: frozen-lockfile validation, `CREATEROLE`/role review for migration 0055, Postgres-backed integration rerun, and user-visible review).

## Round 5 (P6 Task 14): hardening, capability states and final acceptance

| Item              | Commit                                     | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6 turn budgets   | `7c14506a` (+ test-fixture fix `2cbaa722`) | `apps/web/lib/studio/turn-limits.ts`: 45 s wall-clock deadline, six first-class tool steps, a separate bounded per-listing detail fan-out (20) and two model calls; every tool/model call asserts the deadline; exceeded turns are persisted as failed runs with `studio_turn_timeout`/`studio_step_budget_exceeded` and surfaced as 503/422, never an unlabelled partial success. Wall clock is injectable for tests.        |
| Capability states | `9f198366`                                 | `conversation-studio` → pilot (deterministic answers, threads, copy proposals, confirmed dispatch, merchant audit verified locally); `studio-output-signoff` → pilot (save/sign-off/export verified locally); `conversation-studio-ai` stays planned because no live provider run has been recorded; `wukong-mcp-server` pilot; `external-mcp-connections` blocked. Descriptions state exactly what was and was not verified. |
| Runbook           | `b8e1e453`                                 | `docs/runbooks/conversation-studio.md` (enablement, model configuration, token lifecycle, external MCP, deploy/rollback order, verification commands, known limits).                                                                                                                                                                                                                                                          |

### Final acceptance record (local; PASS / FAIL / BLOCKED / NOT_RUN)

| Check                                                                                                                       | Result                                                                                                                                                                                                        | Evidence / reason                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature off: nav absent, `/studio` 404, every existing route unchanged                                                      | PASS                                                                                                                                                                                                          | flags/layout/nav unit tests; full web suite regression                                                                                                                                    |
| Deterministic answer with no model, coverage/evidence, honest "model not configured"                                        | PASS                                                                                                                                                                                                          | evidence/composer/turn-service/route tests                                                                                                                                                |
| Model on: every claim resolves to evidence, ungrounded claims dropped, provider failure keeps records answer                | PASS with scripted provider fakes; live provider call **BLOCKED** (no live call authorised/no credentials used)                                                                                               | turn-service tests, ai model tests                                                                                                                                                        |
| Thread/message/trace/output persistence; duplicate send idempotent; no double reservation                                   | PASS for repository/persisted readback and service replay tests; full browser reload **BLOCKED** (no authenticated flags-on fixture)                                                                          | repository integration + turn-service tests                                                                                                                                               |
| Foreign thread/output/token 404/403; cross-workspace reads fail; RLS exercised through `wukong_app`                         | PASS                                                                                                                                                                                                          | migration/repository integration (wrong-workspace insert rejected, foreign rows invisible) + route tests                                                                                  |
| `audit:verify` reports 0 missing actions / 0 accessible foreign records including new tables                                | PARTIAL / NOT_RUN as a CLI gate: `TENANT_TABLES` parity test PASS (every `studio_*` table registered); the full CLI run needs a seeded pilot workspace and an admin URL, which is out of this local-only task | unit parity test; integration RLS probe                                                                                                                                                   |
| Hosted MCP: initialize/list/call, scoped token negatives, ledger + audit                                                    | PASS (protocol/route tests); live external client **BLOCKED** (disabled, no live MCP call)                                                                                                                    | 32 MCP/token tests + resolver integration                                                                                                                                                 |
| External MCP disabled by default; admin approval audit; schema drift/timeout/oversize fail closed; zero fetch when disabled | PASS (unit/route/component tests); live external transport **BLOCKED** (feature disabled)                                                                                                                     | Task 13 suite                                                                                                                                                                             |
| Budget: atomic reserve under concurrency, settle once, unknown keeps hold, monthly cap, pricing drift fails closed          | PASS                                                                                                                                                                                                          | repository integration + turn/service tests                                                                                                                                               |
| zh-Hant/en copy parity, banned-claim scan, no literal-CJK permit slip                                                       | PASS                                                                                                                                                                                                          | copy/parity/localisation-ratchet tests                                                                                                                                                    |
| 390 px layout, keyboard focus, reduced motion                                                                               | PASS for static CSS + unit-rendered states; real-browser a11y **BLOCKED** (no flags-on authenticated browser fixture)                                                                                         | CSS/static review; Playwright spec skips                                                                                                                                                  |
| Preservation matrix: existing routes and roles unchanged with Studio off/on                                                 | PASS                                                                                                                                                                                                          | full web unit suite (279 files / 2737 tests)                                                                                                                                              |
| No prompts/model output/customer content/credentials in logs                                                                | PASS by design review and unit tests (content-free logs, digests only); local readiness-gate scan **NOT_RUN**                                                                                                 | readyness gate requires deployment env                                                                                                                                                    |
| Full `apps/web` unit suite                                                                                                  | PASS 279 files / 2737 tests                                                                                                                                                                                   | run at `2cbaa722`                                                                                                                                                                         |
| `packages/core` / `packages/ai` / `packages/db` units                                                                       | PASS 326 / 444 / 196                                                                                                                                                                                          | run in this round                                                                                                                                                                         |
| Typecheck web/core/ai/db/shopline/assets/jobs/worker                                                                        | PASS (all exit 0)                                                                                                                                                                                             | run in this round                                                                                                                                                                         |
| Studio integration (disposable Postgres)                                                                                    | PASS 20/20                                                                                                                                                                                                    | migration replay, repository contracts, MCP token resolver                                                                                                                                |
| Playwright `tests/e2e/studio.spec.ts`                                                                                       | BLOCKED: 2 skipped                                                                                                                                                                                            | flags-off test needs `PLAYWRIGHT_E2E=1`; flags-on flow needs `STUDIO_E2E=1`, `CONVERSATION_STUDIO_ENABLED=true`, an enabled workspace settings row, seeded auth session and a running app |
| Sharp-bundling guard                                                                                                        | PASS 0 failures (3 skipped without `.next` build)                                                                                                                                                             | `node --test tests/sharp-native-bundling.test.mjs`                                                                                                                                        |

### Pre-merge checklist

| Check                                                                       | Result                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch/worktree clean, all work committed                                   | PASS: `claude/conversation-studio`, 26 commits, clean tree                                                                                                                                    |
| No push, deployment or production migration performed                       | PASS: branch is local-only                                                                                                                                                                    |
| Secret-pattern scan over changed files                                      | PASS: no API-key/credential literals found                                                                                                                                                    |
| Migration replay safety (`0054`, `0055`)                                    | PASS: full-set replay in integration tests                                                                                                                                                    |
| `0055` creates `wukong_mcp_token_lookup`; migration role needs `CREATEROLE` | Documented in the runbook; production role permission review remains an operator step                                                                                                         |
| Frozen-lockfile install (`pnpm install --frozen-lockfile`)                  | BLOCKED: pnpm/corepack are unavailable in this environment; `@wukong/ai`'s web dependency + lockfile importer entry were added by hand. Must run on a machine with working pnpm before merge. |
| Browser flags-on acceptance                                                 | BLOCKED (prerequisites above)                                                                                                                                                                 |
| User review of this branch and the open decisions in the spec/results       | PENDING: required before any merge/deploy                                                                                                                                                     |

### Open decisions for the user

1. Live model activation: which reviewed provider/model + workspace budget, and whether to enable `CONVERSATION_STUDIO_AI_ENABLED` — no live provider call has ever been made.
2. Browser acceptance: provide/enable a flags-on authenticated fixture (or accept the recorded BLOCKED) before merge.
3. Frozen-lockfile validation on a working pnpm environment.
4. Attachment upload UI (currently asset ids/pinned UUIDs only) and whether to add it in a follow-up.
5. External MCP first provider + credential ownership (feature stays disabled until decided).
6. Merge/push/deploy/production migration require explicit approval; all flags remain default-off.

### Final state

Implementation and local verification of every plan task are complete. Nothing was pushed, deployed,
migrated in production or activated against a live provider/MCP/SHOPLINE. The next gate is the
user's review and explicit approval; until then the branch stays local with all feature flags
default-off.

## Round 6 (merge-readiness hardening with a real pnpm install)

| Commit     | Change                                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `6d4b92e9` | `fix(web): use extensionless relative imports so turbopack builds` — 14 build-graph files under `apps/web/lib/studio` (plus two pre-existing web files with the same pattern) used NodeNext-style `.js` relative specifiers that Turbopack cannot resolve. Unit tests and `tsc` resolve them, so this only surfaced in `next build`. |

A local pnpm 11.7.0 was bootstrapped from the registry tarball and used against the committed
`.pnpm-store`:

- `pnpm install --frozen-lockfile --offline --ignore-scripts`: PASS (203 packages; 401-entry
  supply-chain check).
- `pnpm typecheck` and `pnpm lint`: PASS 14/14 each.
- `pnpm --filter @wukong/web build` (Turbopack): **FAILED before the fix, PASS after** — all routes,
  including every `/studio` page and `/api/studio/*` + `/api/mcp`, now compile.
- Re-verified after the fix: full web suite 279 files / 2737 tests; Studio scoped suite 31 files /
  252 tests; typecheck/lint/build clean; Studio integration 20/20 on disposable Postgres.
- `pnpm test` root script remains BLOCKED on this machine: Node 26 fails the pre-existing
  `node --test` root scripts (`ERR_INVALID_ARG_VALUE` in `scripts/benchmark-opak-maintenance.mjs`)
  before Studio code runs; CI uses the pinned Node 24. Per-package direct vitest results: web 2737,
  core+ai 770, db 196, assets 82, shopline 287, jobs 53; worker 419 tests pass in 33 files with 11
  environment-dependent collection failures (wrangler/workerd runtime not present under plain
  Node 26 vitest).

The earlier per-round acceptance matrix still stands; this round only sharpened the merge evidence
and fixed the production-build defect. Nothing was pushed, merged into `main`, deployed or activated.

## Round 7 (Node 24 CI-equivalent verification)

A portable **Node 24.22.2** was downloaded from nodejs.org and used with the locally bootstrapped
pnpm 11.7.0 and the repository's offline store. Results on the project's pinned runtime:

- `pnpm install --frozen-lockfile --offline --ignore-scripts`: PASS.
- `pnpm typecheck` / `pnpm lint`: PASS 14/14 each.
- `pnpm --filter @wukong/web build` (Turbopack): PASS (all `/studio` routes and APIs compile).
- Root `node --test` suites (the exact root-script list): **145 tests PASS**.
- Direct per-package vitest (threads pool, 0 failed): web **2763 passed / 11 skipped**; core 326;
  ai 444; db 196; assets 82 (+1 skip); shopline 287; jobs 53; worker 419.
- Studio integration on disposable Postgres: **20/20 PASS**.

The exact `pnpm test` root command still cannot run in this sandbox: its `turbo run test` step
spawns Vitest's default forked workers and fails with `EPERM ... mkdir ...\ssr`. This is a sandbox
worker-spawn limitation, not a test failure — every package suite passes under Node 24 with
`--pool=threads --no-file-parallelism`. A normal Node 24 CI runner is the remaining confirmation.

Merge readiness is otherwise green; nothing was pushed, merged into `main`, deployed or activated.

## Round 8 (flags-on browser acceptance — PASS)

The last browser-level BLOCKED item was cleared with a real Chromium session against a production
build (Node 24, real pnpm install) on a disposable local Postgres database. Only
`CONVERSATION_STUDIO_ENABLED=true` was set; `CONVERSATION_STUDIO_AI_ENABLED`, every MCP server/flag
and SHOPLINE remained off, and no live provider/MCP call was made.

**Flow verified end-to-end:** password sign-in → `/studio` home ("Start a conversation", workspace
overview "From workspace records; no AI call") → send the records question `margaux` → thread page
with operator turn, deterministic `catalog.find` answer (`Answered`, "Sources present: 3; missing:
0", checks table, open-source links), follow-up questions, "Execution trace · 2 steps", and the
honest "AI suggestion · unverified / Live analysis is not configured" card → full reload restores
the same thread URL and content from Postgres → 390 px viewport has no horizontal overflow → the
conversation appears on `/studio/threads`.

Backend evidence from the same run (local DB, workspace `ws_studio_browser_e2e`): 2 threads,
4 messages, 2 `succeeded` runs, audit events `studio.thread.created` ×2,
`studio.message.received` ×2, `studio.run.completed` ×2.

| Artifact                       | Path                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Gated acceptance spec          | `tests/e2e/studio-browser-acceptance.spec.ts` (`STUDIO_BROWSER_ACCEPTANCE=1`) |
| Local seed fixture             | `tests/e2e/studio-browser-acceptance-seed.mjs`                                |
| Screenshot (390 px, full page) | `docs/superpowers/plans/assets/2026-11-08-studio-browser-acceptance-390.png`  |
| Reproduction steps             | `docs/runbooks/conversation-studio.md` § Local flags-on browser acceptance    |

This supersedes the BLOCKED browser rows in the round-5 acceptance record and the merge-readiness
document: flags-on browser acceptance is now **PASS** locally, with the exact prerequisites
committed. Two notable environment findings: (1) sign-in eligibility requires a
`workspace_invites` row in addition to user/credential/membership; (2) `next dev` (Turbopack,
development export condition) cannot compile workspace package sources because of their NodeNext
`.js` relative specifiers — a pre-existing dev-server limitation, so acceptance runs against
`next build && next start`; the production build is unaffected.

## Round 9 (pre-merge static gates and formatting)

Ran the remaining repository release gates locally under Node 24 with the bootstrapped pnpm:

| Gate                                       | Result                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm release-gate:check` (automated half) | **PASS** — 6 automated checks (Node 24/pnpm 11.7 pin, separates Neon runtime/admin roles, production-built Playwright, exact synthetic Opak draft audit wiring, preview `SHOPLINE_ADAPTER=mock`, production acceptance disabled). The 14 human-sign-off items remain by design. |
| `pnpm runtime:forbidden:check`             | **PASS** — 9 manifests / 602 source files checked, 0 forbidden dependencies/imports/files/services.                                                                                                                                                                             |
| `pnpm format:runtime:check`                | **FAILED on the Studio contribution (94 files), then PASS after `prettier --write`** on exactly the flagged files. No semantics changed; re-verified typecheck/lint, Studio scoped suite, core/ai/db units afterwards.                                                          |

`audit:verify` against a real draft was **NOT_RUN**: the gate requires the exact synthetic Opak
lifecycle draft produced by the real-stack fixture, and the local database used for browser
acceptance contains Studio activity only. Fabricating audit events would invalidate the gate, so it
must run on a seeded pilot workspace or via the real-stack fixture before sign-off. The CLI itself
and its unit coverage are part of the suite; the Studio migrations' RLS/audit-parity checks already
pass in the integration suite.

Post-format re-verification: `pnpm typecheck` 14/14, `pnpm lint` 14/14, Studio scoped suite 31 files
/ 252 tests, `core`+`ai` 770, `db` (unit) 196 — all pass.

## Round 10 (CI, merge, production deployment) — 2026-11-09

**Pull request:** [#143](https://github.com/YNWAforever/wukong-ecommerce-os/pull/143), merged with merge
commit `87459d83` after CI run `42506384584` passed in 25m19s.

CI verified on Node 24 with a real frozen install, including: format/forbidden-runtime gates, build,
migrations, lint, typecheck, **`pnpm test`** (the exact root unit command), all Opak integration
regressions, **production build**, real-stack Playwright (including the Studio flags-off nav/404
acceptance), **`audit:verify` against the synthetic Opak draft**, and the wine/Queue acceptance.
Two real defects surfaced only in CI and were fixed in the branch before merge:

- `9645fbee` — the existing foreign-key inventory test pinned the full FK list and requires every
  composite tenant FK to be indexed; Studio added eight FKs without two covering indexes. Migration
  `0056_studio_fk_indexes.sql` adds `studio_outputs(workspace_id, run_id)` and
  `studio_runs(workspace_id, trigger_message_id)` indexes, and the pinned inventory was extended.
- `cfe87d2b` — the flags-off browser test lazily imported the real-stack fixture; under CI Node's
  strip-only TypeScript loader the dynamic import failed on the fixture's parameter properties.
  It now imports the fixture statically like every other real-stack spec.

**Production deployment:** Vercel production deployment
`https://wukong-ecommerce-fsoeyw4vp-ynwaforevers-projects.vercel.app` (Ready, 1m build), serving on the
project alias `https://wukong-ecommerce-os.vercel.app`. Smoke checks on the alias:
`/signin` 200, `/` → `/signin?callbackUrl=%2F`, `/studio` → `/signin?callbackUrl=%2Fstudio`
(flags still off), Studio APIs 401 unauthenticated, `POST /api/mcp` 404 (hosted MCP flag off).
Deployment-specific log scan: 50 recent production log lines fetched with `vercel logs`; 0 matches
for OpenAI-style keys, bearer tokens, Postgres URLs, AWS signatures, password/API-key fields,
SHOPLINE token prefixes or prompt-injection markers. The human sign-off item still stands: this is an
automated scan of recent logs, not a person's complete review.

**Live activation remains intentionally not performed.** Production env names contain no
`OPENCODE_GO_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` and no Studio feature flags; enabling the
(deterministic) Studio would additionally require applying migrations `0054`–`0056` to the production
database, inserting/updating the pilot workspace's `studio_workspace_settings` row, setting
`CONVERSATION_STUDIO_ENABLED=true` and redeploying, plus an authenticated production acceptance run
(no production user credentials are available here). Live model activation is impossible without a
provider credential. All flags remain off; the release gate's first-real-write confirmation was not
touched.

## Post-release development (roadmap P0/P1) — 2026-11-09

The Studio is merged and deployed with all flags off. Subsequent development follows
`docs/superpowers/plans/2026-11-09-next-development-roadmap.md`; each item ships as its own PR with
the full repository gates (CI on Node 24, including the flags-on Studio browser acceptance step).

| Roadmap item                     | PR   | Delivered                                                                                                                                                                                                                                                                                            | Verification                                                                                                                             |
| -------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A1 admin workspace settings      | #146 | Admin GET/PATCH Studio settings API (enable, pilot skills, budgets, retention, default home, validated all-or-none AI block via the reviewed cost registry), audit + DB readback, editable settings card with honest states, bilingual copy                                                          | Full web suite 282 files / 2761 tests; scoped 76; typecheck/lint/format clean; CI green                                                  |
| A4 flags-on acceptance in CI     | #147 | New CI step seeds a pilot workspace, starts the production build with `CONVERSATION_STUDIO_ENABLED=true` (AI/MCP unset), runs the full sign-in → answer → trace → reload → 390 px acceptance on port 49300; seed fixture made idempotent and root-resolvable                                         | Step passed in real CI (18m27s), and every later PR run re-validates it                                                                  |
| A5 observability                 | #148 | Content-free `studio.turn.metrics` per turn (status/duration/bounded counters/trace/output/limitations/settled USD or safe failure code) and `studio.budget.alert` at 80%/100% of the workspace cap; best-effort emission; runbook section                                                           | New observability suite 7 tests + turn-service metric/alert tests; full web suite 283/2771; CI green                                     |
| B1 attachment uploads            | #149 | Composer attach control wired to the reviewed presign → PUT → finalize stack with shared media policy (JPG/PNG/WebP/PDF, 20 MiB, 8 files); per-file chips with remove/retry, send blocked while uploading, finalized `attachmentAssetIds`, failure keeps draft + reusable ids                        | Full web suite 284/2792; one CI-only timing flake in an upload test fixed by waiting on real macrotasks; CI green                        |
| B2 copy-proposal handoff/exports | #150 | `format=pdf` server-rendered export alongside the unchanged canonical JSON; review-card per-field/all copy with digest-gated JSON/PDF links; read-only `?studioOutput=<id>` handoff banner on `/listings/[id]` that fails closed on every invalid/foreign/mismatched case and never seeds form state | Full web suite 287/2820; scoped 86; PDF round-trip tests; CI green on rerun (first attempt hit an unrelated pre-existing Opak e2e flake) |

Production redeploys from `main` after each merge; alias smoke checks (`/signin` 200, `/` and
`/studio` → sign-in, `POST /api/mcp` 404) remain green with every Studio flag off. Still blocked on
user inputs: A2 (production DB migration window), A3 (provider credential/budget), C3 (first external
MCP provider/credential ownership). B4, C1 and the broader P1/P2 list remain in progress/queued.
