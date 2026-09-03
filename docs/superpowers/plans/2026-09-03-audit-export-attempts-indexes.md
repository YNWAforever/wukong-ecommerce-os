# Audit Events / Export Attempts Missing Indexes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 missing indexes covering `audit_events` and `export_attempts`' real query patterns — no application code changes, no dropped indexes.

**Architecture:** One new raw SQL migration (`0015_audit_export_attempts_indexes.sql`) plus the matching Drizzle `schema.ts` index declarations, kept in sync per this repo's dual-source-of-truth discipline. This is one cohesive unit of work touching 2 files with no new repository methods or application logic — a single task, not the multi-task breakdown larger features on this branch used, since there's no independently-shippable sub-piece to split it into (the migration and its schema.ts mirror must land together, and the one genuinely uncertain part — the GIN index's exact Drizzle syntax — is a step within writing that same file, not a separable concern).

**Tech Stack:** PostgreSQL (raw SQL migration), Drizzle ORM `pg-core` schema (`^0.44.7`).

---

**Live-code discipline:** every file:line reference below was verified against the live checkout during this session's design/research pass (2026-09-03), on `claude/integrate-packages-h-i`. Even so, **read the current file before editing it** — treat quoted code as a starting point to diff against, not a guarantee.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for every command. Postgres is expected running locally (docker compose, port 54329) — if it isn't, run `docker compose up -d postgres` first (per `docs/runbooks/local-development.md`).

---

## Task 1: Add the 4 indexes

**Files:**
- Create: `packages/db/drizzle/0015_audit_export_attempts_indexes.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Read the current files**

Read `packages/db/src/schema.ts`'s `exportAttempts` table (around line 818) and `auditEvents` table (around line 1041) in full, and confirm they still match:

```ts
export const exportAttempts = pgTable(
  "export_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedBy: text("requested_by").notNull(),
    manifest: jsonb("manifest")
      .$type<
        Array<{
          listingId: string;
          versionId: string | null;
          outcome:
            | "included"
            | "excluded_no_op"
            | "excluded_stale"
            | "not_import_origin"
            | "raw_row_invalid"
            | "listing_not_found";
          reason?: string;
        }>
      >()
      .notNull(),
    rowCount: integer("row_count").notNull(),
    specVersion: text("spec_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("export_attempts_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
  ],
);
```

```ts
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    actorId: text("actor_id").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    metadata: jsonb("metadata").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("audit_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);
```

Also confirm `packages/db/drizzle/` still ends at `0014_export_attempts.sql` (no newer migration landed on this branch since this plan was written) — if a later migration exists, the new file's number must shift accordingly.

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0015_audit_export_attempts_indexes.sql`:

```sql
-- Covers findRelatedToListing (packages/db/src/repositories/audit.ts) and
-- audit-verify.ts's release-gate query -- both filter workspace_id+entity_id
-- and sort by created_at, id. Neither is covered by the existing
-- audit_events_workspace_created_idx (workspace_id, created_at) alone.
CREATE INDEX IF NOT EXISTS audit_events_workspace_entity_idx
  ON audit_events (workspace_id, entity_id, created_at, id);

-- Covers countByActionSince, countByActionAndMetadataKeySince, and
-- sumImportMetricsSince (all three filter workspace_id+action+created_at>=).
CREATE INDEX IF NOT EXISTS audit_events_workspace_action_idx
  ON audit_events (workspace_id, action, created_at);

-- Covers listForWorkspace (packages/db/src/repositories/export-attempts.ts)
-- -- filters workspace_id, sorts by created_at desc, id desc. No index
-- covers this at all today; the only existing index is on
-- (workspace_id, idempotency_key).
CREATE INDEX IF NOT EXISTS export_attempts_workspace_created_idx
  ON export_attempts (workspace_id, created_at, id);

-- Covers listContainingListing's `manifest @> '[{"listingId":...}]'::jsonb`
-- containment check -- today a full per-workspace sequential scan comparing
-- every row's manifest. jsonb_path_ops (not the default jsonb_ops) is
-- correct here: smaller and faster specifically for @> containment, and
-- nothing in this codebase needs jsonb_ops' extra key-existence operators
-- (?, ?|, ?&) on this column.
CREATE INDEX IF NOT EXISTS export_attempts_manifest_gin_idx
  ON export_attempts USING GIN (manifest jsonb_path_ops);
```

Note: no `CONCURRENTLY` — this repo's migration runner (`packages/db/src/migrations.ts`'s `loadSqlMigrations`, applied inside `database.migrate()`) executes each migration transactionally, and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block at all.

- [ ] **Step 3: Add the two `audit_events` index entries to `schema.ts`**

Change `auditEvents`'s `(table) => [...]` array from:

```ts
  (table) => [
    index("audit_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
```

to:

```ts
  (table) => [
    index("audit_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("audit_events_workspace_entity_idx").on(
      table.workspaceId,
      table.entityId,
      table.createdAt,
      table.id,
    ),
    index("audit_events_workspace_action_idx").on(
      table.workspaceId,
      table.action,
      table.createdAt,
    ),
  ],
```

(The original `audit_events_workspace_created_idx` entry is unchanged — kept, not dropped, per the design's explicit decision.)

- [ ] **Step 4: Add the plain btree index entry to `exportAttempts` in `schema.ts`**

Change `exportAttempts`'s `(table) => [...]` array from:

```ts
  (table) => [
    uniqueIndex("export_attempts_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
  ],
```

to:

```ts
  (table) => [
    uniqueIndex("export_attempts_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index("export_attempts_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
```

- [ ] **Step 5: Add the GIN index to `schema.ts` — verify the real Drizzle syntax first, don't guess**

This codebase has **zero existing GIN-index precedent** anywhere in `schema.ts` (confirmed by grepping the whole `packages/db` tree for `GIN`/`gin`/`jsonb_path_ops` before this plan was written — no hits). `drizzle-orm` is pinned to `^0.44.7` (`packages/db/package.json`). Before writing this index declaration:

1. Check the installed `drizzle-orm` version's actual type definitions for `pg-core`'s `index()` builder — look for `.using(...)` and `.op(...)` (or similar) methods on the returned builder, either via your editor's hover/go-to-definition on an `index(...)` call already in this file, or by reading `node_modules/drizzle-orm/pg-core/indexes.d.ts` (or wherever the installed package places its index-builder types) directly.
2. If a real, working syntax exists for "GIN index with an explicit operator class" (the typical shape is something like `index("name").using("gin", sql`${table.manifest} jsonb_path_ops`)` or a dedicated `.op("jsonb_path_ops")` chained call — confirm the ACTUAL shape from the real type definitions, don't copy this sketch verbatim), add it to `exportAttempts`'s `(table) => [...]` array, after the `export_attempts_workspace_created_idx` entry from Step 4.
3. If the installed `drizzle-orm` version genuinely cannot express a GIN index with a specific operator class in `schema.ts` (this has historically been a gap in some `drizzle-orm` versions), do **not** write something that might not compile or might silently mismatch the real migration. Instead, omit this one index from `schema.ts` and add a clear comment at the end of `exportAttempts`'s index array explaining why:
   ```ts
   // export_attempts_manifest_gin_idx (GIN, jsonb_path_ops) is NOT declared
   // here -- drizzle-orm ^0.44.7's pg-core index builder cannot express a
   // GIN index with an explicit operator class. The index exists via
   // 0015_audit_export_attempts_indexes.sql alone; this comment is the only
   // record of it in the TypeScript schema.
   ```
4. Whichever path you take, typecheck immediately after (`corepack pnpm --filter @wukong/db typecheck`) to confirm `schema.ts` still compiles before moving on.

- [ ] **Step 6: Apply the migration to the local test database**

```bash
docker compose ps postgres
```

If not running: `docker compose up -d postgres`, then wait for it to report healthy.

```bash
corepack pnpm --filter @wukong/db exec tsx -e "import { createDatabase } from './src/index.js'; const db = createDatabase('postgres://wukong_app:wukong-app-local@localhost:54329/wukong', { migrationUrl: 'postgres://wukong:wukong@localhost:54329/wukong' }); await db.migrate(); await db.close(); console.log('migrated');"
```

Expected: prints `migrated` with no errors. (Every integration test's own `beforeAll` already calls `database.migrate()`, so Step 7's full test run will also re-exercise this — this step is a fast, isolated first check before running the whole suite.)

- [ ] **Step 7: Verify the GIN index is actually chosen by the query planner**

This is the one part of this change with no automated test coverage (declaring the wrong column or operator class would otherwise go unnoticed). Run a direct `EXPLAIN` against the exact containment query `listContainingListing` uses:

```bash
docker exec -i wukong-ecommerce-local-postgres-1 psql -U wukong -d wukong -c "EXPLAIN SELECT id FROM export_attempts WHERE workspace_id = 'ws_explain_check' AND manifest @> '[{\"listingId\": \"11111111-1111-4111-8111-111111111111\"}]'::jsonb;"
```

(Adjust the container name if `docker compose ps postgres` in Step 6 reported a different one.)

Expected: the plan output includes a reference to `export_attempts_manifest_gin_idx` (e.g. `Bitmap Index Scan on export_attempts_manifest_gin_idx` or `Index Scan using export_attempts_manifest_gin_idx`), not a bare `Seq Scan on export_attempts`. An empty/small table might still let Postgres's planner choose a sequential scan anyway if it estimates that's cheaper for so few rows — if that happens, insert a few dozen synthetic rows into `export_attempts` first (matching the real column list: `id`, `workspace_id`, `idempotency_key`, `requested_by`, `manifest` as valid jsonb, `row_count`, `spec_version`, `created_at`) via the same `psql`/`docker exec` approach, re-run the `EXPLAIN`, and confirm the index is chosen once there's enough data for it to matter — then clean up those synthetic rows (`DELETE FROM export_attempts WHERE workspace_id = 'ws_explain_check';`) before continuing.

- [ ] **Step 8: Run the full `@wukong/db` test suite**

```bash
corepack pnpm --filter @wukong/db exec vitest run src
```

Expected: every test file passes, including all existing integration tests (each one's own `beforeAll: await database.migrate()` re-applies this migration from scratch against its own test database state) — zero failures, zero regressions.

- [ ] **Step 9: Typecheck**

```bash
corepack pnpm --filter @wukong/db typecheck
```

Expected: exit 0, clean.

- [ ] **Step 10: Format check**

```bash
node scripts/check-runtime-format.mjs
```

If `packages/db/drizzle/0015_audit_export_attempts_indexes.sql` or `packages/db/src/schema.ts` is listed, run `corepack pnpm exec prettier --write <file>` on it and re-check.

- [ ] **Step 11: Commit**

```bash
git add packages/db/drizzle/0015_audit_export_attempts_indexes.sql packages/db/src/schema.ts
git commit -m "feat: add missing indexes on audit_events and export_attempts"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

- [ ] **Step 12: Report status**

Do not push or open a pull request — stop here and report back with the full verification results (Steps 6–10, including the actual `EXPLAIN` output from Step 7), matching how every prior package/fix this session was handed back for the user's own review/merge.
