# Conversation Studio implementation results (in progress)

Status: **in progress — P1 complete, P2 complete, P5 Task 12 complete; P3, P4, P5 Task 13 and P6
remain.** No merge, push, deployment, production migration or live provider/MCP activation. Last
updated 2026-11-08 (Asia/Singapore), round 3.

- Branch: `claude/conversation-studio`, base `a12ad1c5` (the `claude/production-recovery-spec`
  checkout, 11 commits ahead of `main`).
- Worktree: `.worktrees/conversation-studio` (gitignored).
- Spec: `docs/superpowers/specs/2026-11-08-conversation-studio-design.md`.
- Plan: `docs/superpowers/plans/2026-11-08-conversation-studio.md`.

## Completed tasks and commits

| Plan task | Commit | Delivered | Verification |
| --- | --- | --- | --- |
| P1 Task 1 — migration 0054 | `a352adf3` | 11 `studio_*` tables, forced RLS + workspace policies, grants, append-only triggers, bounded payload/digest checks, `TENANT_TABLES` additions, Drizzle declarations | Unit schema/audit parity 3 ✅; migration integration 6 ✅ (full-set replay) |
| P1 Task 2 — repositories | `fbd61938` | Workspace-scoped Studio repositories and workspace-bundle wiring | Repository integration 7 ✅ |
| P1 Task 3 — flags/copy/nav/shell | `8c42027e` | Fail-closed flags, bilingual `STUDIO_COPY`, capability entries, conditional nav item, authenticated `/studio` shell + honest static home, `.env.example` names | 9 scoped files / 98 tests ✅ |
| P2 Task 4 — skill/tool registries | `5a3213c4` | Frozen 10-skill registry, 10-tool registry with strict schemas/roles/capability ids | 30 tests ✅ |
| P2 Task 5 — evidence engine | `2222cd57` | Tool plane, evidence pack/coverage/trace, deterministic composers, `catalog.find` + `catalog.gap_review` | 10 tests ✅ |
| P2 Task 8 (port) — model port | `ae62264b` | `STUDIO_PROMPT_VERSIONS`, reviewed 2-call budget admission, untrusted/no-write prompts, `StudioModel` + fake adapter | 10 tests ✅ |
| P2 Task 6 — turn service + APIs | `63bbf617` | Session/flag gate, read-deps, idempotent turns/runs, optional grounded model analysis with budget reserve/settle, audit, replay, routes `threads`/`messages`/`runs`/`overview`; `@wukong/ai` web dependency + lockfile entry | 94 scoped tests ✅ |
| P2 Task 7 — live Studio UI | `cfac2ed2` | Renderer ({key,values}→copy with safe fallback), full copy catalogue, `use-studio-session`, shell/home/composer/turn/trace/evidence/overview/thread/connections components, `/studio`, `/studio/t/[id]`, `/studio/threads`, `/studio/outputs`, `/studio/connections`, recent threads in layout, CSS (two-pane, sticky composer, 390 px, focus, reduced motion), Playwright spec with clean skips | 25 files / 232 tests ✅; web typecheck ✅ |
| P5 Task 12 — hosted MCP server | `428b887c` | Migration `0055` SECURITY-DEFINER token resolver (dedicated NOLOGIN/NOBYPASSRLS owner role per 0021 precedent), `Database.lookupStudioApiToken`, `MembershipRepository.findActiveByUserId`, JSON-RPC MCP server (`2026-07-28`) with flag→token→settings→current-membership gates, read/propose scope+role allowlists, 64 KiB cap, 20 s deadline, ledger+audit+last-used, admin token create/list/revoke routes, `wukong-mcp-server` capability → pilot | 32 MCP/token tests ✅; 7 resolver integration tests ✅; web+db typecheck ✅ |
| Fixes | `c60eae77`, `df890a72` | Migration-policy probe accounts for the MCP resolver policy; Studio surfaces brought inside the localisation ratchet (locale-aware not-found, shared loading, unicode-escaped routing keywords, comment cleanup) | integration 20 ✅; `ui-vocabulary` 7 ✅; full web suite clean |

## Verification snapshot (2026-11-08, round 3)

| Suite | Result |
| --- | --- |
| `apps/web` full unit suite (integration excluded) | 257 files / 2579 tests passed |
| Studio web suite (UI/lib/API/MCP) | 25 files / 232 tests passed |
| `packages/core` unit | 27 files / 326 tests passed |
| `packages/ai` unit | 25 files / 426 tests passed |
| `packages/db` unit (integration excluded) | 30 files / 196 tests passed |
| Studio + MCP integration on disposable Postgres (`wukong_studio_test`) | 20 tests passed across migration/repository/MCP-resolver files |
| Typecheck: `apps/web`, `packages/{core,ai,db,shopline,assets,jobs}`, `apps/worker` | all exit 0 |

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

| Plan task | Commit | Delivered | Verification |
| --- | --- | --- | --- |
| P3 Task 9 — copy proposals | `3112b8e8` (core/ai), `1af0132c` (backend), `cf429c11` (UI) | `listing.copy_proposal` skill promoted to pilot v1.1.0; proposer prompt + typed `StudioModel.propose` schema with identity/allowed-field/grounding validation; evidence pack records the exact listing version and current copy as an immutable target; grounded proposal filtering with dropped-field count; versioned output artifact service with canonical digest + readback + audit; `/api/studio/outputs` list/detail and save/sign-off actions (operator save, reviewer sign-off); output/review cards, thread integration, real outputs page, review links; no canonical writes | Core/ai tests 21 + 8 ✅; backend tests (evidence 13, read-deps 14, output service 2, turn service 23, output routes 6) ✅; UI tests 27 new ✅; full `apps/web` suite 272 files / 2676 tests ✅; typechecks clean |
| P5 Task 13 — external MCP | `1ffac55b` | Outbound MCP client (https-only, no redirects, schema-hash pinning, 12 s deadline, 64 KiB cap, content-only projection, zero-fetch when disabled); AES-256-GCM credential envelopes under a new `STUDIO_MCP_ENCRYPTION_KEY`; admin registry lifecycle with audits and fail-closed approval gates; `/api/studio/mcp-connections` routes; admin `/studio/settings` page with token panel, connection panel and tool catalogue; Settings rail link enabled; external MCP stays disabled by default and no call site instantiates the client yet | 81 task tests across 12 files ✅; `packages/ai` + `apps/web` typecheck ✅; no live network call |
| Docs | `87cff226`, this update | Progress/verification record | — |

Verification snapshot after round 3: `apps/web` 272 files / 2676 tests; `packages/core` 326; `packages/ai` 444; `packages/db` 196; typecheck clean for web/core/ai/db/shopline/assets/jobs/worker. Playwright `studio.spec.ts` runs and cleanly skips (2 skipped: flags-off needs `PLAYWRIGHT_E2E=1`, flags-on needs `STUDIO_E2E=1` plus an enabled workspace row). The Studio integration suites (20 tests across migration/repository/MCP-resolver files) were last run green after migration `0055`; a same-session rerun could not connect because the local Docker Desktop engine became unavailable (`ECONNREFUSED 127.0.0.1:54329`). No integration test or migration file changed since that green run; the rerun is recorded as BLOCKED by environment, not failed.

Additional deviations from round 3:
- Copy-proposal sign-off is only enabled for a `saved` artifact (UI-side rule; the backend also allows signing off a draft version, so this can be relaxed deliberately later).
- No live model/provider call or external MCP transport call was made in any verification; the proposer and external client are exercised only through injected fakes.
- The admin settings page reads workspace settings up to three times per render (gate + panel data); acceptable for an admin page, noted for the P6 performance pass.
- Sign-off is a Studio artifact status only, not a SHOPLINE/listing approval and not a publish action.

## Round 4 additions (Tasks 10 and 11, runbook)

| Plan task | Commit | Delivered | Verification |
| --- | --- | --- | --- |
| P4 Task 10 — confirmed listing-draft dispatch | `45a792e3` | `listing.draft_from_sources` pilot v1.1.0; listing intake extracted into `apps/web/lib/listing-intake-service.ts` with `/api/listings` delegating unchanged; `POST /api/studio/dispatch/listing-draft` (operator+, Studio gates, visible thread/run, `confirmed:true`, owned assets only, audit + dispatch trace, honest `queueState`); deterministic draft turns that prepare a card (`reply.dispatch`) with asset validation and `needs_input`/partial states; two-step confirmation dispatch card with run-status polling that stops on terminal state/unmount | Scoped suite green; existing intake routes (4) + replay tests (11) + sharp-bundling guard pass; full web suite 2730 tests |
| P4 Task 11 — merchant/SEO audit report | `423fbbb6` | `merchant.audit` pilot v1.1.0; deterministic report from listing counts, quality projection and export attempts (unread = null/missing, never zero); `createReportOutput()` versioned artifact with canonical digest/readback/audit; `GET /api/studio/outputs/[id]/export?digest=…` canonical `sorted-json-v1` packet with `payloadSha256`, saved/signed-off only, 409 on changed preview/content, foreign 404; report card with tables, evidence, limitations and export link | Scoped suite green; full web suite green; typechecks green |
| Operations | `b8e1e453` | `docs/runbooks/conversation-studio.md`: enablement flags + workspace SQL, model configuration and reviewed-budget admission, hosted MCP token lifecycle, external MCP disabled-by-default procedure, operating/replay rules, deploy/rollback order, verification commands, known limits and escalation | — |

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
