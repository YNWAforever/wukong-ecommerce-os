# Testing

Run commands from the repository root with Node 24+ and pnpm 11.7.0. Install with
`corepack pnpm install --frozen-lockfile`. Use the existing injected dependencies
for unit tests; do not supply real provider keys to prove a synthetic flow.

## Fast checks

```sh
pnpm test
pnpm typecheck
pnpm format:runtime:check
pnpm runtime:forbidden:check
pnpm release-gate:check
```

`pnpm test` runs the root Node suites followed by Turbo's unit tasks in all apps
and packages, with shared dependency builds. `*.integration.test.ts` files are
excluded. Turbo may reuse unchanged results; use `pnpm test --force` only when
you need to invalidate Turbo's test cache (or run a focused Vitest command below).
On constrained machines, `pnpm test --force --concurrency=1` serializes Turbo's
package tasks. Each package still runs its full unit suite with its existing
Vitest file parallelism and timeouts.
`lint` is also `tsc --noEmit`. The format gate selects **committed** runtime/docs
files changed since the merge base with `RELEASE_BASE_SHA` (falling back to
`origin/main`, then `HEAD^`). It reads their current working-tree contents, but
does not select a newly edited file absent from that committed diff. Before
committing, also run `pnpm exec prettier --check <edited-files>` on the files you
changed.
`release-gate:check` validates repository configuration, not a deployment.

After building shared dependencies, run focused regressions directly:

```sh
pnpm --filter '@wukong/worker^...' build
pnpm --filter @wukong/core exec vitest run src/workflow.test.ts
pnpm --filter @wukong/worker exec vitest run src/ingress.test.ts src/publish-product.test.ts src/shopline-consumer.test.ts
```

The workflow matrix covers every status/action pair, including approval
invalidation by input edits, manual recovery and forbidden edits during publishing.
Every legal transition must wait for its audit write and propagate audit failure.
Ingress tests cover exact signed bytes/path, UTF-8 characters split across chunks,
the inclusive 4 KiB byte boundary despite an underreported `Content-Length`,
oversized stream cancellation and delayed/failed Queue acceptance on both listing
and SHOPLINE routes. `202` means the Queue accepted the message; it does not prove
consumer execution or a persisted listing. Publish tests inject connector/storage
failures and check reconciliation and idempotency. These prove contracts with
fakes, not live provider behavior.

## Database integration tests

These tests migrate, truncate or delete data. Use only a disposable database on
the local Compose Postgres; do not inherit a deployed `DATABASE_URL`. The
following uses the repository's named local container, an explicit new database
and separate app/admin roles. Complete the role setup in
[local development](local-development.md#posix-shell-setup) first.

```sh
docker compose ps postgres
docker compose exec -T postgres createdb -U wukong wukong_docs_test
export TEST_DATABASE_ADMIN_URL='postgres://wukong:wukong@localhost:54329/wukong_docs_test'
export TEST_DATABASE_URL='postgres://wukong_app:wukong-app-local@localhost:54329/wukong_docs_test'
DATABASE_ADMIN_URL="$TEST_DATABASE_ADMIN_URL" DATABASE_URL="$TEST_DATABASE_URL" \
  pnpm --filter @wukong/db db:migrate
pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/listings.integration.test.ts
```

`createdb` should fail if the database already exists: inspect it rather than
silently reusing unknown data. The selected suite proves workspace isolation,
RLS and repository behavior. Never run a second integration process against the
same database. Root integration config serializes files because they share tables.

For **all** integration suites, follow the isolated database/cohort setup in
[CI](../../.github/workflows/ci.yml), then run `pnpm test:integration`. Some suites
require exact database names: wine uses `wukong_wine_sdd`, and Opak cohorts have
their own guards. Pointing the whole suite at the example database above will
not satisfy those guards. Storage tests additionally need the synthetic MinIO
configuration from local setup. A skipped suite is not passing evidence.

## Browser tests

Install Chromium once with `pnpm exec playwright install --with-deps chromium`.
Use disposable Postgres plus MinIO, its Caddy TLS proxy, and Mailpit from local
setup. Set both `TEST_DATABASE_*` variables explicitly to the disposable
database. Ensure `.wrangler/caddy-data/caddy/pki/authorities/local/root.crt` is
readable by the test process; CI documents the container ownership handling.

Auth-only mode starts Next dev on port 49219 and uses Mailpit for real local
email/password enrollment. The auth fixture resets auth tables and the mail sink:

```sh
env -u PLAYWRIGHT_E2E -u PLAYWRIGHT_BASE_URL \
  pnpm exec playwright test tests/admin-password-auth.e2e.spec.ts --project=chromium --workers=1 --retries=0
```

The real-stack mode builds Next, starts it on 49217 and starts local Wrangler
(normally 8787) with the local Queue simulation. It supplies fake AI and mock
SHOPLINE, synthetic files and local Hyperdrive configuration. Port 49218 is
reserved for its public-image TLS fixture. Use the same disposable database:

```sh
PLAYWRIGHT_E2E=1 pnpm exec playwright test tests/e2e/listing-pilot.spec.ts --project=chromium --workers=1 --retries=0
```

For the broader real-stack suite use `PLAYWRIGHT_E2E=1 pnpm test:e2e`. Product-shot
and wine acceptance are separately gated by `WUKONG_PRODUCT_SHOT_E2E=1` and
`WUKONG_WINE_E2E=1`; reproduce their dedicated CI steps and database setup.
`pnpm test:e2e` without `PLAYWRIGHT_E2E=1` selects the auth server mode; it does
not prove the Queue boundary. Leave `PLAYWRIGHT_BASE_URL` unset for local checks:
setting it bypasses the managed harness and targets the supplied server.

Inspect `test-results/` and `playwright-report/` on failures. After a full
listing-pilot run, verify the exact completed synthetic draft:

```sh
draft_id="$(cat test-results/real-stack-draft-id.txt)"
workspace_id="$(cat test-results/real-stack-workspace-id.txt)"
test -n "$draft_id" && test -n "$workspace_id"
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @wukong/db audit:verify --workspace "$workspace_id" --draft "$draft_id"
```

Expected: zero missing actions and zero accessible foreign records. Retain the
tested commit SHA, command, mode, result and any skips with release evidence.
Synthetic acceptance does not establish live quality, billing, delivered mail,
or real SHOPLINE write permission.
