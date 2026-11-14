# Local development

This runbook uses only synthetic data. Never put a SHOPLINE token, OpenAI key, SMTP credential, or customer document in the repository.

## POSIX shell setup

Use Node 24+, Corepack with the repository's pnpm 11.7.0 pin, and Docker Compose
v2 with inline `configs.content` support. Run from the repository root in a
dedicated local shell. These credentials are for disposable local containers.
The Compose project is shared by worktrees; inspect `docker compose ps` before
starting or recreating services. This setup does not stop or delete containers.

```sh
corepack pnpm install --frozen-lockfile
docker compose ps
docker compose -f docker-compose.yml -f - up -d postgres minio minio-tls mailpit <<'YAML'
services:
  minio:
    environment:
      MINIO_API_CORS_ALLOW_ORIGIN: http://localhost:3000,http://127.0.0.1:49217
YAML
docker compose exec -T postgres sh -c 'until pg_isready -U wukong; do sleep 1; done'
docker compose exec -T postgres psql -U wukong -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
    CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
SQL
export DATABASE_ADMIN_URL='postgres://wukong:wukong@localhost:54329/wukong'
export DATABASE_URL='postgres://wukong_app:wukong-app-local@localhost:54329/wukong'
export S3_BUCKET=wukong-local S3_ENDPOINT=http://localhost:9010 S3_REGION=us-east-1
export S3_ACCESS_KEY_ID=wukong S3_SECRET_ACCESS_KEY=wukong-secret S3_FORCE_PATH_STYLE=true
export AUTH_SECRET='local-only-auth-secret-at-least-thirty-two-characters'
export AUTH_SMTP_URL=smtp://127.0.0.1:1026
export AUTH_EMAIL_FROM='Wukong Local <auth@local.invalid>'
export BETTER_AUTH_URL=http://localhost:3000
export SHOPLINE_TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export AI_PROVIDER=fake SHOPLINE_ADAPTER=mock
export LISTING_PAID_OPERATIONS_ENABLED=false WINE_ENRICHMENT_ENABLED=false
pnpm --filter @wukong/db... build
pnpm --filter @wukong/db db:migrate
OPAK_OPERATOR_EMAIL=operator@example.invalid pnpm --filter @wukong/db seed:opak
```

The inline Compose override permits browser uploads from the development origin
and the real-stack test origin. Reuse it when recreating MinIO; plain
`docker compose up` restores the checked-in E2E-only origin. Wait for MinIO's
`http://localhost:9010/minio/health/ready` endpoint to return HTTP 200, then create
the local bucket (Compose starts storage but does not create buckets):

```sh
node --input-type=module <<'JS'
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
const client = new S3Client({
  endpoint: 'http://localhost:9010', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'wukong', secretAccessKey: 'wukong-secret' },
});
const bucket = { Bucket: 'wukong-local' };
try {
  try { await client.send(new HeadBucketCommand(bucket)); }
  catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand(bucket));
  }
  await client.send(new HeadBucketCommand(bucket));
} finally { client.destroy(); }
JS
pnpm --filter '@wukong/web^...' build
env -u DATABASE_ADMIN_URL pnpm --filter @wukong/web dev
```

Open `http://localhost:3000`; auth mail is captured at
`http://localhost:8026`. The seed creates the invited synthetic operator. Use
the registration/enrollment flow and captured mail to establish credentials.
The standalone web server does not start a Queue consumer. Use the
[real-stack harness](testing.md#browser-tests) for processing/delivery flows.

Do not use the development database for integration/browser tests: several suites
truncate shared tables. See [disposable test setup](testing.md#database-integration-tests).
No automatic `.env` loading is assumed for CLI commands; export variables in the
shell that launches them. `.env.example` is an inventory, not a complete runnable
local configuration.

## Start local dependencies

From PowerShell at the repository root, use the stable `wukong-ecommerce-local` Compose project declared in `docker-compose.yml`. Every worktree therefore owns the same local service set instead of leaving competing containers on the fixed ports. Inspect the shared Compose project, stop only that named project, then recreate its services from the current checkout:

```powershell
docker compose ps
docker compose down --remove-orphans
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

`--force-recreate` replaces the shared project containers from the current worktree, including the MinIO TLS container and its local CA. Before `down`, stop if `docker compose ps` shows an unexpected image or service; do not remove unrelated Docker projects. The migration is safe to run repeatedly. For the synthetic Opak workspace, use a deliberately non-routable operator address and seed twice to verify idempotency:

```powershell
$env:OPAK_OPERATOR_EMAIL = "operator@example.invalid"
corepack pnpm --filter @wukong/db exec tsx src/seed-opak.ts
corepack pnpm --filter @wukong/db exec tsx src/seed-opak.ts
```

## Run the web app and Wrangler

Normal application development can run the web app independently. Build its workspace
dependencies first; both development and production resolve their compiled JavaScript:

```powershell
corepack pnpm --filter '@wukong/web^...' build
corepack pnpm --filter @wukong/web dev
```

After editing a shared package, rerun the dependency build and restart the web dev
server. The shared packages do not have a watch build. Starting `dev` directly (or
through `pnpm dev`) does not build missing or stale `dist` files automatically.
Keep `.js` relative imports in shared TypeScript packages: they target emitted ESM.
When changing package export maps, a persisted Next development cache can still
resolve an old entry. If restarting still reports a `packages/*/src` module-not-found
error, stop the dev server, remove only the generated `apps/web/.next/dev` directory,
then restart it after the dependency build.

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
