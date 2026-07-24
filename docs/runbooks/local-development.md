# Local development

This runbook uses only synthetic data. Never put a SHOPLINE token, OpenAI key, SMTP credential, or customer document in the repository.

## Start local dependencies

From PowerShell at the repository root:

```powershell
docker compose up -d --force-recreate postgres minio minio-tls mailpit
docker compose exec -T postgres psql -U wukong -d postgres -v ON_ERROR_STOP=1 -c 'DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ''wukong_app'') THEN CREATE ROLE wukong_app LOGIN PASSWORD ''wukong-app-local'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $$;'
$env:DATABASE_ADMIN_URL = "postgres://wukong:wukong@localhost:54329/wukong"
$env:DATABASE_URL = "postgres://wukong_app:wukong-app-local@localhost:54329/wukong"
$env:TEST_DATABASE_ADMIN_URL = $env:DATABASE_ADMIN_URL
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:S3_BUCKET = "wukong-local"
$env:S3_ENDPOINT = "http://localhost:9010"
$env:S3_REGION = "us-east-1"
$env:S3_ACCESS_KEY_ID = "wukong"
$env:S3_SECRET_ACCESS_KEY = "wukong-secret"
$env:S3_FORCE_PATH_STYLE = "true"
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @wukong/db... build
corepack pnpm --filter @wukong/db db:migrate
```

The migration is safe to run repeatedly. For the synthetic Opak workspace, use a deliberately non-routable operator address and seed twice to verify idempotency:

```powershell
$env:OPAK_OPERATOR_EMAIL = "operator@example.invalid"
corepack pnpm --filter @wukong/db exec tsx src/seed-opak.ts
corepack pnpm --filter @wukong/db exec tsx src/seed-opak.ts
```

## Run the web app and Wrangler

Normal application development can run the web app independently:

```powershell
corepack pnpm --filter @wukong/web dev
```

For the complete Queue boundary, use the Playwright real-stack fixture. It starts a production-built Next server and `wrangler dev` on loopback, renders non-production Queue names, and sets `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` only for the local Wrangler process. Wrangler supplies the local Queue simulation; external AI and SHOPLINE adapters remain fake/mock.

```powershell
$env:PLAYWRIGHT_E2E = "1"
corepack pnpm exec playwright test --project=chromium --workers=1 --reporter=line
```

The fixture uses Postgres, MinIO, and Mailpit. It never calls a pipeline or SHOPLINE publishing helper from the test process. It uploads synthetic assets, sends signed requests through the ordinary Worker ingress, waits for Queue consumers, validates a signed object URL, and writes the accepted draft ID to `test-results/real-stack-draft-id.txt`.

## Verification commands

```powershell
corepack pnpm format:runtime:check
corepack pnpm runtime:forbidden:check
corepack pnpm --filter @wukong/db... build
corepack pnpm --filter @wukong/db db:migrate
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
$env:PLAYWRIGHT_E2E = "1"
corepack pnpm exec playwright test --project=chromium --workers=1 --reporter=line
```

Audit the exact completed synthetic draft:

```powershell
corepack pnpm --filter @wukong/db audit:verify --workspace ws_opak --draft <draft-uuid>
```

The verifier must report missing action count `0` and accessible foreign-record count `0`.
