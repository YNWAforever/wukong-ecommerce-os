# Final audit — Phase 1 findings (2026-10-05)

**Baseline:** PR #121 head `84006670` (`codex/opak-runtime-recovery`), as approved
at Gate 0. PR #120 is treated as superseded. Line references are to `84006670`.
The **Where** tag says whether the defect already exists on `main` (`dde9e178`)
or was introduced by #121. Every finding below except L9 is already on `main`,
and #121 changes almost none of the affected files (churn table at the end), so
fixes can branch from `main` with little conflict risk.

**Method.** I read the code in a detached worktree of `84006670` and ran a
disposable Postgres 17 (loopback port 54395) with the real migrations
`0000`–`0053` applied twice. Live catalog queries back the RLS, grants, index
and SECURITY DEFINER claims. CI for `84006670` is green
([run 37256972923](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/37256972923),
`verify` 24m11s, attempt 2 after #121's known wine-acceptance flake). I did not
re-run the full suite.

Skills applied: `ecc:code-review` (the fallback, because `ecc:orch-review` needs
a Workflow tool this environment lacks), `ecc:security-review`,
`ecc:production-audit`, `ecc:react-review`, `ecc:postgres-patterns`,
`ecc:error-handling`, `ecc:api-design`, `engineering:tech-debt`,
`ecc:agent-architecture-audit`, `cybersecurity-skills:detecting-indirect-prompt-injection`
(static analysis only; no scanner models installed).

## Summary

| Severity | Count | IDs                         |
| -------- | ----- | --------------------------- |
| Blocker  | 0 new | (one inherited, unverified) |
| High     | 2     | H1, H2                      |
| Medium   | 6     | M1–M6                       |
| Low      | 11    | L1–L11                      |

**Inherited, not reproduced:** #121's own UAT records authenticated listing
detail and queue reads returning HTTP 500 in the cloud (UC03,
`docs/runbooks/opak-uat-results-2026-10-01.csv:4`) as an open release gate, with
the cause unconfirmed. I could not reproduce it from source without
authenticated access to that environment, so it is not ranked here. It still
blocks release under #121's own gates.

---

## High

### H1 — Unauthenticated email-sending auth endpoints have no rate limit · main · S–M

**Evidence**

- `apps/web/app/api/auth/[...all]/route.ts:13-19` forces
  `sign-in/magic-link`, `request-password-reset`, `sign-up/email` and
  `send-verification-email` through Wukong's own routes
  (`/api/auth/magic-link`, `/forgot-password`, `/register`).
- Those routes call better-auth through `authRequest`
  (`apps/web/lib/auth-flow.ts:82-88`). It builds a fresh `Request` with only a
  `content-type` header: no `x-forwarded-for`, no client IP.
- better-auth 1.5.5 skips rate limiting when it cannot determine an IP:
  `better-auth/dist/api/rate-limiter/index.mjs:108-114`
  (`if (!ip) { …warn…; return null; }`). The `rateLimit` block in
  `apps/web/auth.ts:184-188` therefore never applies to these flows.
- The only test, `apps/web/auth.test.ts:60`, asserts the config object, not the
  behavior.

**Impact.** Anyone on the internet can trigger unlimited magic-link, reset and
enrollment emails to any eligible Opak address. Responses stay generic, so this
is not enumeration. The harm is mailbox flooding and exhausting the SMTP/Resend
quota, which locks every operator out of magic-link sign-in.

**Fix.** Forward the trusted client-IP header from the incoming request into
`authRequest`. Configure better-auth's IP header (`advanced.ipAddress`) for
Vercel's `x-forwarded-for`. Add a per-email cooldown in `auth_rate_limits` as a
second key. Add route-level tests that the Nth request returns 429.

### H2 — `editReview` changes listing status without `transitionListing` · main · S

**Evidence**

- `packages/db/src/repositories/listings.ts:939-949` maps status through a
  hand-written `nextStatusByStatus` table:
  - `approved` / `published` / `publish_failed` → `reopened`
  - `needs_info` → `in_review`
- `:1001-1015` writes `status: nextStatus` directly.
- The only audit events are `listing.edited` (`:1016-1037`). The state machine's
  `listing.transition` event (`packages/core/src/workflow.ts:78-91`) is never
  written for this path.
- Every other status write in the repository goes through `transitionListing`.
  This is the only bypass found.

**Impact.**

- It breaks a CLAUDE.md hard rule.
- **Reopening an approved or published listing**, which reverses an approval,
  leaves no `listing.transition` record. Anyone reconstructing approval history
  from transition events will miss it.
- The mapping can drift from `workflow.ts` silently, because nothing ties the
  two together.

**Fix.**

- Replace the table with `transitionListing(listing.status, action, …)`:
  - `reopen` for approved, published and publish_failed
  - `submit_manual`, or a new explicit action, for needs_info → in_review
  - no transition for in_review → in_review
- Keep the optimistic guard.
- Add a test that editing an approved listing writes `listing.transition`
  `{approved → reopened}`.
- **Needs decision:** which action name represents "edit moves needs_info to
  in_review".

## Medium

### M1 — Listing extraction and generation prompts don't treat inputs as untrusted · main · S–M

**Evidence**

- `packages/ai/src/prompts.ts:20-40` has no rule that supplied notes, label text
  or imported cells are data rather than instructions.
- Providers embed them as JSON in the user turn
  (`packages/ai/src/openai-listing-provider.ts:477-487`, `:560-567`). Generation
  receives verbatim evidence excerpts (`apps/worker/src/listing-pipeline.ts:523-529`).
- By contrast, the wine prompts state the rule
  (`packages/ai/src/wine-enrichment-prompts.ts:18`) and have a hostile-fixture
  browser case (`tests/e2e/wine-enrichment.spec.ts:483,574`).
- No hostile-input test exists for the listing extract/generate path.

**Impact.** A crafted note, label photo or workbook description can steer copy
within the schema, for example adding marketing claims. Existing mitigations:
strict JSON schema, grounding validators, compliance flags and mandatory human
approval. There are no tools, so it cannot escalate to actions.

**Fix.** Phase 4 scope:

- Add the untrusted-data clause and a delimiter convention.
- Add a hostile fixture to the fake-provider regression.
- Note: changing the prompts requires bumping `LISTING_PROMPT_VERSIONS`. Already
  accepted operations then refuse with "Accepted prompt versions are
  unavailable" (`apps/worker/src/operation-ai.ts`). Sequence the change with the
  queue drained.

### M2 — No HTTP security headers · main · S

**Evidence.** Nothing in `apps/web` sets a CSP, `frame-ancestors` /
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` or
`Permissions-Policy`: no `headers()` in `next.config`, nothing in
`middleware.ts`, and no `vercel.json`. The package-J hardening spec does not
mention headers. CSRF protection on app API routes relies only on better-auth's
`SameSite=Lax` cookie. There is no Origin check, except in `workspace/select`.

**Impact.** No defense in depth against clickjacking of approve/export controls
(partly mitigated because Lax cookies are not sent in cross-site frames), MIME
sniffing of served XLSX/JPEG, or referrer leakage of capability-style URLs.

**Fix.** Add a `headers()` block (start with `frame-ancestors 'none'`,
`nosniff`, `strict-origin-when-cross-origin`) and a CSP in report-only mode
first. Optionally add a shared Origin check in `withRouteErrors` for
non-GET requests.

### M3 — `repositories: any` in the deps type of the most sensitive routes · main · M

**Evidence.** Nine route factories type `forWorkspace`'s callback as
`(repositories: any)`:

- approve, bulk-approve, review, review-confirmations, flags/resolve and process
- export, export/preview and export download

Example: `apps/web/app/api/listings/bulk-approve/route.ts:56`. There are also
`as any` / `(value: any)` uses in `apps/web/app/api/listings/route.ts:169,172`,
plus four in `listings/[id]/route.ts:224-241`.

**Impact.** Type checking is switched off exactly where approval, export and
audit calls happen. A renamed repository method or a wrong argument shape
compiles cleanly.

**Fix.** Type the callbacks as `Pick<WorkspaceRepositories, …>`. This changes
types only, not runtime behavior.

### M4 — Bulk approve hides unexpected per-item errors with no server log · main · S

**Evidence.** `apps/web/app/api/listings/bulk-approve/route.ts:120-127` maps any
non-`ApiError` to `{code:"unknown_error"}` and logs nothing.

**Impact.** A database or programming fault during a 50-item approval appears
to the reviewer as "try again" and leaves no trace for the operator. That
contradicts the "never swallow an error" rule.

**Fix.** Emit the existing `route_error` single-line JSON with the error name
and throw site (no message), keyed by listing ID. Return a request ID, as #121's
support-ID pattern does.

### M5 — Domain contract and project docs have drifted · #121 / main · M

**Evidence**

- `CONTEXT.md` is unchanged in #121 (`git diff origin/main...84006670 -- CONTEXT.md`
  is empty). Yet #121 adds migrations `0049`–`0053` and new domain concepts:
  maintenance drafts and source matching, listing assignments and handover,
  batch current-content fences and selection previews, operational archive,
  quality projection, and catalog support IDs.
- `CLAUDE.md:16` lists only OpenAI and OpenRouter. The Worker actually calls
  OpenAI, OpenRouter, OpenCode Go, Tavily, TypeSafe/Jev and Photoroom
  (orientation §3).

**Impact.** Non-negotiable #1 treats `CONTEXT.md` as the domain contract.
Reviewers and agents work from a contract that no longer describes the system.

**Fix.** Add `CONTEXT.md` sections for the #121 concepts, either in #121 itself
or as a docs PR immediately after it. Update the `CLAUDE.md` AI line.

### M6 — Invite returns 200 when the invite email fails · main · S

**Evidence.** `apps/web/app/api/workspace/members/invite/route.ts:84-91` catches
the mail failure, logs `member_invite_email_failed`, then returns
`jsonResponse(200, invite)` with no delivery indicator.

**Impact.** The admin is told the invite was sent when it wasn't, and the
invitee never receives a link.

**Fix.** Return `{ ...invite, emailDelivered: false }` (or 202 plus a flag) and
show a resend action in `admin-members-panel`.

## Low

**L1 · Role rank logic is duplicated** (main + #121, S)

- Three rank tables exist: `apps/web/lib/session-context.ts:46`,
  `apps/web/app/api/listings/[id]/route.ts:46`, and
  `packages/db/src/repositories/listing-assignments.ts:50` (the last one is new
  in #121).
- About 20 inline arrays like `["reviewer","admin","owner"].includes(role)`.
- All are consistent today. Export one `hasRole(min, actual)` helper.

**L2 · Malformed queue messages are handled inconsistently** (main, S)

- `apps/worker/src/listing-consumer.ts:65-73` and `wine-consumer.ts:15` retry an
  unparseable envelope until it reaches the DLQ.
- The schema comment says the consumer "acks the message away"
  (`packages/jobs/src/cloudflare-queue.ts:34-35`).
- `website-consumer` and `product-shot-consumer` ack.
- Pick one policy and fix the comment.

**L3 · No cap on how often the sweeper re-enqueues a stuck run** (main, S–M)

- `sweeper_find_stuck_listing_jobs` (`0032`) re-selects any `started` run idle
  for 300 s, with no attempt counter. The undispatched-outbox path does have
  `maxAttempts`.
- The loop normally stops because the final delivery marks the run failed
  (`apps/worker/src/listing-pipeline.ts:727-743`).
- If the Worker is evicted on that final delivery, the run stays `started` and
  is re-enqueued every ~5–10 minutes indefinitely. On the legacy path that can
  repeat provider calls for steps that aren't cached.

**L4 · Two `canonicalJson` implementations with different semantics** (main, S)

- `apps/web/app/api/listings/export/route.ts:51` derives export attempt
  identity. It doesn't guard `undefined` or non-finite values.
- `apps/web/lib/export-evidence-packet.ts:41` is the strict version.
- Have the export route use the strict one.

**L5 · Two logs aren't single-line JSON** (main, S)

- `apps/worker/src/product-shot-consumer.ts:60,92` log
  `console.error("…", {…})`. The content is safe; the format breaks the
  convention.

**L6 · `tests/next-config.test.mjs` is never run** (main, S)

- It isn't in `pnpm test` or `ci.yml`. It passes when run directly (1/1).

**L7 · `apps/web/middleware.ts` uses the deprecated file convention** (main, S)

- Next 16.2 deprecates `middleware` in favor of `proxy.ts`. Rename when convenient.

**L8 · Legacy Auth.js tables are still granted to the runtime role** (main, S + migration)

- `accounts`, `sessions` and `verification_tokens` are defined only in
  `packages/db/src/schema.ts:155-196`.
- Live grants: `wukong_app` has full DML, and no RLS.
- No runtime code references them. Revoking or dropping them needs a numbered
  migration, `0054` or later, which would be written but not applied.

**L9 · Production topology in committed evidence** (#121, S)

- `docs/runbooks/opak-catalog-stage-attribution-2026-10-04.json:3303` contains
  the production Neon endpoint hostname. Production Hyperdrive IDs appear in
  several runbooks.
- None of these are credentials. Together with about 13.5k lines of dated JSON
  evidence under `docs/runbooks/`, they dilute the runbooks; consider an
  `evidence/` folder and redacting the hostname.

**L10 · Legacy OpenAI path reads the model from `process.env`** (main, S)

- `packages/ai/src/openai-listing-provider.ts:209-211`, called from
  `apps/worker/src/cloudflare-runtime.ts:101-103` without `model`.
- It works because `nodejs_compat` populates `process.env`, but the OpenRouter
  path takes `env`. Fold into the Phase 4 routing table.

**L11 · One shared HMAC secret for both directions, single-key verifier** (main, M)

- Rotation requires a pause, as the runbook documents. Consider a verifier that
  accepts two keys during rotation.

## Test gaps against CONTEXT.md and CLAUDE.md guarantees

| Guarantee                                       | Gap                                                  |
| ----------------------------------------------- | ---------------------------------------------------- |
| Auth flows are rate limited                     | Config-only assertion (`auth.test.ts:60`); see H1    |
| Status changes only through `transitionListing` | No test that `editReview` emits `listing.transition` |
| AI copy uses only supplied facts (listing path) | No hostile/injected-input fixture; see M1            |
| Errors never swallowed (bulk approve)           | No test that unexpected item errors are logged       |
| Next config pinning                             | Test exists but never runs (L6)                      |

Guarantees spot-checked and found covered:

- bulk-approve limits and duplicates, `review_context_required`
- membership guard, owner not grantable
- workbook limits and identical-bytes replay, publishing fail-closed
- product-shot fresh-attempt consent, image publication gate
- all-excluded export, `freshnessAttested`, verification time bounds
- website polling cleanup

## Verified OK

- **Tenant scoping.**
  - No route reads `workspaceId` from the body, query or params, except
    `workspace/select` (`route.ts:56-70`). That route requires the same origin,
    a session and a membership check.
  - `auth_get_active_membership` (`0048`) only orders the user's own
    memberships, so the cookie cannot select a foreign workspace.
  - All delivery, assignment and batch services receive `session.workspaceId`.
- **RLS (live catalog).**
  - All 58 `workspace_id` tables have RLS enabled and forced, with a policy on
    `current_setting('app.workspace_id')`.
  - `workspaces` is self-scoped.
  - `wukong_app` is `NOBYPASSRLS`.
  - The only non-tenant policy is `product_shot_public_lookup`, `USING (true)`,
    which is SELECT-only and granted only to `wukong_image_lookup`.
  - `TENANT_TABLES` in `audit:verify` matches all 58 tables.
- **SECURITY DEFINER.** All 13 functions pin `search_path`. None are executable
  by PUBLIC.
- **Migrations.** `0000`–`0053` applied twice cleanly (7 s, then 3 s), so they
  are replay-safe. Foreign-key index coverage is complete except
  `listing_assignments.assignee_user_id`, which only matters on user delete; the
  tenant-scoped `(workspace_id, assignee_user_id, listing_id)` index covers reads.
- **State machine.** All other listing status writes call `transitionListing`
  first:
  - `listings.ts`: lines 752, 813, 863, 907, 1051, 1083, 1113, 1142, 1324 and 1366
  - `listing-inputs.ts:374`
  - `listing-operation-recovery.ts:82`, which also row-locks
- **Authorization.** Every mutating route enforces a role, directly or through
  a delegated handler: `websiteSession`, the product-shot action table, and the
  enrichment, wine and proposal routes. No role arrays are inconsistent.
- **Queue boundary.**
  - The HMAC covers path, timestamp and body, with ±300 s skew and a
    constant-time compare.
  - Ingress caps bodies at 4 KiB.
  - All job schemas are `strictObject` / `.strict()`.
  - The website callback is signed, uses `redirect: "manual"`, ignores response
    bodies, and validates the base URL.
  - Product-shot final delivery records a terminal state only for undispatched
    attempts.
- **SSRF** (`apps/web/lib/website/public-fetch.ts`):
  - HTTPS on 443 only.
  - Every DNS answer must be global unicast, and the connection is pinned to the
    resolved IP.
  - At most 3 redirects, each re-validated.
  - Per-hop agents, content-type and encoding allowlists.
- **Product-shot uncertain outcome.** Consent is enforced on the server.
  `nextShotAction` returns `confirm_charge` (`packages/core/src/product-shot.ts:48`),
  and `explicitFreshAttempt` is re-checked under `lockReviewState`
  (`apps/web/lib/product-shot-request.ts:201-276`).
- **Approval and export concurrency.**
  - `approveOne` takes `lockReviewState` before any check
    (`listing-approval.ts:238`). Bulk approve uses one transaction per item.
  - Export readiness is a single-winner conditional UPDATE, and the
    `bulk_form_exported` audit is written in the same transaction
    (`export-attempts.ts:194-310`).
  - Attempt idempotency rejects mismatched replays.
- **Validation and React.**
  - No `.passthrough()`, `z.any()` or `.catchall()`.
  - Client components import nothing server-only, and there is no
    `dangerouslySetInnerHTML`.
  - Effect-driven fetches guard against stale responses with cancelled flags or
    request counters.
- **Logging.** No prompts, model output, customer content or credentials found
  in logs. Provider failures log only enum codes (`typed-json-completion.ts:89`).
- **better-auth.**
  - 7-day sessions, sign-up disabled, minimum password length 12, email
    verification required.
  - Per-email password lockout guard; reset revokes sessions.
  - Magic links last 30 minutes and are single-use.
  - Trusted origins come from `baseURL`.
- **Worker database.** At most 5 connections, closed after every batch.
  Hyperdrive caching is disabled, per the runbook.

## Not covered (limits of this pass)

- I did not read all 364 files #121 changes line by line. Coverage was driven by
  the risk list in the brief.
- Specs and plans were read per subsystem as needed, not exhaustively.
- I ran no browser, e2e or `audit:verify`. The CI evidence above stands in.
- I did not verify cloud and runtime behavior (H1's live impact, inherited
  UC03).
- N+1 analysis was limited to bulk approve and the reads #121 already measured
  (UC30 is 827.78 ms against an 800 ms target, which #121 records as a miss).

## #121 churn on files needing fixes

| File                                                 | Lines changed by #121 |
| ---------------------------------------------------- | --------------------- |
| `apps/web/lib/auth-flow.ts`                          | 0                     |
| `apps/web/app/api/auth/[...all]/route.ts`            | 0                     |
| `packages/db/src/repositories/listings.ts`           | 23                    |
| `apps/web/app/api/listings/bulk-approve/route.ts`    | 0                     |
| `apps/web/app/api/workspace/members/invite/route.ts` | 0                     |
| `apps/worker/src/listing-consumer.ts`                | 0                     |
| `apps/worker/src/product-shot-consumer.ts`           | 0                     |
| `packages/ai/src/prompts.ts`                         | 0                     |
| `apps/web/app/api/listings/export/route.ts`          | 113                   |
