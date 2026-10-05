# Opak production repair proposal — 2026-10-03

The user authorized the existing hash-pinned0046 on the exact production target and disabling cache on the exact Hyperdrive, and named Codex as migration operator. The cache-only change was completed separately on2026-10-05; additive0046 remains blocked by the missing human backup/restore owner, confirmed recoverable point and controlled runtime/migration preflight. Do not request the recorded scope/operator authorization again. Later migrations, role/secret changes, deployment, main merge and SHOPLINE writing remain separate release decisions.

## Verified target and remaining failures

The retained production catalog read identifies Neon project `weathered-lake-51694428`, branch `br-twilight-meadow-at9qky4q`, database `neondb`. At that checkpoint the two0046 source-binding columns and workspace/source foreign key were absent;54public tables/44RLS/all44FORCE were recorded. `wukong_app` was non-superuser/non-bypass and `neondb_owner` had BYPASSRLS. Revalidate this catalog before executing the authorized migration.

At2026-10-05T02:15:31.222Z production Hyperdrive `eef464f2d3c0480b94d22eaca060b209` / `wukong-neon-production` reads back `caching.disabled=true`. Its exposed origin role remains `neondb_owner`; safe runtime-role readiness still fails. Worker version/build and100%traffic remain unchanged. Production Web metadata remains `dpl_7qVNQ191tqXME3uT7rWmZ4ssA92d` / main `dde9e178d9e1f9ca8880618c63104f41fe2fa3be`. Authenticated original500 reproduction and the effective Web database connection remain unresolved.

Normal Neon metadata records a ready default branch and21600-second retention. The existing September5 snapshot and retention setting are not a confirmed current recovery point or restore drill.

## Completed independently: authorized cache-only mitigation

Ruling: the reversible, explicitly authorized cache flag can be separated from additive0046. [The runtime runbook](./production-ai-runtime.md) requires cache-disabled reads for tenant RLS, leases and read-after-write. This targeted configuration change enables no new runtime or admission; [production readiness](./production-readiness.md) continues to block production enablement and the missing recovery decisions continue to block0046. Origin database load can increase after disabling caching; retain normal monitoring.

Five normal read-only CLI commands exit0 and all11 account/resource/Neon branch/Worker binding/build/version checks pass. Installed Wrangler4.112.0 and [official flags](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/) agree on the operation. A fresh unchanged-configuration guard precedes the one update attempt.

Executed command, using the pinned account configuration:

```powershell
wrangler hyperdrive update eef464f2d3c0480b94d22eaca060b209 --caching-disabled
```

The update and three surrounding reads exit0. All5 readback checks pass: exact ID/name, cache disabled, exposed other configuration unchanged, Worker version/traffic unchanged. Outside-Git `cache-update.safe.json` SHA256: `47e21180d3ac07cc6e154cb986cf81ca3ecc73a02a131f88df203c8986b08bee`. No origin credential was supplied or changed through command arguments; exposed metadata comparison is not a secret-value readback. No migration, new app env, role grant, deployment, main merge, paid AI or SHOPLINE call occurred.

The separate bounded Vercel receipt records8GET500 on another same-SHA production deployment:5detail/3list, all with generic internal-error diagnostics and no stage/database code. This historical evidence does not establish a unique cause or a current authenticated pass.

## Remaining authorized scope: additive0046

1. Record the migration and human backup/restore owners, confirmed current recovery point, controlled credential custody, active deployment pair, Queue/DLQ backlog and accepted/unknown operations. Missing ownership, a changed target or unavailable recovery point stops the migration before any change. Never retrieve credentials from browser state or publish connection values.
2. Run existing `db:listing-read-preflight` with the actual runtime connection. A provider-admin catalog query does not establish the effective Web identity. Validate the source-import unique reference key, target types/defaults and conflicting foreign keys. The runner loads `DATABASE_MIGRATIONS_DIR` and executes each SQL file in its own transaction without a migration-journal write. Supply a controlled directory containing only the hash-verified existing0046 and bounded timeouts; never the complete drizzle directory.
3. Apply only [existing0046](../../packages/db/drizzle/0046_listing_version_source_binding.sql) through the controlled migration job. SHA256: `b41a241ffcdff9c871fb09c2a4093e18ca3c879af906ec543ddb6f7fb90ebb29`. Preserve aggregate version/source counts and content digests; old bindings stay null. Do not run all pending migrations or manufacture bindings.
4. Revalidate exact Hyperdrive identity and `caching.disabled=true`; the completed flag operation needs no repeat. Revalidate metadata and actual runtime preflight. No Web/Worker deployment is included.
5. Perform approved operator/reviewer detail/queue reads. Preserve safe request/stage evidence, fail overall on DB/permission faults and never claim every original500 fixed merely because0046 is present.

Expected remaining schema change: two nullable columns, one index and one validated workspace/source foreign key. No new app env, role grant, paid AI, SHOPLINE write, main merge or production deployment is included.

## Separate compatible-runtime cutover

Changing the Hyperdrive owner credential to `wukong_app` remains a release gate. Verify controlled app-credential custody, accepted Worker workspace/RLS compatibility, grants and FORCE RLS first. Web and Worker have different builds; no credential cutover was performed. A compatible Web/Worker pair, later required migrations0049–0053, bounded backfill and human release sign-off need their own reviewed release decision.

Keep SHOPLINE disabled and publishing false. First real writing needs separate confirmation; reconcile5before20before100.

## Failure and rollback

Keep query caching disabled. Do not use cache re-enablement or the old BYPASSRLS credential as routine rollback. Unexpected configuration/readback differences require reconciliation before further operations.

Before0046, name who can stop admission and restore a compatible artifact. Failed preflight or bounded DDL failure stops the operation; retain its receipt. After a committed additive change, retain columns/index/FK and null old bindings; do not down-migrate or invent bindings.

Under separately approved release controls, preserve accepted/unknown operations, reservations, sources, versions, audits, artifacts, primary Queues and DLQs. A backup/restore event needs its own reviewed scope. Recorded0046/cache authorization does not fill missing recovery/ownership gates or authorize runtime cutover.
