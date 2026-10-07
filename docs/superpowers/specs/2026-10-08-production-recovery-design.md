# Production recovery design (2026-10-08)

## Problem

Signed-in production is failing. Support ID `ebaddb98-a65e-4b60-9000-1ce892f54d4b`
(`GET /api/listings/07cd4aa6-…`, 2026-10-07 16:58 UTC, commit `8e1777ad`) returned
`schema_unavailable`. The same user hit the same error more than 50 times in 20 minutes. Every
listing detail page fails.

The cause is a production database behind the deployed code:

- `getReviewSnapshot` (`packages/db/src/repositories/listings.ts:665`) reads every
  `listing_versions` column, including `source_import_id` and `source_row_digest`
  (`packages/db/src/schema.ts:331-332`). Migration `0046` adds those columns. The Opak runbooks
  record production without them (`docs/runbooks/opak-cloud-readonly-refresh-2026-10-02.md`).
- `readIsolatedListing` re-throws anything that is not a `ListingDataError`
  (`apps/web/lib/listing-read-resilience.ts:42`), so the missing column becomes a 500.
- The deployed web code (`main`) expects up to `0053`. Production's state for `0041`–`0045` is
  unrecorded, and the listing detail page also reads wine tables (`0041`+) when an operation is
  active.
- The production Worker is build `3ca5b995` (2026-09-16), built for migrations up to `0040`. It
  runs paid listing AI (`opencode-go`) and keeps the obsolete `OPENAI_API_KEY` secret, so
  `deploy:production` aborts today.
- #132 (prompt hardening) changes prompt versions that the web app pins and the Worker checks, so
  the two must ship together.

## Goal and success criteria

- Signed-in listing detail, work queue and catalog load in production without `schema_unavailable`.
- The production database is at migration `0053`, with row counts unchanged and the required grants
  in place.
- The production Worker runs `main` with today's provider settings unchanged.
- #132 is live, with web and Worker both on extraction `1.2.0` / generation `1.1.0`.
- 30 minutes of clean canary afterwards.

## Decisions (user, 2026-10-08)

- **Scope change:** for this phase only, Claude runs production database operations. This overrides
  the original audit brief's "no production migrations". Each production step still needs an
  explicit go.
- **Restore point:** a Neon branch of production, taken before any migration. The user is the
  restore owner.
- **Target:** migrate all the way to `0053` in one controlled run, not just `0046`.
- **Approach A:** rehearse on a Neon branch, then migrate production in place. Rejected:
  cutting over to a migrated branch (configuration changes on two platforms, lost writes) and
  migrating production with no rehearsal.

## Constraints

- No SHOPLINE writes. Production keeps `SHOPLINE_ADAPTER=disabled` and
  `SHOPLINE_PUBLISH_ENABLED=false`.
- Unchanged throughout: provider settings, Vercel environment variables, Hyperdrive cache, database
  roles. Claude never creates or alters roles.
- No down-migrations and no purges. Queues, DLQs, R2 objects, ledgers and audits are kept.
- `db:migrate` re-runs every file `0000`–`0053` each time (no ledger). Several files take table
  locks (`0053` locks `workspaces`, `listing_drafts`, `listing_input_revisions`,
  `listing_versions`, `platform_products` and `ai_runs`) and backfill. Many grant to `wukong_app`.

## Section 1: Access and safety rails

- **Credential file.** The user creates `C:\Users\laich\.wukong-prod.env`, outside the repo, with
  these lines:
  - `PROD_DATABASE_ADMIN_URL`
  - `PROD_DATABASE_URL`
  - `REHEARSAL_DATABASE_ADMIN_URL`
  - `REHEARSAL_DATABASE_URL`

  Claude loads it only inside a single command. It never prints, logs or commits a value, and
  filters output so hosts and passwords cannot appear. The user deletes the file afterwards.

- **Branches.** The user creates both in the Neon console (Claude has no Neon API access):
  - `pre-0053-restore-<UTC>`: the restore point, never touched.
  - `rehearsal-0053`: the copy migrated first.
- **Checkpoints.** Claude stops for an explicit go before each of these:
  1. First production read (inventory).
  2. Production migration.
  3. Removing `OPENAI_API_KEY`.
  4. Worker deploy.
  5. Merging #132.
- **Abort rule.**
  - Unexpected rehearsal error: production is not touched that day.
  - Production migration error: stop and diagnose read-only. The user chooses fix-forward or
    restore.
  - Missing `wukong_app` role: stop and escalate. No roles are created.

## Section 2: Inventory and rehearsal

1. **Production inventory (checkpoint 1, read-only).** Run `scripts/production-schema-inventory.sql` (read-only; checked against a local database on 2026-10-08), which reports
   one row per migration `0041`–`0053` by marker object. Also:
   - the `wukong_app` role exists
   - the role the runtime URL connects as
   - a baseline of row counts for `listing_drafts`, `listing_versions` and `listing_pipeline_runs`
2. **Rehearsal migration.** Run `pnpm --filter @wukong/db db:migrate` from `main` against the
   rehearsal branch. Record the total time, any failing file, and the `0053` lock duration.
3. **Rehearsal verification (read-only):**
   - The inventory shows `0041`–`0053` all present.
   - Row counts are unchanged, and the `0053` quality backfill created rows.
   - `has_table_privilege('wukong_app', …)` holds for the new tables.
   - A read-only script runs, through the runtime role, the repository calls the listing detail
     route makes for `07cd4aa6-…` and a sample of listings:
     - `getReviewSnapshot`
     - `getById`
     - `listingInputs.getCurrent`
     - `getCurrentOperation`
     - `getState` or `getLatestState`
     - `readWineProgress`

     Pass means no `42703`/`42P01` and a non-null snapshot.

   - The `0043` sweeper functions exist and can be called.
4. **Go/no-go report** to the user. A clean rehearsal is the precondition for checkpoint 2.

## Section 3: Production migration (checkpoint 2)

1. **Quiet window.**
   - Opak operators pause for the rehearsal time plus a margin.
   - `wrangler queues pause-delivery wukong-listing-production`. Messages are held, not lost.
   - Confirm the restore branch was taken just before.
2. **Migrate.** The same `db:migrate` command from `main`, against the production URLs. Output is
   filtered.
3. **Verify the database.** The same checks as the rehearsal: inventory, row counts, grants, and
   the listing detail read script.
4. **Verify the app.**
   - Vercel production logs show no `schema_unavailable` after the migration.
   - The user opens `/listings/07cd4aa6-…`, the work queue and the catalog signed in. Claude
     never uses the user's login.
   - Logs show 200s for those requests.
5. **Resume.** `wrangler queues resume-delivery wukong-listing-production`. Operators continue.
   Watch errors and the DLQ for 30 minutes.
6. **On failure.**
   - Partway through the migration: diagnose read-only. The user chooses fix-forward or restore
     from the restore branch.
   - Migration succeeds but the app still fails: open a new debugging task. Do not restore.

## Section 4: Worker release, then #132 (checkpoints 3–5)

Runs straight after Section 3. The September Worker should tolerate the additive schema, but
this cannot be rehearsed, so the gap stays short.

1. **Secret (checkpoint 3).**
   `wrangler secret delete OPENAI_API_KEY --name wukong-runtime-production`. The user keeps a
   rollback copy; Claude never sees the value.
2. **Deploy (checkpoint 4).** From a clean `main`:
   - Export the live settings: `AI_PROVIDER=opencode-go`,
     `OPENCODE_GO_LISTING_MODEL=deepseek-v4.1-flash`, `LISTING_PAID_OPERATIONS_ENABLED=true`,
     `PRODUCT_SHOT_PROVIDER=disabled`, plus `CLOUDFLARE_HYPERDRIVE_ID` and `WEBSITE_FETCH_BASE_URL`
     read from the live version, and `BUILD_SHA=<main sha>`.
   - Build the packages, then run `pnpm --filter @wukong/worker deploy:production`. Its doctor and
     secrets checks must pass.
   - Verify: `GET /health` shows the new build and `opencode-go`, full
     `runtime:doctor production` passes, and the DLQ count is unchanged.
3. **Prompt release (checkpoint 5).**
   - Pause delivery.
   - Merge #132; Vercel redeploys the web app.
   - Redeploy the Worker from the new `main` with the same settings.
   - Confirm both pin `1.2.0`/`1.1.0`, then resume delivery.
4. **Smoke test.** The user triggers one real, billed processing run. Confirm it completes without
   "Accepted prompt versions are unavailable", and that output and cost are sane.
5. **Rollback.**
   - Worker: `wrangler rollback`. Going back to `6842b51c` (September) is valid only before #132.
   - Web: Vercel instant rollback.
   - Database: stays migrated (additive).

## Out of scope

- The production runtime role. Per the runbooks, Hyperdrive and the web app may connect as the
  owner role, which bypasses RLS. This design does not change roles; it is a separate follow-up.
- Hardening against schema drift: a readiness check, and a clear page instead of a 500 when a
  schema read fails.
- SHOPLINE enablement, paid quality evaluation, and Opak UAT gates.

## Risks

| Risk                                              | Mitigation                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A migration fails on production data or roles     | Rehearsal on a branch copy first; abort rule; restore branch                               |
| `0053` locks block writes                         | Quiet window plus paused queue delivery; lock time measured in rehearsal                   |
| The September Worker misbehaves on the new schema | Additive migrations; Worker deploy follows immediately; DLQ watch                          |
| Prompt-version skew while #132 deploys            | Delivery paused; Worker redeployed immediately after merge                                 |
| The credential appears in a transcript            | Loaded only inside one command; output filtered; file kept outside the repo, deleted after |
