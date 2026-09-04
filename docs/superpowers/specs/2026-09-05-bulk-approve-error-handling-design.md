# Bulk-Approve Silent Failure Handling — Design

**Date:** 2026-09-05
**Status:** Approved (brainstorming), pending implementation plan
**Origin:** flagged earlier this session as an un-actioned follow-up item, re-verified against the live `main` branch before this design was written.

## 1. What this fixes

`apps/web/components/queue-client.tsx`'s `runBulkApprove` has no error handling around its own fetch call. Two real, currently-silent failure modes:

1. **Network failure.** If `fetch("/api/listings/bulk-approve", ...)` itself rejects (offline, DNS failure, timeout), nothing catches it. `bulkPending` still resets via the `finally` block, so the button stops showing "in progress," but no message reaches the operator — the bulk-approve attempt just silently does nothing from their perspective.
2. **Non-2xx response.** `apps/web/app/api/listings/bulk-approve/route.ts` can reject the whole request before ever building a `BulkApproveResponse` — `403 insufficient_role` (a non-reviewer role somehow reaches this action), `400` (zod validation failure, e.g. more than 50 ids), or `500 internal_error`. Each of these returns `withRouteErrors`'s error shape, `{status, code, message}` — not `{results, approved, failed}`. `runBulkApprove` currently does `const body = (await response.json()) as BulkApproveResponse; setBulkResult(body);` unconditionally, with no `response.ok` check. The render path, `bulkResult.results.map(...)`, then throws on `undefined.map` — a render-time crash with no error boundary anywhere in this component tree, which can blank the whole queue view.

Confirmed via `apps/web/components/queue-client.test.tsx`: only one bulk-approve test exists today ("selects eligible items and runs bulk-approve, then reloads the list"), covering the happy path only — no test for a rejected fetch or a non-2xx response.

## 2. The fix

Wrap `runBulkApprove`'s body in a `try`/`catch`:

- **Success path** (`response.ok` true, body parses as the expected shape): unchanged from today — `setBulkResult(body)`, clear the selection, reload the queue.
- **Failure path** (fetch rejects, `response.ok` is false, or `response.json()` itself throws on malformed JSON): do **not** call `setBulkResult` with the malformed/error body. Instead, set a new state variable, `bulkError: string | null`, to a human-readable message — the route's own `message` field when available (non-ok response with a parseable `{message}` body), otherwise a generic fallback ("Bulk approve failed — try again."). Do **not** clear the selection and do **not** reload the queue on this path, so the operator's selection survives a failed attempt and they can retry without re-selecting.

`bulkError` renders as its own `role="alert"` message near the bulk-action bar (the same accessible pattern the component's existing top-level `error` state already uses), but — critically — does **not** replace the whole component the way the top-level `error` state does. The queue itself loaded fine; only the bulk-approve action failed. Successive bulk-approve attempts clear `bulkError` at the start of `runBulkApprove`, matching how `bulkResult` is already reset to `null` at the start of each attempt today.

## 3. Testing plan

Add to `apps/web/components/queue-client.test.tsx`, matching its existing fetch-stubbing/mount conventions:

- A test where the `/api/listings/bulk-approve` fetch stub rejects (simulating a network failure) — assert a visible `bulkError`-driven alert appears, the selection is **not** cleared, and the queue is **not** reloaded (no second `GET` call to the listings endpoint after the failed attempt).
- A test where the fetch stub resolves with a non-2xx status and an `{code, message}` body (e.g. `403 insufficient_role`) — assert the error message renders, `bulkResult.results.map` is never reached (no crash), and again the selection is preserved.
- Confirm the existing happy-path test still passes unmodified.

## 4. Explicitly out of scope

- Any change to the backend route (`apps/web/app/api/listings/bulk-approve/route.ts`) — it already returns correct, complete per-listing results; this is a frontend-only fix.
- Retrying failed bulk-approve attempts automatically — the operator retries manually, matching how every other action in this app works.
- Any change to how individual per-listing failures within a successful `200` response are displayed (`bulkResult.results` rendering already correctly shows ✓/✗ per listing today) — only the "the whole request failed" case is broken.

## 5. Self-review

- **Placeholder scan:** none — every failure mode, state variable, and rendering rule is specified concretely.
- **Internal consistency:** §2's fix directly addresses both failure modes documented in §1, with no gap between them.
- **Scope check:** small and focused — one component file, one new state variable, no backend change.
- **Ambiguity check:** no point in this design has more than one reasonable resolution; the one design choice (a separate `bulkError` state vs. reusing the top-level `error` state) is explicitly justified in §2 by the different scope of what each represents.
