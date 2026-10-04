# Opak create/import binding and recovery — 2026-10-04

## Behavior and reproduced findings

PUB01 (T12/T14) is reproduced in local fake SHOPLINE service tests: while a create call is in flight, an import can commit the same remote-product identity. Completion previously used the general import upsert with `origin=created` and null source fields, overwriting SKU, raw row, facts, digest and source import. It could also replace another draft's binding. This is a newly reproduced concurrency gap; it does not establish the original production detail/queue500 root cause.

The scoped repository now exposes `bindCreatedProduct`. One INSERT/ON CONFLICT statement creates an absent row, binds a null listing ID, or accepts the same listing ID. Conflict updates touch only the binding and, when first binding, its timestamp. Existing origin, SKU, import specification, raw row, facts, digest and source import remain intact. An existing binding's timestamp stays intact on repeat completion. Another draft returns false. General `upsert`/`upsertMany` import semantics remain unchanged.

Completion still runs within the workspace transaction, with the publish lease/version CAS, `transitionListing` and publication audit. A binding conflict throws a fixed local error outside connector retries: completion rolls back while the separately recorded remote ID remains on the running job. Do not mark that remote result failed or create another product to resolve the mapping.

PUB02 (T12/T14) was independently reproduced through the actual queue consumer with injected repositories: once a reviewed correction links that remote product to the current draft, deriving an update key from the current link acknowledges the message without finishing its original create job. Consumer recovery now retains the original create key only for a recorded remote result matching this draft, version, connection and current remote ID, with a queued, running or retryable failed job. It respects the existing lease and confirms remote status before local completion. Normal update jobs remain updates; mismatched or unconfirmed jobs gain no remote-write authority.

## Verification and limits

Observed regression order:

- PUB01 preservation RED: imported fields became null and origin became created. Conflicting-binding RED: publication resolved when it should have retained the remote result for reconciliation.
- Real disposable PostgreSQL17 integration:20/20 passed, including the original16 tests and4 new cases. The concurrent case observes a database lock wait before releasing the import commit, then checks exact imported-row retention. Other cases cover unlinked import/source ID/facts preservation, idempotent completion, another draft and foreign workspace rejection.
- Independent review found PUB02. Actual consumer regression RED: expected busy-lease retry, received ack. The initial recovery test called the service directly and did not prove queue redelivery; the consumer test now covers that boundary.
- Final focused64/64, combined repository29/29, full root142/Web2306/Worker419 and14tasks, typecheck14, build8 pass; one existing assets unit skip retained. Independent final recheck has no remaining material findings. Exact commands and terminal evidence are recorded in the outside-Git receipt. No live SHOPLINE call, paid AI, production mutation or cloud runtime pass is inferred from these local tests.

Commands:

```powershell
pnpm.cmd --filter @wukong/worker exec vitest run src/publish-product.test.ts src/shopline-consumer.test.ts
pnpm.cmd --filter @wukong/db exec vitest run src/repositories/platform-products.integration.test.ts src/repositories/publish-jobs.integration.test.ts --testTimeout 15000 --hookTimeout 30000
pnpm.cmd --filter @wukong/db... build
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd build
pnpm.cmd format:runtime:check
pnpm.cmd runtime:forbidden:check
pnpm.cmd release-gate:check
```

The integration command is destructive to its test database. This run used a newly created disposable loopback PostgreSQL container/database, with `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL` and the checkout's `DATABASE_MIGRATIONS_DIR` supplied only to that process. Never direct it at production, shared staging or a merchant database.

Failed helper CRLF marker and missing consumer fake-method checks, a new fixture's incorrect string connector status caught by typecheck, and all four behavior RED results remain failed evidence. Correcting those tooling/fixture mistakes grants no deployment or production acceptance.

## Release, recovery and remaining gates

No migration, new application environment variable, role grant, provider credential or stack change is required. Web and Worker must use compatible reviewed repository artifacts. This new source needs its own exact-head CI and preview/runtime evidence; earlier staging Workerfcf/source593 and Web92d receipts remain dated evidence for those artifacts.

For a conflict, retain the running job, remote ID, source snapshots, versions, audits and reservations. A human reviews the actual remote identity and mapping before correction; do not automatically steal another draft's link. Queue redelivery after a matching reviewed correction uses the accepted create key, observes the lease and reconciles the remote result. Do not call SHOPLINE create again to repair a local binding.

Rollback is an approved compatible artifact with new admission held and accepted/unknown work retained. Returning to the old unconditional create upsert reintroduces PUB01, so that artifact cannot be called safe for concurrent create/import. No destructive down-migration or fabricated source binding is part of rollback.

Production0046/cache-only scope is explicitly authorized and the migration operator is Codex. Backup/restore ownership, a confirmed recoverable point, effective Web runtime DB identity and authenticated original500 reproduction remain incomplete. The current production DATABASE_URL is Sensitive metadata; normal project metadata is not proof of the value used by the deployed artifact. No secret read/export, snapshot, migration, cache change or deployment was performed in this batch.

UAT stays15PASS/3PARTIAL/12BLOCKED/all30. Paid/human fixture quality, employee timing, production safe role/schema/cache/runtime checks and first real SHOPLINE/reconciled5→20→100 gates remain open. PR120 stays draft/non-green; its existing safeguards were reviewed and retained, without merge, cherry-pick or blind CI rerun. Conditional main merge remains held.

Exact binding commit187394c9 has fullCI37209276630 FAILURE at selected current-content acceptance17/18; its Vercel artifact is READY. [Admin CI diagnosis](./opak-admin-ci-diagnostics-2026-10-04.md) retains the earlier empty-main failure and separate test diagnostics. No exact-head full-flow success, rendering fix or production root is inferred.
