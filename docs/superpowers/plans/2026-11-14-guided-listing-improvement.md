# Guided listing improvement — approved plan (2026-11-14)

## Objective

One listing per journey: workspace audit → selected-listing gap review → copy proposal → reviewer handoff. Explicit Send at every execution step; reload, open, read retries and step selection never make paid calls. Use existing Studio threads, messages, runs, output/version JSON scopes, inbox and listing review. No workflow engine, schema migration, canonical writes, scheduling, batches, assignment/notifications or external connectors.

## PR 1: exact-version review integrity

- Save/sign-off carries expected revision and digest; missing pins and stale previews return reloadable 409. Row-lock the output so validation, status, readback and audit are atomic with respect to version creation. Repeat confirmation of an immutable version is a read-only replay.
- Reset output status to draft on new version. Approval without matching revision/digest audit evidence is unconfirmed and cannot satisfy new guided completion. A legacy signed-off artifact may be explicitly reviewed again.
- New listing links pin output ID, revision and digest. Resolve that version without silently following latest. Compare target listing version; show stale/unavailable/unpinned states, disable copying until current, and block stale sign-off.
- Artifact approval does not apply copy or change listing approval/publish state.

## PR 2: structured context and durable gap reports

- Strict optional `guidedAction` in the existing message contract. Initial audit receives selected listing and expected active version. Later actions name source output/revision/digest. Server-controlled transition map derives skill and scope; conflicting skill, foreign/private sources, stale listing/assessment references fail closed.
- Normalize and persist guided context in operator-message JSON and output-version scope. Compare context on idempotent message retries; changed context under an existing client ID returns 409.
- Persist `gap_report` using existing report service; include listing/version, assessment version, evidence, coverage and limitations. Bump gap-review skill version. Workspace browse omits optional query instead of passing an invalid empty string; guided gap review forwards one listing ID and respects existing limits.
- Audit and gap steps deterministic; only explicit copy-proposal execution may call the existing admitted model. Re-read canonical listing/quality before advancing; unknown remains unknown. No active version blocks copy generation. Keep copy prompts unchanged.

## PR 3: operator/reviewer journey

- Entry from listing screen under existing Studio, role and allowed-skill gates. Show workspace-wide audit versus listing-specific subsequent scope explicitly.
- Compact journey card derives stages and next action from persisted messages/outputs. Next-step controls fill composer and typed context; Send is explicit. Preserve unsent drafts and pending retries; restore after reload without starting work.
- Save proposal, hand off exact link, export through existing controls, reviewer signs off pinned artifact. Keep listing-unchanged wording. Respect privacy and explicit sharing; do not silently widen thread visibility.
- Bilingual, keyboard and 390px browser coverage. Refresh current roadmap status and defer scheduling/connectors to later milestones.

## Verification and release

- Unit and route coverage: role/scope, missing/stale pins, legacy confirmation, changed listing/version, readback identity, no mutation or duplicate audits on repeat requests.
- Disposable local Postgres integration through non-superuser `wukong_app`: forced RLS and output lock/version-append races. No production SQL changes.
- Fake-model authenticated browser: full journey, reload/resume, duplicate submission, draft protection, stale evidence, missing quality, disabled AI/exhausted budget. Reads and deterministic stages make zero model calls; canonical listing remains unchanged.
- Required formatting/type/audit/test CI green before merge, merge commits, exact deployment metadata/alias/routes and post-merge main CI for each PR.
- Preserve OpenCode Go / deepseek-v4.1-flash, USD10 cumulative workspace cap, USD2 run ceiling, 4096 output tokens. No added paid development calls; existing Opak pilot only. External MCP, SHOPLINE writes and activation flags remain unchanged.

## Implementation record

- PR1 shipped as [#223](https://github.com/YNWAforever/wukong-ecommerce-os/pull/223), merge `524e7df2502beb18d242063bf220d8a4f2c4c182`. Exact-head CI [43573276734](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/43573276734) and main CI [43574803391](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/43574803391) passed. Production deployment `dpl_9Py6QqAK9bpUxuuFWruz5RpCouPf` is READY/production and the production alias resolves to that commit; smoke: `/signin` 200, `/studio` 307, `/api/studio/settings` 401.
- PR2 branch: `claude/studio-guided-context`. Guided transitions stay in the source conversation so private context is not widened. Version scopes store root-run, selected-listing/version, exact parent pin and selected-quality fingerprint; changed quality flags invalidate copy generation and sign-off even if the active listing version is unchanged. Completed retries resolve their original run before rechecking live evidence, so they cannot create a second paid run after canonical changes.
- Output confirmations identify immutable reviewed content, not timestamp order: PostgreSQL `now()` is transaction-start time, so concurrent lock waiters cannot safely use latest audit timestamp as status ordering. Match current output status/revision/digest against an audit event carrying that exact tuple.
