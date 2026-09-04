# Task 3: durable source, approval and export binding

Date: 2026-09-05. Scope: continuation Task 3 only; Tasks 4–7 and merchant release remain separate.

## Checkout and preservation

- GitHub main was fetched and checked before editing: 2acdd2c350116e2d5c1029a616c8199f67b0e5ea, exactly the plan pin. A final ls-remote check returned the same SHA.
- Branch: codex/catalog-ops-source-binding in worktrees/catalog-ops-source-binding.
- Base: approved Task 2 commit 886d3b2e7002388419d7b8fa2e0a992c321b361f, stacked on Task 1 commit 8a7a806e7658bca899fd31e4e4175df491427696. This commit contains only the Task 3 increment.
- Root checkout and both previous worktrees preserved. Existing runtime, dependency manifests, lockfile, applied migrations and August/September packages unchanged.
- Read the current CLAUDE.md, CONTEXT.md and continuation plan. Used the codebase graph for discovery and verified current source in this checkout; graph results for some new bindings were absent/stale.

## Reproduced failures and regressions

1. Thirteen policy regressions failed before implementation: old approvals lacked receipts, re-import plus reconfirmation silently reused prior approval, hidden pass-through changes behind an old digest remained eligible, and missing/mismatched immutable source or receipt evidence was accepted.
2. Import-history regression expected two retained rows after price 100 → 105 re-import; prior importer stored zero immutable snapshots.
3. Twelve approval-binding regressions failed before the shared service recorded and validated exact source/checklist bindings.
4. Reversing two distinct listing IDs changed actual XLSX bytes and evidence/manifest order. Canonical ordering now makes these identical.
5. Artifact lifecycle regressions reproduced repeated overwrites and missing failure/readiness handling. Conditional creation and read-back hashing now reject corrupt candidates/objects without replacement and recover matching failed attempts.
6. Independent review found a promoted product-shot version could ignore its own new or revoked checklist. Three regressions reproduced ok:true; initial and final checks now require renewed approval as soon as that active version has a checklist.
7. A real PostgreSQL regression showed transaction timestamps could make the latest-receipt lookup select an older receipt. An internal generated identity ordinal now orders receipts, while exact-binding retries still return their original receipt.

## Change

- Immutable per-import source rows preserve all 71 source cells, full row digest, source import, remote product, connection, header contract and spec.
- Imported approval records an immutable receipt for the exact approved version, source snapshot and reviewed checklist version/revision. Legacy approvals are not promoted into trusted records.
- Approval/export lock the listing draft. Database triggers make source, flag and confirmation mutations acquire that same lock; locks survive through transaction commit. Export locks use canonical listing order.
- Both Bulk Update entry points use durable eligibility. Current mirror and immutable source raw-row hashes must both match the approved digest. Reconfirming changed source alone is insufficient.
- Multi-export identity binds workspace, freshness attestation, header/spec, exact approval/source evidence, canonical row order, manifest and workbook SHA-256.
- Export attempts persist pending/ready/failed. Storage writes use conditional create, then verify actual bytes. Downloads verify readiness and SHA-256. New pending/failed attempts cannot be used for import-result reports.
- Jobs/activity reflect pending/failed artifacts; legacy history/downloads explicitly report incomplete provenance. Ready state cannot be demoted by a late racing upload failure.
- Additive migration 0016 supplies workspace FKs/indexes, FORCE RLS, runtime grants and immutable-table restrictions. New tenant tables are included in audit RLS probes. No applied migration was renamed.

## Exact final checks

Commands ran from this worktree with Node 24.18.0 and the pinned manager via corepack.cmd pnpm@11.7.0.

| Command | Result |
| --- | --- |
| corepack.cmd pnpm@11.7.0 format:runtime:check | Pass: 28 runtime files, no waived format debt |
| corepack.cmd pnpm@11.7.0 runtime:forbidden:check | Pass: 9 manifests, 216 source files, zero forbidden dependencies/imports/services |
| corepack.cmd pnpm@11.7.0 lint | Pass: 14/14 Turbo tasks |
| corepack.cmd pnpm@11.7.0 typecheck | Pass: 14/14 Turbo tasks |
| corepack.cmd pnpm@11.7.0 test | Pass: 67 root tests plus 1,319 package tests; 843 web tests; 14/14 Turbo tasks |
| corepack.cmd pnpm@11.7.0 build | Pass: 8/8 tasks; Next.js build and Worker dry-run only |
| git diff --check | Pass |

The final affected integration command was:

    corepack.cmd pnpm@11.7.0 exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/source-binding.integration.test.ts packages/db/src/repositories/export-attempts.integration.test.ts packages/db/src/repositories/listings.integration.test.ts packages/db/src/repositories/review-confirmations.integration.test.ts packages/db/src/repositories/platform-products.integration.test.ts apps/web/app/api/listings/export/source-binding.integration.test.ts

Result: 6 files, 64 tests passed against a new disposable PostgreSQL 17.11 cluster at 127.0.0.1:55439, database task3_fresh, runtime role wukong_app (NOSUPERUSER/NOBYPASSRLS). TEST_DATABASE_ADMIN_URL and TEST_DATABASE_URL were explicitly set to that cluster. AI_PROVIDER=fake, SHOPLINE_ADAPTER=mock and SHOPLINE_PUBLISH_ENABLED=false were used. No merchant data was present.

Coverage includes actual lock-wait races for flag, confirmation and platform changes; cross-workspace reads/writes; wrong-listing foreign keys; immutable rows; exact receipt retry; simultaneous ready/failure transitions; and a complete real-database import → confirm → approve → multi-export → re-import → reconfirm → reject → reapprove → new artifact workflow. That workflow compares persisted manifest/provenance, real workbook price cells, original retained bytes and recorded SHA as one unit.

Independent read-only review verified the two corrected findings and reported no remaining blocking issues. Its focused recheck passed 65 tests. Subsequent root gates above include the final fixes.

## Migration rehearsal

Before adding schema, ran the existing createDatabase().migrate() runner on fresh/repeat databases and a pre-0012 database upgraded through all existing SQL. All passed; current runner executes every matching SQL filename in lexical order, each in its own transaction, on every invocation. Duplicate prefixes do not skip files.

After 0016, fresh/repeat and legacy-upgrade/repeat rehearsals passed. Final ordinal revision was rehearsed in task3_ordinalfresh and pre-0016 → task3_ordinalupgrade. Verified identity ALWAYS, runtime sequence grant, all review-lock triggers, legacy approved status with zero synthesized receipts, and legacy artifact fields left null. Applied old SQL was untouched.

Docker Desktop's Linux backend was unavailable because of a local socket rename/access failure. No Docker reset, socket deletion or repair was performed. A portable PostgreSQL distribution linked by the [official PostgreSQL Windows page](https://www.postgresql.org/download/windows/) and [EDB binary downloads](https://www.enterprisedb.com/download-postgresql-binaries) supplied the isolated cluster inside ignored node_modules/.task3-postgres; no global installation, PATH change or Windows service was added. The cluster was stopped cleanly after verification; ignored binaries and logs remain local.

## Rollout and limits

- No deployment, production migration, push, real workbook upload, merchant seed, paid-provider invocation or real SHOPLINE write occurred.
- Production activation requires a separately reviewed rollout: additive migration first; deploy compatible legacy/new-shape readers before enabling new import/approval/export writers; retain historical rows on rollback. Do not backfill old approvals or exports as verified. Do not roll back to readers that expose pending artifacts. This combined development commit is not authorization for an unstaged rolling deployment.
- Existing imported listings without immutable snapshots need a fresh import and renewed confirmation/approval. Old approved status alone does not satisfy the new policy.
- Single Bulk Update delivery has the same source/approval gate but retains its direct workbook response. Routing the operator journey through stable multi-export attempt references remains Task 5.
- Missing objects recover only from a candidate matching the committed identity/hash. There is no arbitrary old-attempt regeneration API. Changed inputs create a new attempt and do not overwrite the prior artifact.
- Corruption detected after a previously successful ready transition blocks downloads; the historical ready ledger state remains because a late failure cannot demote ready. Storage integrity monitoring is separate.
- Full MinIO/TLS/Mailpit/Worker browser acceptance and the unrestricted full integration command were not run: those local services were unavailable. Memory storage and mocked S3 protocol tests cover this slice, but do not prove live R2 conditional-write behavior. No browser acceptance or stage-level audit completeness is claimed.
- Merchant-side changes after the retained export are still unknown. Workbook cell-type fidelity, neutral stock-delta policy, explicit attestation UI, import-result reconciliation and actual SHOPLINE acceptance remain later tasks/UAT gates. No pilot-release claim is made.

Stop after Task 3 for review. The local branch and worktree remain available.
