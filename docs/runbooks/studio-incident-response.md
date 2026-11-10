# Conversation Studio — pilot incident response

Scope: the Conversation Studio surfaces described in
[conversation-studio.md](./conversation-studio.md). It assumes the shipped safety posture: every
Studio flag defaults to off, Studio never writes canonical listing data, model input is untrusted
data, logs are content-free, and every mutation writes an audit event.

Two rules override everything below:

1. **Stop and record rather than improvise.** Capture evidence before changing state, and prefer
   turning a flag off to "fixing" a live path by hand.
2. **No production migration, live provider call, external MCP connection, SHOPLINE write or
   activation without the approval gates in the runbook.** An incident does not waive them; it
   usually means pausing the pilot.

## First evidence to collect (all content-free)

- Deployment identity: Vercel deployment URL/commit SHA (`VERCEL_GIT_COMMIT_SHA`).
- The failing request's `x-request-id` if a user saw one; correlate only with event names, never
  with prompt/response text.
- Structured events: `studio.turn.*`, `studio.budget.alert`, `studio_metrics_read_failed`,
  `runtime_not_configured`, and the API error `code` values.
- Database state: Studio rows are workspace-scoped; use `db.forWorkspace`-based tooling or the
  read-only admin surfaces. Never paste row content containing merchant text into tickets.
- Gates: `pnpm logs:scan` (log-safety findings with positions only) and
  `pnpm --filter @wukong/db audit:verify --workspace <id>` where an audit draft applies.

Never copy secrets, provider keys, MCP plaintext tokens, signed URLs, prompts or model output into
incident notes, chat, or commits.

## 1. Suspected unauthorized write or canonical-data change

1. Set `CONVERSATION_STUDIO_ENABLED=false` and, if relevant, `STUDIO_MCP_SERVER_ENABLED=false` /
   `STUDIO_EXTERNAL_MCP_ENABLED=false`; redeploy web (and Worker if it references the same flags).
2. For a single workspace, run `pnpm studio:activate -- --workspace-id <id> --disable --confirm`
   (or flip the admin settings toggle off) so no turn can start there.
3. Preserve, do not mutate: `studio_runs`, `studio_run_events`, `studio_mcp_calls`,
   `studio_api_tokens`, audit rows.
4. Run `audit:verify` for the affected workspace/draft and compare listing versions before/after.
   Studio output sign-off is an artifact state; it is not a listing approval and must not appear in
   the listing audit trail as one.
5. Treat any actual canonical write from the Studio as a release blocker: keep flags off until the
   cause is found and a regression test lands.

## 2. Provider outage, latency or runaway model cost

1. Alerts: `studio.budget.alert` carries `level` (`warning` at 80%, `blocked` at 100%) and
   workspace/run identifiers only. `studio.turn.metrics` reports step counts and durations.
2. Immediate containment: set the admin settings `monthlyBudgetUsd` (and/or `runCeilingUsd`) low, or
   remove the provider from the workspace AI block; the deterministic record answers keep working.
3. Removing the provider key/budget in the deployment secret store is the last resort; it also
   disables unrelated listing automation, so record who authorized it.
4. Unknown/uncertain settlements: runs may stay `outcome_unknown` with the budget row `uncertain`.
   Do not re-run blindly; re-sending the same `clientMessageId` returns the persisted reply instead
   of starting a second run.
5. Re-enable only with an explicit acceptance turn and a recorded spend check.

## 3. Hosted MCP token compromise or abuse

1. Revoke the token on `/studio/settings` or `DELETE /api/studio/tokens/<id>`; rotate via
   `POST /api/studio/tokens/<id>/rotate` when a client must keep working.
2. Audit actions to look for: `studio.mcp.token.created/rotated/revoked/limits_updated`,
   `studio.mcp.call` (tool name, status, latency only — no arguments/outputs).
3. Check `studio_mcp_calls` for `denied`, `schema_drift`, `unavailable` and per-token window counts.
   Quotas are per-token rolling-minute/monthly limits; creation stops at 100 active tokens.
4. The hosted endpoint only exposes `read`/`propose` tools; `dispatch`/write/approve tools are never
   reachable. The creator's current role is re-checked per request, so demoting the creator fails
   the token closed.
5. If abuse continues after revocation, disable `STUDIO_MCP_SERVER_ENABLED` and redeploy.

## 4. External MCP connector incident

1. External MCP is disabled by default and **no call site instantiates the outbound client yet**.
   An approved connection is dormant; there is nothing to call during the pilot.
2. If a connection is suspected: set it to draft/disabled, or disable
   `STUDIO_EXTERNAL_MCP_ENABLED`; credentials are encrypted envelopes and never returned by the API.
3. Endpoints are validated as HTTPS, credential-free and **public-host only** (loopback, private,
   CGNAT, link-local, multicast, reserved and internal names are rejected). DNS rebinding is a
   documented residual risk; add an egress policy or resolve-and-verify check before any live
   connector approval.
4. Preserve the connection row, schema hashes and audit trail before editing the record.

## 5. Authentication, cross-site or authorization anomaly

1. Studio cookie mutations (`/api/studio/*`) reject `Sec-Fetch-Site: cross-site`/`same-site` with
   `403 cross_origin_blocked`; a burst of these is a signal, not a normal user flow.
2. Verify the request resolved a server session and membership; middleware cookie checks are UX only.
   Cross-workspace ids answer 404 by design.
3. Revoke the affected user's sessions through the existing auth surfaces, and rotate any MCP token
   that user created.
4. `private` threads are readable only by their creator and admins/owners; if that invariant is
   suspected broken, capture the query `EXPLAIN` plan and the thread's visibility/creator rather
   than opening the thread content.

## 6. Failed or suspicious production migration

1. Migrations are additive, raw SQL, hash-pinned and applied by `pnpm --filter @wukong/db db:migrate`.
   There is no automatic rollback; a failed migration stops the deployment.
2. Capture the migration ledger rows and the first failing statement; do not edit an applied
   migration file — add a corrective migration.
3. Restoring a database snapshot is a separate, pre-approved operation with its own acceptance run.
   Do not restore as a first response to a UI bug.
4. Web and Worker must deploy together and the listing queue should be drained when prompt versions
   change; see [production-readiness.md](./production-readiness.md).

## 7. Release rollback

1. Turn Studio flags off first (fast, reversible), then roll back the Vercel deployment to the
   previous known-good SHA, then redeploy the Worker if its contracts changed.
2. Record the deployment SHA, the flags changed and the reason; update the release record.
3. Do not roll back a migration with hand-written SQL during an incident.

## 8. Closing an incident

- Evidence pack: deployment SHA, timeline of flag changes, request ids/events, audit action list,
  `logs:scan` result, and the acceptance commands used to re-enable.
- Re-enabling requires the same gates as activation: workspace enablement, flags, and one recorded
  authenticated acceptance turn (`/signin` → `/studio`) with a spend check.
- Add a regression test or a runbook change for whatever the incident exposed; link it in the PR and
  the release record.
