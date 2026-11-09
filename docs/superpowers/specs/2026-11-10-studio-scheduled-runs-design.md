# Studio scheduled and triggered runs — design proposal (P3.2)

Status: **proposed** — no code, schema or deployment change accompanies this document.
Date: 2026-11-10. Owner: Studio roadmap (P3). Read with the
[Conversation Studio design](2026-11-08-conversation-studio-design.md) and the
[next development roadmap](../plans/2026-11-09-next-development-roadmap.md).

## 1. Why

Conversation Studio today answers an operator's message synchronously and, for
artifact-producing skills, persists a versioned output for human review. The next
orchestration phase is to run the same reviewed skills **without a human in the
message loop** at pre-agreed times or events, while keeping every existing safety
property: read-only skills, reviewed budgets, deterministic evidence first,
versioned outputs, human apply/sign-off, append-only audit and no unreviewed
write authority.

This document proposes a phased design and lists the decisions the operator must
make before implementation. Nothing here authorises a live provider or SHOPLINE
call.

## 2. Goals

1. A workspace admin can create a schedule such as "merchant audit every Monday
   09:00 HKT" or "gap review for listings approved in the last day".
2. Each occurrence runs one reviewed Studio skill through the same turn service
   used by the chat surface (same evidence pack, budgets, prompt pins, output
   artifact, audit).
3. Runs are idempotent per `(schedule, occurrence)`; a retried delivery never
   creates a second artifact or a second budget reservation.
4. Operators see scheduled runs and their artifacts in the existing inbox /
   outputs centre, with an honest status (queued/running/succeeded/failed/
   skipped/budget-exhausted/needs-attention).
5. Missing input or unreadable sources produce a `needs_input`/partial output with
   honest limitations, never a silent guess.
6. Every run is attributable to a service principal and the schedule that caused
   it; the audit trail can answer "who/what ran this and why".

## 3. Non-goals

- No autonomous apply: scheduled runs cannot publish to SHOPLINE, sign off their
  own output, or change listings. Operator action stays in the existing review
  surfaces.
- No customer-facing automation and no external MCP writes.
- No new skills; only `pilot` skills may be scheduled (same status gate as chat).
- No change to the synchronous Studio chat path in phase 1.

## 4. Constraints from the existing architecture

- **Execution runtime.** Studio turns run in the Next.js web app (`apps/web/lib/
studio/turn-service.ts`) with session-derived workspace context. Cron/manual
  triggers must not impersonate a browser session; they need a service principal
  plus an explicit workspace context.
- **Queue worker.** `apps/worker` already consumes Cloudflare Queues with
  idempotent leases (`listing:<workspace>:<draft>:<sequence>`), Hyperdrive DB
  access and HMAC ingress. The Worker cannot currently call the web turn service
  (Next.js server code is not a Worker module) — either the Worker gets a shared
  run executor, or scheduling triggers the web app through a signed internal
  endpoint.
- **Budgets.** `studio_turn_reservations` / `studio_workspace_settings` enforce
  reserve→settle with a run ceiling and monthly budget. Scheduled runs must use
  the same admission; they cannot bypass budget because "nobody was watching".
- **Audit + RLS.** All mutations go through workspace-scoped repositories and
  audit events; the append-only tables have triggers. New tables need the same
  forced-RLS grants, indexes and audit coverage as migrations `0054`–`0057`.
- **Flags.** Deployment flags (`CONVERSATION_STUDIO_ENABLED`, AI flag) stay
  fail-closed; scheduling adds its own flag (default off) and a per-workspace
  enable switch.
- **Provider keys.** Live schedules require the reviewed provider credential and
  budget (currently blocked A3). Until then, a scheduled run must be exercisable
  with the fake/deterministic path only.

## 5. Options considered

| Option                                      | How                                                                                                                                                                                          | Pros                                                                                              | Cons                                                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Cron Trigger → signed web endpoint**   | Cloudflare Cron Trigger or Vercel Cron calls `POST /api/internal/studio/schedules/tick` with an HMAC service token; the web app claims due schedules in the DB and executes turns in-process | Reuses the exact web turn service, budgets, prompt pins and output service; smallest code surface | Long turns risk request timeouts; tick overlap needs DB claims; need service-token rotation and a bounded work window                                                             |
| **B. Cron → Queue → Worker → web executor** | Cron enqueues one message per due schedule; the existing Worker consumes, enforces idempotency and calls a shared executor library                                                           | Better retry semantics and observability; uses existing idempotent queue pattern                  | The turn service depends on web-only deps (assets, provider adapters, Next runtime); extracting a worker-safe executor is a large refactor (skills/evidence in `packages/*` only) |
| **C. Manual dispatch only (no schedule)**   | Inbox/CLI "run now" creates a queued request; an operator triggers execution                                                                                                                 | No cron/service identity; fastest to land                                                         | Does not satisfy the "scheduled" goal; still needs service principal + queue/claiming                                                                                             |

**Recommendation:** phase 1 = **C as the trigger substrate + A as the scheduler**:
add a durable `studio_run_requests` table and a "Run now" action first (manual,
operator-triggered), then a cron tick that creates the same request rows and
executes them through the web turn path with DB claims. This keeps the turn
service as the single executor and avoids a Worker refactor. Revisit B only when
turn duration consistently exceeds the web request budget.

## 6. Proposed schema (phase 1, migration `0058`)

Names are proposals; the review will refine columns before any migration lands.

```sql
create table studio_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  skill_key text not null references studio_skills? -- skills are code, keep text + app validation
  skill_version text not null,
  inputs jsonb not null default '{}'::jsonb,      -- listingId filters, question, etc. (no secrets)
  cadence text not null check (cadence in ('hourly','daily','weekly','monthly')),
  timezone text not null default 'Asia/Hong_Kong',
  hour smallint not null check (hour between 0 and 23),
  weekday smallint check (weekday between 0 and 6),
  enabled boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  next_run_at timestamptz
);

create table studio_run_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references workspaces(id) on delete cascade,
  schedule_id uuid references studio_schedules(id) on delete set null,
  skill_key text not null,
  skill_version text not null,
  inputs jsonb not null,
  idempotency_key text not null unique,          -- e.g. schedule:<id>:<occurrence ISO>
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','budget_exhausted','needs_input','cancelled')),
  requested_by_actor text not null,              -- 'service:studio-scheduler' or user id
  run_id uuid references studio_runs(id) on delete set null,
  output_id uuid references studio_outputs(id) on delete set null,
  attempt_count int not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
```

- Forced RLS and workspace-scoped grants for both tables; append-only audit
  events `studio.schedule.created/updated/disabled` and
  `studio.run_request.queued/claimed/finished`.
- Workers claim by `update ... where status='queued' and workspace_id=... returning *`
  with a lease; the existing `run_events` trace records execution.
- Idempotency is enforced by the unique key, matching the queue convention.

## 7. Execution flow (phase 1)

1. Cron tick (`*/5 * * * *`) with a service HMAC calls the web route; it is
   disabled unless `CONVERSATION_STUDIO_SCHEDULING_ENABLED=true`.
2. Tick claims due `studio_schedules` (`next_run_at <= now()`, enabled) in a
   workspace-scoped transaction and inserts `studio_run_requests` with the
   idempotency key `schedule:<id>:<occurrence>`; it advances `next_run_at` and
   never executes more than a bounded batch (e.g. 5).
3. A request executor claims one queued request (lease), resolves the workspace
   service principal, calls the same turn service with a synthetic operator
   message generated from the schedule (e.g. "Run scheduled merchant audit for the
   last 30 days"), and records run/output ids.
4. On completion/failure it updates status, writes audit, and leaves artifacts in
   the existing outputs centre for human review.
5. Budget admission is the normal reservation path; exhausted → `budget_exhausted`
   status, no model call, honest notice.

Timeouts: each tick processes at most a few requests within the web request
budget; leftover requests stay queued for the next tick. AI-off environments run
deterministic skills only; AI-enabled schedules require A3.

## 8. Security and safety invariants

- Service principal `service:studio-scheduler` is not a user; it can only create
  run requests, never sign off, apply, publish or edit settings.
- Schedules are created only by workspace admin/owner, audited; disabled by
  default and require the feature flag plus workspace settings.
- Inputs are validated against the skill contract; no free-form tool authority
  and no external MCP writes.
- Every occurrence is budgeted; scheduling cannot raise `monthly_budget_usd` or
  `run_ceiling_usd`.
- No customer content or provider payload in logs; the readiness log scan must
  stay clean after the first scheduled runs.
- Dry-run mode prints the due schedules and synthesized messages without calling
  a model; acceptance tests use the fake provider.

## 9. Rollout plan

1. Migration `0058` + repositories/services/tests (no routes).
2. Admin "Schedules" UI on the existing settings surface + audits + "Run now"
   action (manual, operator-triggered) — validates the executor before cron.
3. Cron tick endpoint behind the flag, dry-run mode first, then fake-provider
   acceptance in CI; production activation only after A2/A3 are resolved and the
   operator approves the cadence list.
4. Observability: scheduled-run metrics (`queued`, `succeeded`, `failed`,
   `budget_exhausted`) in the existing Studio events; add them to the inbox.
5. Rollback: disable the scheduling flag and cron; queued requests can be
   cancelled; schedules remain stored but inert; migrations are additive.

## 10. Decisions required from the operator

1. **Which skills may be scheduled first?** Proposal: `merchant.audit` (read-only
   report) and `catalog.gap_review` (read-only) only.
2. **Cadences/triggers in scope for v1:** proposal: weekly + monthly time-based
   only; event triggers (listing approved → audit) in phase 2.
3. **Service identity and notification:** where do scheduled-run results go —
   inbox only, or also email/Slack? What budget ceiling applies to scheduled
   runs separately from chat?
4. **Cron host:** Cloudflare Cron Trigger (consistent with the Workers stack) vs.
   Vercel Cron; both call the same signed endpoint.
5. **Activation window:** scheduling in production should follow A2 (migrations +
   workspace enablement) and A3 (provider credential/budget) rather than precede
   them.

## 11. Estimated scope

| Piece                                                     | Size      |
| --------------------------------------------------------- | --------- |
| Migration 0058 + repository + RLS/index/audit tests       | ~1–2 days |
| Service `requestRun`/executor + idempotency/lease + tests | ~2–3 days |
| Scheduler tick route + cron config + HMAC/flag            | ~1 day    |
| Admin schedules UI + "Run now" + copy                     | ~2 days   |
| Fake-provider acceptance + CI step + docs                 | ~1–2 days |

Implementation should start only after decisions 1–4 are answered; decision 5
gates production execution, not the development work.
