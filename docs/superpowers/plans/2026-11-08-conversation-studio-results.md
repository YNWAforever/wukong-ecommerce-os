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
