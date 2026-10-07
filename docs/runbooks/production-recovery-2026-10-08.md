# Production recovery operator log (2026-10-08)

Spec: `docs/superpowers/specs/2026-10-08-production-recovery-design.md`.
Plan: `docs/superpowers/plans/2026-10-08-production-recovery.md`.

This log records commands as run, outputs with no connection details, timings, and each
checkpoint approval in UTC. Tasks 6–10 append to it.

## Tooling (`@wukong/db`)

| Script                      | What it does                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:schema-inventory`       | Read-only (`SET TRANSACTION READ ONLY`). One marker per migration `0041`–`0053`, `wukong_app` role, row counts, grants. Reads `DATABASE_ADMIN_URL`; exit 2 when something is missing                    |
| `db:schema-compatibility`   | Existing `0023`–`0027` checks, including drifted function bodies                                                                                                                                        |
| `db:migration-set`          | `--include` exact names or unique 4-digit prefixes, `--out <dir>`: copies files byte for byte and writes `manifest.json` (SHA256). `--verify <manifest>` fails on any change                            |
| `db:migrate`                | Honours `DATABASE_MIGRATIONS_DIR`, `DATABASE_MIGRATION_LOCK_TIMEOUT_MS` and `DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS`. Logs `migration_started`/`_applied`/`_failed` per file (name, ms, SQLSTATE)      |
| `db:listing-read-verify`    | The listing detail reads through `DATABASE_URL` (runtime role), with IDs from `DATABASE_ADMIN_URL`. `failures` (exit 1) vs `isolated` (invalid stored content, which the route shows as a blocked read) |
| `db:listing-read-preflight` | Existing runtime-role readiness check                                                                                                                                                                   |

## Local dress rehearsal (2026-10-08, disposable Postgres 17, `127.0.0.1:54399/prodrec_dress`)

The database was built with every `drizzle/` file except `0046` and `0049`–`0053` (50 of 56
files; the repo has two `0008_*` and two `0015_*`), mimicking production.

| Step                                                       | Result                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:schema-inventory`                                      | `missing: ["0046","0049","0050","0051","0052","0053"]`, `wukongAppRole: true`                                                                                  |
| `db:schema-compatibility`                                  | `ready: true`, `missing: []`                                                                                                                                   |
| `db:listing-read-verify --listing 07cd4aa6-…`              | **exit 1: `getReviewSnapshot` `42703`.** Reproduces the production failure                                                                                     |
| `db:migration-set --include 0046,0049,0050,0051,0052,0053` | 6 files. `0046_listing_version_source_binding.sql` SHA256 starts `b41a241ffcdf`, matching the hash approved in `opak-production-repair-proposal-2026-10-03.md` |
| `--verify`                                                 | `migration_set_verified`                                                                                                                                       |
| `db:migrate` (set, lock 5000 ms, statement 120000 ms)      | 6 × `migration_applied`: `0046` 48 ms, `0049` 14 ms, `0050` 33 ms, `0051` 9 ms, `0052` 24 ms, `0053` 60 ms                                                     |
| `db:schema-inventory`                                      | `missing: []`, counts unchanged (1 draft, 1 version), all four `appGrants` true                                                                                |
| `db:listing-read-verify`                                   | **exit 0.** `failures: []`. One `isolated` `ListingDataError` from the deliberately empty test content                                                         |
| `db:listing-read-preflight`                                | `ready: true`, `missing: []`                                                                                                                                   |

Conclusion: the controlled set takes a database in production's documented state to full read
health in well under a second on an empty dataset. Production timings come from the Neon
rehearsal (Task 7).
