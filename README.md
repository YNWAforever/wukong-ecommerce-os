# Wukong E-commerce OS

AI-assisted catalog and SHOPLINE listing operations, piloted with Opak Cellar.
Operators import source material, generate and review listing candidates, approve
the current version, then export a workbook/CSV or deliver through SHOPLINE.
Wine research and product shots are separate, gated operations.

## Start here

- [Architecture, invariants, risk map and next investments](ARCHITECTURE.md)
- [Local development: services, database roles and web app](docs/runbooks/local-development.md)
- [Testing: fast checks, integration and browser modes](docs/runbooks/testing.md)
- [Deployment: build, release order, verification and rollback](docs/runbooks/deployment.md)
- [Operator workflow](docs/runbooks/opak-daily-operations.md)

## Quick start

Use Node **24+** and **pnpm 11.7.0** (the `packageManager` pin). From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter '@wukong/web^...' build
corepack pnpm --filter @wukong/web dev
```

This starts Next.js at `http://localhost:3000`. Auth and data-backed pages also
need local Postgres, migrations and mail configuration; follow the
[local setup](docs/runbooks/local-development.md#posix-shell-setup) first for a
usable application. An empty database does not contain an invited operator.
`pnpm dev` alone does not build shared packages, and shared packages have no watch
build: rebuild dependencies and restart Next after changing them.

## Fast verification (no services or provider keys)

```sh
pnpm test
pnpm typecheck
pnpm format:runtime:check
pnpm runtime:forbidden:check
pnpm release-gate:check
```

`pnpm test` runs root Node tests and package/app unit suites through Turbo. It
builds shared package dependencies; it excludes live database integration tests.
`lint` currently runs the same TypeScript checks as `typecheck`, not ESLint.
See [testing](docs/runbooks/testing.md) for focused checks and full-stack setup.

## Repository map

| Directory           | Responsibility                                                             |
| ------------------- | -------------------------------------------------------------------------- |
| `apps/web`          | Next.js App Router UI, auth, API routes and operation admission; Vercel    |
| `apps/worker`       | Signed ingress, Queue consumers and recovery sweeper; Cloudflare           |
| `packages/core`     | Schemas, workflow transitions, review/compliance and domain ports          |
| `packages/db`       | Postgres schema, SQL migrations, workspace-scoped repositories and ledgers |
| `packages/ai`       | Provider adapters, prompts, accounting and offline/live eval tooling       |
| `packages/jobs`     | Strict Queue envelopes, HMAC signing and run identity                      |
| `packages/shopline` | Delivery policy, connector, workbook/CSV projections and token vault       |
| `packages/assets`   | Private S3/R2 objects, upload/read signing and workspace keys              |
| `docs/runbooks`     | Current setup and operating procedures                                     |
| `docs/superpowers`  | Dated designs and implementation plans; consult before subsystem changes   |

Deploy web to Vercel and the Worker to Cloudflare. The
[deployment runbook](docs/runbooks/deployment.md) describes the two-surface
release; a green source check does not establish deployed health. Real SHOPLINE
writes and paid AI admission remain subject to the existing release gates.
