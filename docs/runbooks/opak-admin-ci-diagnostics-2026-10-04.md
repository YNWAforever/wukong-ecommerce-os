# Opak Admin acceptance diagnostics — 2026-10-04

## Findings and evidence

CI01 remains reproduced with an unconfirmed rendering cause. Binding source187394c9f70332b6649fc5ff3453e124d7a8811f has [full CI37209276630](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/37209276630) FAILURE: selected current-content acceptance17/18 passes. The delayed workspace case never found the invite textbox after Jobs → Admin SPA navigation; its final screenshot has an empty main area. No workspace-select POST was issued. Admin RSC headers and required JS responses returned200, but the trace did not retain RSC streaming bodies; that is not evidence of an empty response. The cleanup error after page closure obscured the primary119-second wait. Five subsequent workflow steps did not run. The exact-source Vercel artifact was READY; that does not establish authenticated flow acceptance.

The Admin, shell and original test sources were unchanged from preceding green9f34e70. Original CI01 receipts and the current failure are retained. A newly created loopback PostgreSQL17 database and the existing production-built Windows Web passed the unchanged three-case suite in three repetitions:9/9 in49.1s. This negative local reproduction does not disprove or fix the Ubuntu CI rendering failure.

A separate actual headless Playwright page reproduces the cleanup defect: unroute on a closed page replaces the synthetic primary assertion with a closed-context exception. The edited cleanup body passes three checks: closed-page primary retained and hold released; secondary cleanup failure cannot replace an existing primary; a healthy test still exposes cleanup failure. Independent review found no material issue and explicitly declined to assign a rendering cause.

CI02 is a separate local timing failure, not CI01. The first diagnostic suite had6PASS/1FAIL/2serial-not-run in2.4m. The unchanged Save case missed its five-second dashboard assertion; invite POST200 took3516.108ms, workspace POST200 took245.907ms, and dashboard GET200 took945.776ms. Its failure screenshot had already reached the correct second-workspace dashboard. The timing cause is unconfirmed. This failure and its private trace remain retained.

## Test changes and verification

Only the synthetic test changes. The Jobs → Admin SPA journey now checks the named Admin heading, Members panel and invite input before attempting the workspace switch. Request entry and released-route completion are bounded, and timeout cleanup preserves the primary failure. Native Back, links, tabs, blocked second choices, exactly-one switch, old/new session and tenant invite assertions remain.

The Save case synchronizes both exact POST responses and requires200 before checking the final dashboard. Each response keeps a5000ms budget, as does the original dashboard assertion; the global120000ms timeout and retry settings are unchanged. This independently verifies two successful responses, not their order or an aggregate five-second Save SLA. It grants no product timing or rendering fix claim.

Final revised-suite verification has6PASS/1FAIL/2serial-not-run in2.0m. Its first repetition failed in the unchanged native sign-in helper before entering any amended assertions: password POST200 took1725.584ms and import-page GET200 took1232.991ms, but the5000ms URL assertion expired. The remaining two repetitions passed all three cases, including both newPOST200 and delayed-switch checks. This is not a full-suite pass or a repaired sign-in/rendering cause. Terminal receipts remain outside Git. The browser uses a newly created task-owned loopback DB, the already production-built Web and a discard-only local SMTP sink. No provider credential is used; fake AI, mock SHOPLINE and disabled paid operations are explicit. Dedicated local env names: TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL, DATABASE_URL, DATABASE_ADMIN_URL for migrations only, PLAYWRIGHT_BASE_URL, PLAYWRIGHT_E2E, WUKONG_OPAK_E2E and AUTH_SMTP_URL. The Web process receives no admin URL.

Commands:

```powershell
pnpm.cmd exec playwright test tests/e2e/opak-admin-workspace-switch.spec.ts --project=chromium --workers=1 --retries=0 --reporter=line --repeat-each=3
pnpm.cmd exec prettier --check tests/e2e/opak-admin-workspace-switch.spec.ts docs/runbooks/opak-admin-ci-diagnostics-2026-10-04.md
pnpm.cmd format:runtime:check
pnpm.cmd runtime:forbidden:check
pnpm.cmd release-gate:check
git diff --check
```

The command requires the guarded task-owned loopback env and Web server; it is not a staging or production command. Original setup failures are retained: initial PostgreSQL temporary-socket readiness, missing root dependency resolution and an incorrect signal-exit check, plus a helper newline syntax error. Those tooling corrections confer no application acceptance. Local mail contents and raw browser artifacts are discarded or stay private outside Git.

## Release and recovery

No production application code, migration, new app env, role grant, provider secret, deployment or stack change is introduced. Owned loopback services are stopped and the disposable DB is automatically removed; only safe counts/hashes/outcomes belong in the evidence pack. Reverting this test-only change is compatible with the same application artifact, but reintroduces the masked-error diagnosis problem.

This checkpoint needs its own exact-head CI/preview receipts. CI01 rendering and CI02 timing causes remain unconfirmed even if a later CI run passes. Original500/effective production Web DB identity, restore owner/recoverable point, compatible schema/role/cache/runtime, human quality/employee measurements and first real SHOPLINE/reconciled5→20→100 remain open. UAT stays15PASS/3PARTIAL/12BLOCKED/all30; conditional main merge remains held.
