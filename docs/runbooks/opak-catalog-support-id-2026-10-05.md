# Opak catalog support-ID fix — 2026-10-05

Catalog whole-request failures returned a safe correlated request ID, but the control center replaced them with a status-only Error. Employees therefore could not copy the current outage number on either initial-load or cached-refresh errors. The server still returned an error and preserved its diagnostics; this was a client acceptance gap under master-plan T01/T08, not an established production500 cause.

## Behavior and review

Use the existing safeResponseError to read each non-OK body once, retain a validated header ID for HTML/partial responses, accept a validated body-only ID and suppress raw response messages. Thread the existing useLatestRequest supportId into the already available SupportRequestId component in both error branches. No ID is invented when the response supplies none.

401/403 revoke cached access before asynchronous body parsing. invalid_cursor400 still clears the invalid selection/context and navigates to cursorless page1. The existing hook rejects aborted/obsolete results, retains prior rows on500 and clears error/ID after recovery. Successful data/row behavior and server status/authorization are unchanged.

Ruling: close the sole whole-branch reviewer finding within one final focused fix pass because the master plan requires a traceable support number and copying guidance. The reviewer graded it Minor; it introduces no authorization or data-integrity vulnerability. Cost if the ruling is wrong: a small additional client/test change and CI/Preview build, with the original runtime outage still unresolved. Whole-branch and focused rechecks found no additional material regression.

## Verification

- Rendered behavior RED: initial500 with non-JSON body/header ID and refresh500 with safe body ID both lacked the support number;2failed/32passed. Fixtures and messages are synthetic.
- Focused GREEN: catalog34 plus existing latest-request4,38/38. Header fallback, raw-message suppression, retained row, both copy controls and recovery clearing are exercised. Two additional requested test-file patterns did not match any files; no four-suite claim is made.
- Web typecheck and production compilation exit0.
- First default-concurrency Web unit suite:2307passed/1failed of2308; unchanged PDF finalize byte-preservation test exceeded its5000ms limit. This failure remains retained.
- Exact failed PDF file in isolation:3repetitions/6tests pass under unchanged5000ms, source and assertions. This is negative reproduction evidence, not a proven timeout cause.
- Bounded full Web profile:231files/2308tests pass, maxWorkers2, no new skips or timeout/assertion changes. The repository's test configuration is unchanged. Exact candidate remote CI/Preview still requires a publication receipt.

Commands actually used:

```powershell
pnpm.cmd exec vitest run components/catalog-control-center.test.tsx --reporter=dot
pnpm.cmd exec vitest run components/catalog-control-center.test.tsx lib/support-request-id.test.ts lib/use-latest-request.test.tsx components/support-request-id.test.tsx --reporter=dot
pnpm.cmd test
pnpm.cmd exec vitest run app/api/assets/finalize/route.inspection.test.ts --reporter=dot
pnpm.cmd test --maxWorkers=2
pnpm.cmd typecheck
pnpm.cmd build
```

Safe receipts, full-profile failure, isolated repetitions and terminal publication evidence are retained outside Git. Raw provider billing output and merchant evidence are excluded from public PRs and safe evidence packs.

## Scope and rollback

No migration, app env name, dependency, credential, Worker software or runtime upload is needed. Paid AI and real SHOPLINE calls are zero; main/production are unchanged. Revert this focused client commit to restore the prior error presentation while retaining server diagnostics. Preserve source/version/approval guards, manual values, workspace/RLS, audit, Queue/cost reservations and unknown outcomes.

UAT remains15PASS/3PARTIAL/12BLOCKED/all30. Original authenticated500/effective production DB, named restore owner/current recoverable point, compatible schema/safe runtime/cache, paid human quality, real employee timing, complete cloud budget and first merchant write/pilot remain separate gates. Only the existing bounded0046/cache scope and Codex migration operator are already authorized; do not re-request those decisions or infer a separate cutover.
