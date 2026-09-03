# Missing Indexes on `audit_events` and `export_attempts` — Design

**Date:** 2026-09-03
**Status:** Approved (brainstorming), pending implementation plan
**Origin:** flagged earlier this session as an un-actioned follow-up item, re-verified against the live `claude/integrate-packages-h-i` branch (which has Package I/J's audit and export-attempt query methods `main` doesn't have yet) before this design was written.

## 1. What this fixes

`audit_events` and `export_attempts` are queried by several real repository methods whose access patterns aren't covered by either table's existing index. Every one of these queries currently does more scanning than necessary; one (`listContainingListing`'s jsonb containment check) has no index support of any kind and does a full per-workspace table scan on every call.

## 2. Current query patterns (verified against `packages/db/src/repositories/audit.ts` and `export-attempts.ts` on `claude/integrate-packages-h-i`, plus `packages/db/src/cli/audit-verify.ts`'s own raw SQL)

**`audit_events`** — existing index: `audit_events_workspace_created_idx` on `(workspace_id, created_at)` only.

| Method | Query shape | Covered today? |
|---|---|---|
| `findRelatedToListing(listingId, limit)` | `WHERE workspace_id=? AND entity_id=? ORDER BY created_at DESC, id DESC` | No — `entity_id` isn't in the index |
| `audit-verify.ts`'s release-gate query | `WHERE workspace_id=? AND entity_id=? ORDER BY created_at ASC, id ASC` | No — same gap, same table |
| `countByActionSince(action, since)` | `WHERE workspace_id=? AND action=? AND created_at>=?` | No — `action` isn't in the index |
| `countByActionAndMetadataKeySince(...)` | same WHERE as above, plus a `GROUP BY` on a jsonb-extraction expression | No — same gap |
| `sumImportMetricsSince(since)` | `WHERE workspace_id=? AND action='listing.bulk_form_import_completed' AND created_at>=?` | No — same gap |

**`export_attempts`** — existing index: a unique index on `(workspace_id, idempotency_key)` only (no `created_at`-covering index at all).

| Method | Query shape | Covered today? |
|---|---|---|
| `getById(id)` | `WHERE workspace_id=? AND id=?` | Yes — `id`'s primary key is already maximally selective |
| `listForWorkspace(limit)` | `WHERE workspace_id=? ORDER BY created_at DESC, id DESC` | No — no index covers this at all |
| `listContainingListing(listingId, limit)` | `WHERE workspace_id=? AND manifest @> '[{"listingId":...}]'::jsonb ORDER BY created_at DESC, id DESC` | No — full per-workspace scan comparing every row's `manifest` |

`listContainingListing` is called from `apps/web/lib/listing-activity-service.ts` to build a listing's activity panel — a real, user-facing read path, not an internal-only tool.

Confirmed via `git grep` on `claude/integrate-packages-h-i` that `packages/db/src/repositories/audit.ts` and `export-attempts.ts` (plus `audit-verify.ts`'s direct SQL) are the only places querying these two tables — no other access pattern to account for.

## 3. The fix — four new indexes, purely additive

1. **`audit_events_workspace_entity_idx`** on `(workspace_id, entity_id, created_at, id)` — covers `findRelatedToListing` and `audit-verify.ts`'s query (both directions of the same sort are served equally well by one btree via backward scan, so ASC and DESC callers both benefit from one index).
2. **`audit_events_workspace_action_idx`** on `(workspace_id, action, created_at)` — covers `countByActionSince`, `countByActionAndMetadataKeySince`, and `sumImportMetricsSince`.
3. **`export_attempts_workspace_created_idx`** on `(workspace_id, created_at, id)` — covers `listForWorkspace`.
4. **`export_attempts_manifest_gin_idx`**, `USING GIN (manifest jsonb_path_ops)` — covers `listContainingListing`'s `@>` containment check. `jsonb_path_ops` (not the default `jsonb_ops` operator class) is the correct choice: it's smaller and faster specifically for `@>` containment, and nothing here needs the key-existence (`?`/`?|`/`?&`) operators `jsonb_ops` would additionally support.

**The existing `audit_events_workspace_created_idx` is kept, not dropped.** It may now be partially redundant given the two new indexes above, but confirming that with certainty would require auditing every possible caller (not just the ones this design traced), and dropping an index is a materially riskier, separate decision from adding ones. Out of scope here.

## 4. Migration mechanics

Same dual-source-of-truth discipline as every other schema change in this repo: a new raw SQL migration file (next sequential number after whatever `packages/db/drizzle/` currently ends at — must be re-checked at implementation time, since `claude/integrate-packages-h-i` may have added migrations beyond what this session's earlier work saw) plus the matching Drizzle `schema.ts` index declarations on `auditEvents` and `exportAttempts`. `CREATE INDEX CONCURRENTLY` is deliberately **not** used — this repo's existing migration runner (`loadSqlMigrations`/`database.migrate()`) executes every migration inside a transaction (confirmed by the existing RLS-enabling migrations' `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` pattern, which Postgres also requires transactional DDL for), and `CONCURRENTLY` cannot run inside a transaction block at all — using it would break the migration runner outright, not just lose its non-blocking benefit. A plain `CREATE INDEX IF NOT EXISTS` inside the normal transactional migration is correct here, matching every other index this codebase has added.

## 5. Testing plan

- No new application-level test is needed for the indexes' mere existence — Postgres doesn't require a passing test to create an index. What's worth verifying:
  - The migration applies cleanly against a fresh database (already exercised by every integration test's `beforeAll: await database.migrate()`).
  - `EXPLAIN` (or `EXPLAIN ANALYZE`) against at least the `listContainingListing` query, run manually as part of implementation verification (not a permanent automated test — this codebase doesn't have a precedent for asserting on query plans in its test suite), confirming the GIN index is actually chosen by the planner instead of a sequential scan, since a GIN index is the one addition here that's easy to declare incorrectly (wrong operator class, wrong column) without a functional test ever catching it.
- All pre-existing tests for both repositories (`export-attempts.integration.test.ts`, any `audit`-repository test file) must continue passing unmodified — this change adds indexes only, no behavior change to any query's result set.

## 6. Explicitly out of scope

- Dropping the possibly-redundant existing `audit_events_workspace_created_idx` (§3).
- Any index on `ai_runs` (queried directly by `audit-verify.ts` alongside `audit_events`, per §2's research) — flagged here for awareness since it was seen during research, but auditing `ai_runs`' own index coverage is a separate table or a separate follow-up, not scoped into "audit_events/export_attempts indexes."
- Any change to the repository methods' own logic, return shape, or the routes/services that call them — this is a pure database-layer performance fix.

## 7. Self-review

- **Placeholder scan:** none — every index name, column list, and operator class is specified concretely.
- **Internal consistency:** §2's traced query patterns map 1:1 to §3's four proposed indexes; nothing in §3 lacks a corresponding query pattern in §2, and nothing in §2 lacks a corresponding fix in §3 except the two items explicitly deferred in §6.
- **Scope check:** appropriately sized — one migration, one schema.ts edit, no application code changes. Smaller than PR #65 or the `/jobs` reconciliation feature.
- **Ambiguity check:** the two points with more than one reasonable resolution (branch base, whether to also drop the possibly-redundant existing index) were both resolved explicitly with the user or decided with stated reasoning before this document was written.
