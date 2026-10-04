# Isolated admin, DB outage and CI startup evidence — 2026-10-03

This is synthetic cloud API and local harness evidence, not release signoff. Application files in `apps/` and `packages/` remain identical to reviewed `e9d0d4ce`; isolated Web `9dd64bf1` retains the sole branch deployment guard. No production, migration, secret, paid-AI or SHOPLINE change. [Safe receipt](./opak-staging-admin-outage-ci-2026-10-03.json).

## DB outage and admin API

The already-disabled owned staging Neon endpoint stayed disabled/idle throughout the outage-only window. Operator and reviewer cookies from prior healthy synthetic sessions were used only with GET requests. Queue/catalog each returned500, no `items`/`totalMatching` success payload, and matching request-ID body/header:15/15 assertions,57.40s. Session resolution also needs DB; this proves the outage error contract, not the precise downstream stage or authenticated browser UI. Prior permission acceptance separately proved restored routes200. No compute enable, seed or write in this window.

The next bounded window enabled only that staging endpoint. Server-session operator/reviewer settings GET/POST and readiness GET returned403. Admin fresh-digest settings save200 wrote one audit; stale-digest save409 wrote none and preserved the winning value. Readiness returned exactly five safe states with `private, no-store`; fake AI stayed unknown. Original canonical profile was restored through the same CAS API, producing the second successful setting audit. Retained AI20 and publish jobs0 stayed unchanged:29/29 assertions,113.38s. Non-superuser/non-bypass app role, tenant RLS and source/version/cost boundaries remained in force.

Fifteen exact-scope/disabled-endpoint guards passed. Main stop restored the profile and disabled compute; independent8-minute watchdog observed normal stop. Metadata-only postflight confirmed corrected Worker `f0614b8e` at100% and DB disabled/idle. Worker/queues were not deployed or resumed. This window proves API role/CAS/readiness behavior; unsaved form/navigation/role-handoff UI remains pending behind Vercel Deployment Protection.

## CI failure and the separate harness repair

Head `54837392` full CI37101837145 succeeded. Subsequent `a8eddcb7` CI37102831725 attempt1 failed after the17 Opak browser cases passed: image TLS bind49218 emitted `EADDRINUSE`, then Web49217 refused the product-shot test. The original conflicting process/socket owner is unconfirmed. Attempt2 of the exact unchanged `a8` completed full SUCCESS, including product-shot, Queue/audit and wine. This retry is not evidence for the subsequent code change or proof of the port owner's identity.

An independent real subprocess regression reproduced an actionable startup defect: with an owned competing49218 listener, the unchanged harness launched fake Worker and Web before its TLS bind failed. The correction reserves its required image/wine TLS listener before dependency waits or child startup. A conflict now rejects startup before Web readiness and preserves the competing owner. Port values, application runtime, authorization and provider flags are unchanged.

Fresh review found an Important Windows deadline-cleanup issue. Initial socket-probe fixture resets are retained separately; a non-detached descendant exited with its parent and did not reproduce this issue. A real detached owned descendant did survive leader-only termination (RED). Deadline cleanup now invokes and awaits owned-tree termination while the leader is alive (GREEN). Both behavioral regressions pass2/2 on Windows; the Windows-specific case is explicitly skipped on Linux. The reviewed minor Windows OpenSSL discovery limitation is deferred: this regression currently follows the existing Git installation path, and portable/per-user Git installations may need that dependency configured.

The first full root suite failed solely because the existing runtime test-command contract omitted the new regression. That expected command was updated, retaining all previous runtime checks. Final `pnpm test`:142 root tests pass,14/14 Turbo tasks succeed from valid unchanged application caches. Cache output is not relabelled as freshly rerun package tests. Earlier RED/fixture/contract failures and their hashes remain private; no log bodies, keys, prompts, model output or fixture contents enter this public receipt.

## Commands, rollout and remaining gates

```text
node --test <private-evidence>/cloud-permission-fault-v8/guard.test.mjs <private-evidence>/cloud-db-outage-v9/guard.test.mjs
node <private-evidence>/cloud-db-outage-v9/run.mjs
node <private-evidence>/cloud-admin-cas-v10/run.mjs
node --test tests/real-stack-startup.test.mjs
pnpm test
gh run rerun 37102831725 --failed --repo YNWAforever/wukong-ecommerce-os
```

No new migration or application env name. Cloud rollback/hold is already complete: exact original profile restored, corrected Worker key/version retained, queues held and DB disabled. The harness-only rollback is a reviewed revert of this startup delta, not restoration of unsafe credentials/schema or removal of audit/history.

Cloud matrix remains4PASS/11PARTIAL/15BLOCKED. UC02 gains complete settings/readiness server-role API evidence; UC28 gains admin CAS API evidence; UC29 gains actual whole-DB-outage error/correlation evidence. UI, original production500 and merchant criteria remain separate. The new follow-up head needs its own full CI; unchanged-head retry success cannot replace that gate. No merge or production deployment while release gates are incomplete. [First-stage production proposal](./opak-production-repair-proposal-2026-10-03.md) still awaits explicit authority and backup/rollback ownership.

Final review rulings: original port ownership remains unconfirmed; cloud/production release readiness stays governed by its own actual gates; broader A–F application behavior retains its prior review because no application files changed. Cost if wrong: an unexecuted gate could be treated as passed, so none of those boundaries is relaxed. Deferred minor: Windows OpenSSL executable discovery, with the portability limit stated above.
