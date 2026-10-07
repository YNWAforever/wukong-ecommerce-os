# Production Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the production database to migration `0053` through a rehearsed, hash-verified,
time-bounded migration set, then release the Worker from `main` and ship #132, so signed-in
production works again.

**Architecture:** Four small, read-only or bounded tools in `@wukong/db`:

- per-file migration timeouts and progress logs
- a schema inventory
- a controlled migration-set builder
- a listing-read verifier

They are built and tested first against a disposable local Postgres. A local rehearsal then runs
the whole flow on a database deliberately stuck before `0046`. Finally the operational tasks
follow the spec's five checkpoints on a Neon rehearsal branch, then production.

**Tech Stack:** TypeScript, `postgres` driver, Vitest integration tests, tsx CLIs, wrangler 4,
Neon (console only), Vercel logs.

**Spec:** `docs/superpowers/specs/2026-10-08-production-recovery-design.md`

## Global Constraints

- No SHOPLINE writes. Production keeps `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`.
- Unchanged throughout: provider settings, Vercel env, Hyperdrive cache, database roles. Never create or alter roles.
- No down-migrations and no purges. Never run `wrangler queues purge`.
- Production and the rehearsal never get the full `drizzle/` directory. Only the controlled set in a temporary `DATABASE_MIGRATIONS_DIR`, with SHA256s matching `main`.
- Credentials come only from `C:\Users\laich\.wukong-prod.env` (`PROD_DATABASE_ADMIN_URL`, `PROD_DATABASE_URL`, `REHEARSAL_DATABASE_ADMIN_URL`, `REHEARSAL_DATABASE_URL`). Load them inside a single command and never echo them. Tool output never contains a URL, host or password.
- Logs are single-line `JSON.stringify({ event, ... })` with file names, counts and SQLSTATE codes only. No SQL text, error messages or row data.
- Checkpoints need the user's explicit go: (1) production inventory, (2) production migration, (3) secret delete, (4) Worker deploy, (5) #132 merge.
- Worker deploy settings are exactly: `AI_PROVIDER=opencode-go`, `OPENCODE_GO_LISTING_MODEL=deepseek-v4.1-flash`, `LISTING_PAID_OPERATIONS_ENABLED=true`, `PRODUCT_SHOT_PROVIDER=disabled`, plus `CLOUDFLARE_HYPERDRIVE_ID` and `WEBSITE_FETCH_BASE_URL` taken from the live version.
- Test databases are disposable localhost only. Integration tests refuse any other target (pattern: `src/schema-compatibility.integration.test.ts`).

## Review Focus

- **A connection URL is passed as a CLI argument or printed in an error.** Tools read URLs only from env, and failures print only `{event, code}`. Pinned in Tasks 2 and 4 (an error from a bad URL contains no part of the URL).
- **The inventory runs while another session holds locks.** The inventory must be read-only and must not take write locks. Pinned in Task 2 (it runs inside `BEGIN READ ONLY`; a write inside it fails).
- **The controlled set contains a file not on `main`, or a file edited after hashing.** The set builder rejects unknown names, and verifying the set fails on any byte change. Pinned in Task 3.
- **A migration waits on a lock held by the live app.** The runner fails fast with `55P03` and logs the file name instead of hanging. Pinned in Task 1.
- **A listing has no active version or no pipeline run.** The verifier treats `null` reads as normal and only `42703`/`42P01`/other errors as failures. Pinned in Task 4.

---

### Task 1: Migration runner with per-file timeouts and progress logs

**Files:**

- Create: `packages/db/src/migration-timeouts.ts`, `packages/db/src/migration-timeouts.test.ts`
- Modify: `packages/db/src/client.ts` (the `migrate()` method, around lines 550-578)
- Test: `packages/db/src/migration-runner.integration.test.ts`

**Interfaces:**

- Produces: `migrationTimeouts(env: NodeJS.ProcessEnv): { lockTimeoutMs: number | null; statementTimeoutMs: number | null }`.
  - Reads `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` and `DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS`.
  - Unset means `null` (today's behaviour).
  - Anything other than an integer in 1..600000 throws `Error("invalid migration timeout")` before any connection is made.
- `migrate()` behaviour, per file:
  - In its transaction, runs `SET LOCAL lock_timeout = '<n>ms'` and/or `SET LOCAL statement_timeout = '<n>ms'` before the file SQL.
  - Logs `{"event":"migration_started","name":"0046_….sql"}` and then either `{"event":"migration_applied","name":…,"ms":<int>}` or `{"event":"migration_failed","name":…,"code":"<SQLSTATE or error name>"}`, then rethrows.

- [ ] **Step 1: Write unit tests** in `migration-timeouts.test.ts`:
  - `{}` gives `{lockTimeoutMs:null, statementTimeoutMs:null}`.
  - `{DATABASE_MIGRATION_LOCK_TIMEOUT_MS:"5000", DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS:"120000"}` gives `{5000, 120000}`.
  - `"0"`, `"-1"`, `"1.5"`, `"abc"` and `"600001"` each throw `/invalid migration timeout/`.
- [ ] **Step 2: Run** `pnpm --filter @wukong/db exec vitest run src/migration-timeouts.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `migrationTimeouts`.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Write the integration test** `migration-runner.integration.test.ts`:
  - Guard: env `PRODREC_DATABASE_ADMIN_URL` plus `PRODREC_DISPOSABLE=yes`, host in `localhost/127.0.0.1/[::1]`, database `/prod_recovery_test`. Otherwise `describe.skip`.
  - Test: `it("fails fast with 55P03 and logs the file when a lock is held")`.
    - Set up a temp migrations dir containing one file, `9999_lock_probe.sql` = `ALTER TABLE lock_probe ADD COLUMN IF NOT EXISTS x int;`.
    - Create `lock_probe` and hold `LOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE` in a second connection's open transaction.
    - Set `DATABASE_MIGRATIONS_DIR` to the temp dir and `DATABASE_MIGRATION_LOCK_TIMEOUT_MS=200`.
    - Assert `createDatabase(url,{migrationUrl:url}).migrate()` rejects within 3 s with `code === "55P03"`.
    - Assert a captured `console.info`/`console.error` line parses to `{event:"migration_failed", name:"9999_lock_probe.sql", code:"55P03"}`.
  - Test: `it("logs started and applied for each file in order")`. Two small files, then assert the event sequence.
- [ ] **Step 6: Run** `PRODREC_DATABASE_ADMIN_URL=postgres://wukong:wukong@127.0.0.1:<port>/prod_recovery_test PRODREC_DISPOSABLE=yes pnpm --filter @wukong/db exec vitest run --config ../../vitest.integration.config.ts src/migration-runner.integration.test.ts`. Expected: FAIL.
- [ ] **Step 7: Modify `migrate()`** to read `migrationTimeouts(process.env)` before connecting, apply the `SET LOCAL`s, and log as specified. Error code is `error.code` if it's a string, else `error.name`.
- [ ] **Step 8: Run** Steps 2 and 6 again. Expected: PASS. Then `pnpm --filter @wukong/db test` and `pnpm typecheck`: all green.
- [ ] **Step 9: Commit** `feat(db): bound migration lock and statement time and log each file`.

### Task 2: Schema inventory module and CLI

**Files:**

- Create: `packages/db/src/schema-inventory.ts`, `packages/db/src/cli/schema-inventory.ts`, `packages/db/src/schema-inventory.integration.test.ts`
- Modify: `packages/db/package.json` (scripts `db:schema-inventory` and `db:schema-compatibility`, the latter running the existing `src/cli/schema-compatibility.ts`)
- Delete: `scripts/production-schema-inventory.sql` (moved into the module). Update the spec reference to `pnpm --filter @wukong/db db:schema-inventory`.

**Interfaces:**

- Produces: `SCHEMA_INVENTORY_SQL: string`, the same 13 marker checks as the deleted script (`0041`–`0053`).
- Produces: `inspectSchemaInventory(query: (sql: string) => Promise<Record<string, unknown>[]>): Promise<SchemaInventory>`, where:

  ```ts
  type SchemaInventory = {
    migrations: Record<string, boolean>; // "0041".."0053"
    missing: string[]; // ascending
    wukongAppRole: boolean;
    currentUser: string;
    counts: {
      listing_drafts: number;
      listing_versions: number;
      listing_pipeline_runs: number;
    };
    appGrants: Record<string, boolean>; // table -> has SELECT for wukong_app, for listing_assignments, listing_quality_assessments, workspace_quality_summaries, enrichment_batch_previews (absent table => false)
  };
  ```

- CLI behaviour: reads only `DATABASE_ADMIN_URL`, runs inside `BEGIN READ ONLY`, prints one JSON line `{"event":"schema_inventory",...SchemaInventory}`, and exits `2` if `missing.length > 0`. On connection or query error it prints only `{"event":"schema_inventory","ready":false,"code":"<SQLSTATE|name>"}` and exits `1`.

- [ ] **Step 1: Write the integration tests**, using the Task 1 guard and the `reset()`/`apply()` pattern from `schema-compatibility.integration.test.ts`:
  - All of `drizzle/` applied: `missing` is `[]`, `wukongAppRole` is `true`, every `appGrants` value is `true`.
  - Everything except `0046`, `0049`, `0050`, `0051`, `0052` and `0053` applied: `missing` equals `["0046","0049","0050","0051","0052","0053"]`.
  - `counts` equals the number of rows the test inserts into `listing_drafts` (insert 2): `counts.listing_drafts === 2`.
  - A write attempted inside the CLI's read-only transaction wrapper rejects with `code "25006"`.
  - The CLI, run via `execFile` with an unreachable `DATABASE_ADMIN_URL=postgres://u:secretpw@127.0.0.1:1/x`, exits `1`, and its stdout+stderr contain neither `secretpw` nor `127.0.0.1:1`.
- [ ] **Step 2: Run** them (command as in Task 1, Step 6). Expected: FAIL.
- [ ] **Step 3: Implement** the module and CLI. Add both package scripts. Delete the old SQL script and update the spec line.
- [ ] **Step 4: Run** the integration tests. Expected: PASS. Then `pnpm --filter @wukong/db test` and `pnpm typecheck`: green.
- [ ] **Step 5: Commit** `feat(db): add read-only schema inventory for production recovery`.

### Task 3: Controlled migration-set builder

**Files:**

- Create: `packages/db/src/migration-set.ts`, `packages/db/src/migration-set.test.ts`, `packages/db/src/cli/migration-set.ts`
- Modify: `packages/db/package.json` (script `db:migration-set`)

**Interfaces:**

- Produces: `buildMigrationSet(input: { sourceDir: string; include: string[]; outDir: string }): Promise<MigrationSetManifest>`.
  - `include` holds 4-digit prefixes such as `"0046"`.
  - Each prefix must match exactly one `^\d{4}_.+\.sql$` file in `sourceDir`, else throw `Error("unknown migration <prefix>")`.
  - `outDir` must not exist or must be empty, else throw `Error("output directory not empty")`.
  - Copies the bytes unchanged and writes `outDir/manifest.json`.
- Produces: `type MigrationSetManifest = { files: { name: string; sha256: string }[] }`, in ascending name order.
- Produces: `verifyMigrationSet(outDir: string, expected: MigrationSetManifest): Promise<void>`. Throws `Error("migration set mismatch <name>")` on any missing, extra or changed `.sql` file.
- CLI: `pnpm --filter @wukong/db db:migration-set --include 0046,0049 --out <dir>` builds the set and prints the manifest JSON. `--verify <manifest.json> --out <dir>` verifies, exiting `1` on mismatch.

- [ ] **Step 1: Write unit tests** with `mkdtemp`:
  - Building `["0046","0049"]` from a fixture dir holding `0045_a.sql`, `0046_b.sql` and `0049_c.sql` copies exactly two files. Their SHA256s equal `createHash("sha256")` of the source bytes, in ascending order.
  - `include ["0047"]` throws `/unknown migration 0047/`.
  - A non-empty `outDir` throws `/output directory not empty/`.
  - `verifyMigrationSet` passes on an untouched set.
  - It throws `/mismatch 0046_b.sql/` after appending one byte to that file.
  - It throws on an extra `.sql` file dropped into `outDir`.
- [ ] **Step 2: Run** `pnpm --filter @wukong/db exec vitest run src/migration-set.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the module, CLI and package script.
- [ ] **Step 4: Run** the same tests. Expected: PASS. Then `pnpm typecheck`: green.
- [ ] **Step 5: Commit** `feat(db): build and verify hash-pinned controlled migration sets`.

### Task 4: Listing-read verifier

**Files:**

- Create: `packages/db/src/listing-read-verify.ts`, `packages/db/src/cli/listing-read-verify.ts`, `packages/db/src/listing-read-verify.integration.test.ts`
- Modify: `packages/db/package.json` (script `db:listing-read-verify`)

**Interfaces:**

- Consumes: `createDatabase(url)`, `forWorkspace(workspaceId, repos => …)`, and these repository methods:
  - `listings.getReviewSnapshot`
  - `listings.getById`
  - `listingInputs.getCurrent`
  - `pipelineRuns.getCurrentOperation`
  - `pipelineRuns.getLatestState`
  - `wineEnrichment.readUsage(runId)` and `wineEnrichment.readStage(runId, stage)` for every `WineStage`, called only when `getCurrentOperation` returns a run (the same reads as `apps/web/lib/wine-progress.ts:134`)
- Produces: `verifyListingReads(database: Database, listings: { workspaceId: string; listingId: string }[]): Promise<ListingReadReport>`, where:

  ```ts
  type ListingReadReport = {
    checked: number;
    failures: { listingId: string; call: string; code: string }[];
  };
  ```

  - Every call runs, even after an earlier failure.
  - A `null` result is not a failure.
  - `code` is the SQLSTATE if present, else the error name.

- CLI behaviour: listing IDs come from `--listing <uuid>` (repeatable), plus `--sample <n>` (default 10). Workspace mapping and the sample come from `DATABASE_ADMIN_URL` via a read-only `select workspace_id, id from listing_drafts …`; the reads go through `DATABASE_URL`. It prints one JSON line `{"event":"listing_read_verify",checked,failures}` and exits `1` if `failures.length > 0`. Only IDs and codes are output, no content.

- [ ] **Step 1: Write the integration tests** (same guard):
  - Seed one workspace and one listing with an active version, using the same repository calls other `*.integration.test.ts` files in `packages/db/src/repositories` use.
  - Full schema: the report is `{checked:1, failures:[]}`.
  - After `ALTER TABLE listing_versions DROP COLUMN source_import_id CASCADE`, the failures include `{listingId, call:"getReviewSnapshot", code:"42703"}`.
  - A listing with no active version and no run yields `failures: []`.
  - Row counts of `listing_drafts`, `listing_versions` and `audit_events` are identical before and after a verify run.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the module, CLI and package script.
- [ ] **Step 4: Run** them. Expected: PASS. Then `pnpm --filter @wukong/db test` and `pnpm typecheck`: green.
- [ ] **Step 5: Commit** `feat(db): add read-only listing-read verifier for release checks`.

### Task 5: Local dress rehearsal, then ship the tooling

**Files:**

- Create: `docs/runbooks/production-recovery-2026-10-08.md`. This is the operator log: commands as run, outputs with no URLs, timings, and the checkpoint approvals with UTC times. Later tasks append to it.

- [ ] **Step 1: Prepare a broken database.** Start a disposable `postgres:17-alpine` on `127.0.0.1:54398`, create the `wukong_app` role (`docs/runbooks/local-development.md`) and a `prodrec_dress` database. Apply every `drizzle/` file except `0046`–`0053`, mimicking production.
- [ ] **Step 2: Inventory.** Run `db:schema-inventory` and `db:schema-compatibility`. Expected: `missing` is `["0046","0049","0050","0051","0052","0053"]` (`0047`/`0048` are present locally), and compatibility is `ready`.
- [ ] **Step 3: Verify reads.** Seed a listing, then run `db:listing-read-verify --sample 5`. Expected: exit 1 with `getReviewSnapshot` `42703`. This reproduces the production failure.
- [ ] **Step 4: Build the set.** Run `db:migration-set --include 0046,0049,0050,0051,0052,0053 --out <tmp>/set`, then `--verify`. Expected: 6 files, verify exit 0.
- [ ] **Step 5: Migrate.** Run `DATABASE_MIGRATIONS_DIR=<tmp>/set DATABASE_MIGRATION_LOCK_TIMEOUT_MS=5000 DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS=120000 pnpm --filter @wukong/db db:migrate`. Expected: 6 `migration_applied` lines.
- [ ] **Step 6: Re-check.** Run the inventory again (expected `missing: []`), then the read verifier (expected `failures: []`, exit 0) and `db:listing-read-preflight` (expected `ready`). Record all of it in the runbook.
- [ ] **Step 7: Clean up and ship.** Remove the container. Commit the runbook as `docs: record production recovery dress rehearsal`. Push the branch, open a PR, wait for green CI, and merge, with the user's go.

### Task 6: Checkpoint 1, production inventory (read-only)

- [ ] **Step 1: Ask for the go.** Confirm the user has created the credential file and both Neon branches (`pre-0053-restore-<UTC>`, `rehearsal-0053`), and has given explicit go for checkpoint 1.
- [ ] **Step 2: Production inventory.** From `main`, with `PROD_DATABASE_ADMIN_URL` exported as `DATABASE_ADMIN_URL` inside the command, run `db:schema-inventory` and `db:schema-compatibility`. With `PROD_DATABASE_URL` as `DATABASE_URL`, run `db:listing-read-preflight`. Record the JSON (no URLs) in the runbook.
- [ ] **Step 3: Decide the set.** The controlled set = `missing` plus each compatibility-group migration reported not ready. If `wukongAppRole` is `false`, STOP (abort rule).
- [ ] **Step 4: Rehearsal baseline.** Run the same inventory against the rehearsal URLs. Expected: identical to production (same branch point).

### Task 7: Neon rehearsal

- [ ] **Step 1: Build the set.** Build it from `main` with the decided includes, verify it, and record the manifest in the runbook.
- [ ] **Step 2: Migrate the rehearsal.** Run `db:migrate` against the rehearsal URLs with `DATABASE_MIGRATIONS_DIR` set and timeouts 5000/120000. Record each file's `ms`.
- [ ] **Step 3: Verify the rehearsal.**
  - Inventory: `missing []`, `counts` equal to the baseline, all `appGrants` `true`.
  - Compatibility: `ready`.
  - `db:listing-read-verify --listing 07cd4aa6-42d7-4489-a569-95188652b7af --sample 20`: `failures []`.
  - `db:listing-read-preflight`: ready.
- [ ] **Step 4: Report go/no-go.** Write it in the runbook and send it to the user: total time, the longest file, any surprise. Any failure means production is not touched today.

### Task 8: Checkpoint 2, production migration

- [ ] **Step 1: Prepare the window.** Get the user's go. The user confirms Opak operators are paused, and the restore branch timestamp is recorded.
- [ ] **Step 2: Pause delivery.** `wrangler queues pause-delivery wukong-listing-production`.
- [ ] **Step 3: Check the set.** Rebuild the set from `main` and `--verify` it against the rehearsal manifest. Expected: exit 0, no mismatch.
- [ ] **Step 4: Migrate production.** Same command as Task 7, Step 2, against the production URLs.
- [ ] **Step 5: Verify the database.** Same checks as Task 7, Step 3, against production.
- [ ] **Step 6: Verify the app.**
  - The user opens `/listings/07cd4aa6-…`, the work queue and the catalog signed in.
  - Vercel production logs from the migration time onward show no `schema_unavailable` and 200s on those routes.
- [ ] **Step 7: Resume.** `wrangler queues resume-delivery wukong-listing-production`. Watch runtime errors and the DLQ for 30 minutes.

### Task 9: Checkpoints 3–4, secret and Worker deploy

- [ ] **Step 1: Delete the obsolete secret.** With the user's go, and the user confirming they hold a rollback copy: `wrangler secret delete OPENAI_API_KEY --name wukong-runtime-production`.
- [ ] **Step 2: Build.** From a clean checkout of `main`, export the Global Constraints Worker settings plus `BUILD_SHA=$(git rev-parse HEAD)`, then `pnpm turbo run build --filter='./packages/*'`.
- [ ] **Step 3: Deploy.** With the user's go: `pnpm --filter @wukong/worker deploy:production`. Expected: runtime doctor OK, secrets preflight passes, deploy succeeds.
- [ ] **Step 4: Verify the Worker.**
  - `GET /health` shows `BUILD_SHA` = `main` and provider `opencode-go`.
  - `runtime:doctor production` (full) passes.
  - The DLQ count is unchanged.

### Task 10: Checkpoint 5, #132 release and canary

- [ ] **Step 1: Pause and merge.** With the user's go, pause delivery and merge #132. Wait for the Vercel production build to succeed.
- [ ] **Step 2: Redeploy the Worker** from the new `main` with the Task 9, Step 2 settings, then run `deploy:production`.
- [ ] **Step 3: Confirm the versions.** `packages/core/src/listing-prompt-versions.ts` on `main` shows `1.2.0`/`1.1.0`, `/health` shows the new `BUILD_SHA`, then resume delivery.
- [ ] **Step 4: Smoke test.** The user starts one billed processing run. It completes with no "Accepted prompt versions are unavailable", and the output and cost look sane.
- [ ] **Step 5: Canary for 30 minutes:**
  - signed-out routes and security headers
  - signed-in checks by the user
  - Vercel runtime errors
  - DLQ
- [ ] **Step 6: Close out.** Record everything in the runbook. Ask the user to delete `.wukong-prod.env` and the rehearsal branch. Keep the restore branch at least 7 days. Commit the runbook (`docs: record production recovery`) via a PR.
