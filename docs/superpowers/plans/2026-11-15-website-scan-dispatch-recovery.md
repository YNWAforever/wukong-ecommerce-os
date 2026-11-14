# Website-scan dispatch recovery

Date: 2026-11-15 (Asia/Singapore)
Status: implementation authorized by the operator's selection of Website-scan retry recovery.
Base: main `2666e79e8f137f9410999140de64feaef2ddb1f2`.

## Evidence and outcome

CI run 43589445749 attempt 1 passed the Studio acceptance gate but its existing website partial-preview replacement test timed out. The retained page snapshot showed a replacement scan still queued, the previous preview disabled, and `website_scan_unavailable`. Attempt 2 on the unchanged commit passed; this establishes intermittent dispatch failure, not its underlying network cause.

The create endpoint currently catches enqueue errors, records `failed` dispatch, and returns the durable queued scan. The UI continues polling but offers no dispatch retry while state is queued/running. The existing sweeper can recover eligible scans later, but operators and browser fixtures cannot depend on its execution within their interaction window.

Add an explicit delivery retry for the same persisted scan and revision. Preserve original URL, request key, deadline, bounded checkpoint and prior preview. A new scan remains a distinct explicit action after a completed/expired scan. Public website evidence remains read-only and ineligible for platform export/delivery.

## Implementation

1. Share a small deterministic dispatch-eligibility rule between the repository and public projection. Active leases, future eligibility, recently pending/sent dispatches and terminal states cannot be retried. Existing one-minute stale-dispatch recovery and original deadline remain authoritative. Expose only bounded recovery state and the revision/dispatch-attempt fence, never request keys, lease tokens or workspace identity.
2. Atomically claim a delivery attempt using the existing dispatch status/time/counter fields and a row lock, matching expected revision and attempt counter. Commit before network I/O. Only the winner sends. Record actor/audit and conditionally finish the exact claimed attempt; read back persisted state instead of returning an optimistic stale copy. Use this path for initial create/replay as well as explicit retry.
3. Add a session-scoped operator POST under the scan ID. Its strict body contains the expected revision/attempt, not a URL or workspace ID. Unknown/foreign scans are unavailable; stale or noneligible attempts cause no send. Both known rejection and transport uncertainty can only resend the same job identity; document leases and cached completion protect against at-least-once delivery.
4. Add bilingual delivery-retry/expiry guidance and a separate retry button. Reads/reloads never dispatch. Retry preserves the previous preview and disabled selection until the replacement completes. Preserve latest-response/abort fences and suppress duplicate clicks. A failed/lost response refreshes recorded state before another explicit retry.
5. Emit only bounded ingress reason/status metadata; never raw errors, URLs, headers, credentials or product content. Add deterministic failure/recovery browser coverage and retain bounded relevant diagnostics.

No schema migration, new queue, cron schedule, provider call, credential change, connector activation, pricing change or generic workflow engine. Avoid Worker changes if its existing document lease/replay contract suffices; validate that contract with its tests.

## Verification and release

- Baseline: 74/74 existing website API, panel and scan-service tests passed before changes.
- Test concurrent/replayed claims, stale completion/revision, successful progression during dispatch, active lease/deadline, foreign workspace and insufficient role. Use restricted-role disposable PostgreSQL for repository/RLS tests.
- Test initial enqueue failure, known rejection and lost response, same-identity retry, no automatic POST on reload, retained prior preview, expiry and bilingual/narrow-screen behavior. Duplicate Queue delivery must not repeat a completed document fetch or saved observation.
- Keep source transport SSRF/redirect/robots safeguards and existing extraction/save tests green. Use fake HTTP and injected enqueue failures only.
- Run relevant types, build, formatting, forbidden-runtime and audit gates; ship through a green exact-head PR and verify its exact production deployment, routes and post-merge main CI.

## Local verification

- 274 web website/ingress unit checks and 18 core website/policy checks passed.
- 22 repository integration checks passed through a fresh local non-superuser role with inherited application grants and forced RLS.
- Six signed website-orchestration integration checks passed in another isolated local database, including initial transport uncertainty → explicit same-identity retry → stale replay rejection → duplicate delivery without another public-document request.
- Six bounded HTTP/TLS transport integration checks, existing consumer/sweeper checks, and 30 CI/diagnostic contract checks passed.
- Full web types and the pinned TypeScript 5.9 browser-spec check passed. The orchestration fixture provides complete typed Worker bindings and fails closed if unrelated bindings are accessed. Final committed format checks and exact-head browser/release CI remain release gates.
- No production data, paid provider, connector setting, existing local test database or credential was changed. Local PostgreSQL fixtures used separately named disposable databases and roles.

Cloudflare references retrieved for this work: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ and https://developers.cloudflare.com/queues/configuration/javascript-apis/ . Queues guarantee at-least-once delivery, so scan/revision identity and database document claims remain the correctness boundary.
