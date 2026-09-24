# Local verification and evidence reproduction

Run from the `astra6-recovery` worktree with Node 24 and pnpm 11.7. The normal unit/type checks do not require provider credentials.

```powershell
pnpm.cmd install --frozen-lockfile --offline
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd format:runtime:check
```

## Isolated integration services

The repository's integration suites include destructive resets of test tables. Always set **both** database URLs to the same dedicated local database. The recorded broad run uses `astra6_validation`; it is separate from browser fixtures and merchant databases. Create it once on the existing local PostgreSQL container if absent. Never point this command at production.

```powershell
docker exec wukong-ecommerce-local-postgres-1 createdb -U wukong astra6_validation
$env:TEST_DATABASE_URL='postgres://wukong_app:wukong-app-local@localhost:54329/astra6_validation'
$env:TEST_DATABASE_ADMIN_URL='postgres://wukong:wukong@localhost:54329/astra6_validation'
$env:S3_BUCKET='wukong-local'
$env:S3_ENDPOINT='https://localhost:9012'
$env:S3_REGION='us-east-1'
$env:S3_FORCE_PATH_STYLE='true'
$env:S3_ACCESS_KEY_ID='wukong'
$env:S3_SECRET_ACCESS_KEY='wukong-secret'
$env:NODE_EXTRA_CA_CERTS=(Resolve-Path '.wrangler/caddy-data/caddy/pki/authorities/local/root.crt').Path
pnpm.cmd test:integration
```

These are the public local Docker fixture credentials from the repository, not production credentials. The local object bucket and Caddy certificate must first be provisioned using the existing real-stack fixture. Do not change the global TLS policy. The first S3 regression rerun used a process-scoped local TLS bypass; subsequent verification can trust the fixture CA as shown above.

The separately guarded T01 fresh/drifted-schema rehearsal requires its own explicitly disposable `t01_compatibility` database and opt-in. It is skipped in the broad suite by design. Do not run its schema reset while another process uses that database.

## Runtime evidence

`tests/integration/recovery-cohort.integration.test.ts` executes 50 operations through the real consumer/repositories with a synthetic provider and in-memory transport. It writes exact IDs and outcomes to `test-results/astra6-consumer-cohort.json`. The delivered capture is copied to `docs/implementation/evidence/astra6/t19-consumer-cohort.json`.

The native/connected Playwright fixtures own web port 49217 and Worker port 8787. Do not launch two real-stack runs concurrently. Both database URLs must target the browser's dedicated database; a registration response deliberately does not disclose whether the invitation exists, so a mismatched seed target can otherwise look like missing email.

Mocked providers and SHOPLINE adapters establish local execution behavior only. Production canaries, merchant photos, remote queue/DLQ behavior and attended SHOPLINE acceptance have separate authorization and evidence gates in the delivery report.
