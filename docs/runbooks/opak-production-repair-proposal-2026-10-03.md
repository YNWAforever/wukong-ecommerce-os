# Opak production repair proposal — 2026-10-03

This is the concrete next operation for review. It grants no production authority. The user authorized isolated synthetic staging and conditional merge after the release gates; the production changes below still require explicit approval.

## Verified target and failures

The read-only refresh identifies Neon project `weathered-lake-51694428`, branch `br-twilight-meadow-at9qky4q`, database `neondb`. Both existing0046 source-binding columns and the workspace/source foreign key are absent. There are54 public regular tables,44 with RLS, all44 FORCE RLS. `wukong_app` is non-superuser/non-bypass; `neondb_owner` has BYPASSRLS.

Production Hyperdrive `eef464f2d3c0480b94d22eaca060b209` / `wukong-neon-production` still uses `neondb_owner` and reports `caching.disabled=false`. Production Web remains `dpl_7qVNQ191tqXME3uT7rWmZ4ssA92d`, main `dde9e178d9e1f9ca8880618c63104f41fe2fa3be`. These failed gates are configuration/schema observations; authenticated original500 reproduction and the effective Web database connection remain unresolved.

Neon reports the exact default `main` branch ready and a21600-second history retention window. This six-hour retention setting is metadata, not a successful restore drill or a named recovery owner.

## First approval scope: additive schema repair and disabled cache

1. Record the operator and backup/restore owner, current recovery point, controlled migration credential custody, active deployment pair, Queue/DLQ backlog and accepted/unknown operations. Missing ownership, a changed target or an unavailable recovery point stops the operation before any change. Do not retrieve production credentials from browser state or publish connection strings.
2. Run the existing `db:listing-read-preflight` with the actual runtime connection. A provider-admin catalog query does not establish the effective Web identity. Validate the existing source-import unique reference key, target column types/defaults and conflicting foreign keys. The repository runner loads `DATABASE_MIGRATIONS_DIR` and executes each SQL file in its own transaction; it has no migration-journal write. Use a controlled directory containing only the hash-verified existing0046 file, with bounded timeout settings supplied by the controlled migration job. Do not point it at the complete drizzle directory.
3. Apply only the existing [0046 SQL](../../packages/db/drizzle/0046_listing_version_source_binding.sql) with authorized migration credentials and bounded transaction/lock timeouts. Reviewed SHA256: `b41a241ffcdff9c871fb09c2a4093e18ca3c879af906ec543ddb6f7fb90ebb29`. Preserve aggregate version/source counts and content digests; old version bindings stay null. Do not run the all-pending-migrations command or manufacture bindings.
4. Disable caching on the exact existing production Hyperdrive through normal authenticated Wrangler. Read back `caching.disabled=true`; preserve its other configuration and secret. Revalidate metadata and runtime preflight. No Worker or Web deployment is included in this first scope.
5. Perform operator/reviewer authenticated detail/queue reads through approved sessions. Preserve safe request/stage failure evidence, fail overall on DB/permission faults, and do not claim every original500 fixed merely because0046 is present.

Expected configuration/schema change: two nullable columns, one index, one validated workspace/source foreign key from0046, and the one Hyperdrive cache flag. No new app env name, role grant, paid AI call, SHOPLINE write, merge or production deployment is included.

Installed Wrangler4.112.0 confirms the boolean flag below. Execute it only after approval and the exact account/resource preflight; no credential value belongs in these arguments.

```powershell
wrangler hyperdrive update eef464f2d3c0480b94d22eaca060b209 --caching-disabled
```

## Separate compatible-runtime cutover

Replacing the Hyperdrive owner credential with `wukong_app` remains a required release gate. First verify controlled app-credential custody and the exact accepted Worker artifact's workspace/RLS compatibility, grants and FORCE RLS behavior. The current production Worker has a different build from Web; do not assume it is compatible or silently cut over its credential. An approved compatible Web/Worker pair, later required migrations0049–0053, bounded backfill and the human release gates need their own reviewed release decision.

Keep production SHOPLINE disabled and publishing false. First real SHOPLINE writing retains its separate confirmation; merchant pilot5→20→100 cannot expand before reconciliation.

## Failure and rollback

Before approval, name who can stop new admission and restore a compatible artifact. On a failed preflight or bounded DDL failure, stop and retain the receipt; the transaction rolls back without deleting historical records. After a committed additive change, retain the columns/index/FK and old null bindings. Do not down-migrate or backfill invented values.

Keep query caching disabled. Do not use the old BYPASSRLS credential as the routine rollback after a safe-role cutover. Under the separately approved controls, stop new admission, preserve accepted/unknown operations, reservations, sources, versions, audits, artifacts, primary Queues and DLQs, and use the approved compatible artifact with the safe runtime role. A backup/restore event needs its own reviewed scope.

Authorization boundary: [production-ai-runtime.md](./production-ai-runtime.md) says “Obtain explicit approval before creating paid or production resources, changing secrets, or deploying.” [production-readiness.md](./production-readiness.md) also requires human ownership, recovery and release sign-off. This proposal prepares the reviewable operation without asserting those approvals.
