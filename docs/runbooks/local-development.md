# Local development

This runbook uses only synthetic data and the local Docker services. Do not put a SHOPLINE token, OpenAI key, SMTP credential, or customer document in the repository.

## Start the dependencies

From PowerShell at the repository root:

```powershell
docker compose up -d postgres redis minio mailpit
$env:DATABASE_ADMIN_URL = "postgres://wukong:wukong@localhost:54329/wukong"
$env:DATABASE_URL = $env:DATABASE_ADMIN_URL
$env:TEST_DATABASE_ADMIN_URL = $env:DATABASE_ADMIN_URL
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:REDIS_URL = "redis://localhost:6389"
$env:S3_BUCKET = "wukong-local"
$env:S3_ENDPOINT = "http://localhost:9010"
$env:AWS_ACCESS_KEY_ID = "wukong"
$env:AWS_SECRET_ACCESS_KEY = "wukong-secret"
pnpm.cmd install --frozen-lockfile
pnpm.cmd --filter @wukong/db db:migrate
```

The migration is safe to run repeatedly. For the synthetic Opak workspace, set an intentionally non-routable operator address and seed twice to check idempotency:

```powershell
$env:OPAK_OPERATOR_EMAIL = "operator@example.invalid"
pnpm.cmd --filter @wukong/db exec tsx src/seed-opak.ts
pnpm.cmd --filter @wukong/db exec tsx src/seed-opak.ts
```

## Run the app and worker

In separate PowerShell windows (keep the dependency window running):

```powershell
pnpm.cmd --filter @wukong/web dev
```

The worker runtime requires a database, Redis, object storage bucket, and an AI provider. For a local fake-AI run, inject a fake `ListingAIProvider` in the worker harness; the production runtime intentionally requires `OPENAI_API_KEY` and never silently falls back to fake output. A minimal local queue smoke check is:

```powershell
pnpm.cmd --filter @wukong/worker test -- src/queue.integration.test.ts
```

## Verification commands

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd test:integration
pnpm.cmd build
$env:PLAYWRIGHT_E2E = "1"
pnpm.cmd exec playwright install chromium
pnpm.cmd test:e2e
```

When browser binaries are unavailable, leave `PLAYWRIGHT_E2E` unset: the Playwright spec is skipped safely and CI can install Chromium explicitly. Audit a completed synthetic draft with:

```powershell
pnpm.cmd --filter @wukong/db audit:verify --workspace ws_opak --draft <draft-uuid>
```

The command reports the chronological actions, missing action count, and accessible foreign-record count; it exits non-zero if either count is non-zero.
