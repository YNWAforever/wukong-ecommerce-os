# Conversation Studio implementation results (in progress)

Status: **in progress — P1 and most of P2 implemented and verified locally; no merge, push,
deployment, production migration or live provider/MCP activation.** Last updated 2026-11-08
(Asia/Singapore).

- Branch: `claude/conversation-studio`, base `a12ad1c5` (the `claude/production-recovery-spec`
  checkout, 11 commits ahead of `main`).
- Worktree: `.worktrees/conversation-studio` (gitignored).
- Spec: `docs/superpowers/specs/2026-11-08-conversation-studio-design.md`.
- Plan: `docs/superpowers/plans/2026-11-08-conversation-studio.md`.

## Completed tasks and commits

| Plan task | Commit | Delivered | Verification |
| --- | --- | --- | --- |
| P1 Task 1 — migration 0054 | `a352adf3` | 11 `studio_*` tables, forced RLS + workspace policies, grants, append-only triggers, bounded payload/digest checks, `TENANT_TABLES` additions, Drizzle declarations | Unit schema/audit parity 3 ✅; migration integration 6 ✅ (including full-set replay) |
| P1 Task 2 — repositories | `fbd61938` | Workspace-scoped Studio repositories (threads/messages/runs/events/outputs/versions/budget/settings/MCP/tokens) and workspace-bundle wiring | Repository integration 7 ✅ |
| P1 Task 3 — flags/copy/nav/shell | `8c42027e` | Fail-closed flags, bilingual `STUDIO_COPY`, capability entries, conditional nav item, authenticated `/studio` shell + honest static home, `.env.example` names | 9 scoped files / 98 tests ✅; web typecheck ✅ |
| P2 Task 4 — skill/tool registries | `5a3213c4` | Frozen 10-skill registry, 10-tool registry with strict schemas/roles/capability ids, `getSkill`/`getTool`/`assertToolAllowed`/`skillsForRole` | 30 tests ✅; core typecheck ✅ |
| P2 Task 5 — evidence engine | `2222cd57` | `StudioReadDeps` tool plane, evidence pack with coverage + trace, deterministic composers, `catalog.find` and `catalog.gap_review` skills, needs-input path | 10 tests ✅; web typecheck ✅ |
| P2 Task 8 (port part) — model port | `ae62264b` | `STUDIO_PROMPT_VERSIONS`, reviewed per-turn cost admission, untrusted/no-write prompts, `StudioModel` + fake adapter, prompt/schema tests | 10 tests ✅; core/ai typecheck ✅ |
| P2 Task 6 — turn service + APIs | `63bbf617` | Session/flag gate, read-deps adapter, turn pipeline (idempotent message/run, evidence, deterministic compose, optional grounded model analysis with budget reserve/settle, audit, replay), routes `threads`, `threads/[id]`, `messages`, `runs/[runId]`, `overview`; `@wukong/ai` web dependency + lockfile entry | 94 scoped tests ✅ (49 new); full web typecheck ✅ |

## Verification snapshot (2026-11-08)

| Suite | Result |
| --- | --- |
| `apps/web` Studio tests (flags, copy, capability, nav/layout, shell/home, lib/studio, api/studio) | 17 files / 157 tests passed |
| `packages/db` unit suite (integration excluded) | 30 files / 196 tests passed |
| Studio migration + repository integration (disposable `wukong_studio_test`) | 2 files / 13 tests passed |
| `packages/core` Studio tests | skill/tool 30 + cost 5 passed |
| `packages/ai` Studio tests | 5 passed |
| Typecheck `apps/web`, `packages/core`, `packages/ai`, `packages/db` | all exit 0 |

## Local environment notes

- Docker/Postgres is required for the integration suites; the local compose service is
  `docker compose up -d postgres` (host port `54329`). The cluster needs the runbook's `wukong_app`
  role and a disposable database `wukong_studio_test`.
- Integration environment:
  `STUDIO_TEST_DATABASE_ADMIN_URL=postgres://wukong:wukong@127.0.0.1:54329/wukong_studio_test`,
  `STUDIO_TEST_DISPOSABLE=yes`. The suites refuse any non-local or differently named target.
- In this sandbox Vitest must run with `--pool=threads --no-file-parallelism`; the `.cmd` wrapper
  also breaks on `(app)` path segments, so run `node <repo>/node_modules/vitest/vitest.mjs ...`
  directly.
- The worktree has no `node_modules`; local verification used a gitignored junction farm mirroring
  the parent checkout's package dependencies plus locally rebuilt `dist/` for `core`, `db`, `ai`.
  CI installs normally and is unaffected.
- `pnpm` is not usable in this environment, so the `@wukong/ai` web dependency's
  `pnpm-lock.yaml` importer entry was added by hand in the same commit. A frozen-lockfile install
  must be validated on a machine with working pnpm before merge.

## Deviations and known gaps

1. **No explicit 45 s turn deadline or 6-step tool cap yet.** The committed evidence engine can
   exceed six steps intentionally for a workspace-wide `catalog.gap_review` (search + up to 20
   listings + gaps + jobs); enforcing the spec bound as written would fail that skill. Resolve in
   P6 hardening with either a step budget expressed as read-tool calls (excluding per-listing
   detail) or a documented exception, plus an overall deadline and a bounded workspace-wide listing
   scan.
2. **Send is not one transaction across the model call.** Thread/message/run creation, evidence
   reads, and final persistence are separate `db.forWorkspace` transactions so a 25 s model call
   cannot hold a database transaction. The final persist (assistant message + run completion +
   events + audit) is atomic. This is recorded for spec §3.2 step 9 review.
3. **`@wukong/ai` dependency added to `apps/web`** (typecheck/runtime resolution required) with a
   manual lockfile importer entry; requires the frozen-lockfile check above.
4. **Model analysis (`reply.analysis`) is required-nullable**: `null` = no live model, and
   `configured:false` = model attempted and failed; the deterministic records answer remains valid.
   Grounding drops claims whose `evidenceRefs` do not resolve, and reports `droppedClaims`.
5. **Deterministic skill routing** is keyword-based when the request does not name a skill; planned
   and blocked skills return `400 skill_unavailable`, and a non-empty workspace allowlist is
   enforced.
6. **External MCP** is not implemented yet (`studio_mcp_*` tables and `studio_api_tokens` exist);
   Tasks 12–13 remain pending and disabled by default.

## Remaining plan work

- P2 Task 7: live thread UI (composer send, trace, evidence, model card, overview strip, outputs
  list), consuming the API shapes below; add the emitted copy keys listed in the Task 6 report.
- P3 Task 9: copy-proposal output + review cards + artifact persistence.
- P4 Tasks 10–11: listing-draft dispatch and merchant/SEO audit report.
- P5 Tasks 12–13: hosted MCP server/tokens and the disabled-by-default external MCP registry.
- P6 Task 14: hardening (deadline/step bounds, retention decision), Playwright acceptance,
  capability-registry states, runbook, final results record.

## API shapes for Task 7

- `GET /api/studio/threads` → `{items: ThreadView[], truncated}`; `POST` `{title?, skillKey?}` →
  `201 {threadId}`.
- `GET /api/studio/threads/[id]` → `{thread: ThreadView, messages: MessageView[]}`.
- `POST /api/studio/threads/[id]/messages` body
  `{clientMessageId, text, skillKey?, attachmentAssetIds?, locale}` → `200 {threadId, messageId,
  runId, reply, trace, replayed}`.
- `GET /api/studio/threads/[id]/runs/[runId]` → run metadata + ordered
  `events[].payload:{key,values}`.
- `GET /api/studio/overview` → listing counts + quality + recent jobs, each with an existing deep
  link; never model-priced.
- Errors: `400` invalid body / `unknown_skill` / `skill_unavailable`; `403 insufficient_role` /
  `skill_not_allowed`; `404 not_found`; `409 run_in_progress|run_failed|run_outcome_unknown|
  run_incomplete`.

## Not authorised

No merge to `main`, push, Vercel/Worker deploy, production migration, live model call with a real
provider, external MCP connection or SHOPLINE write. Every feature flag remains default-off.
