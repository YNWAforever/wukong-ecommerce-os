# Wukong E-commerce OS — Project Instructions

AI-assisted SHOPLINE listing operations SaaS, piloted with Opak Cellar.

> **This project deviates from the defaults in `~/CLAUDE.md`.** No Supabase, no Tailwind,
> no shadcn/ui, no npm, no `lib/openrouter.ts`. See the stack below and follow it.

## Tech Stack

pnpm 11.7 + Turborepo monorepo · Node 24 · TypeScript 7 (5.9 in `apps/web`), strict + `noUncheckedIndexedAccess`

- **Web**: Next.js 16 App Router, React 19, plain CSS (`app/globals.css`, CSS custom properties)
- **Worker**: Cloudflare Workers (wrangler) — Queues, Hyperdrive, R2
- **DB**: Postgres (Neon) via Drizzle ORM + `postgres` driver; raw SQL migrations
- **Auth**: better-auth (email/password + magic link), argon2, nodemailer
- **AI**: `openai` SDK directly in `packages/ai` — no OpenRouter here
- **Validation**: zod v4 everywhere · **Tests**: Vitest + Playwright · **Format**: Prettier

## Build & Run

```
pnpm dev                    # turbo dev, all packages
pnpm lint                   # NOTE: this is `tsc --noEmit`, not ESLint
pnpm typecheck
pnpm test                   # node --test root suites + turbo test (unit only)
pnpm test:integration       # needs Postgres + MinIO from docker-compose
pnpm test:e2e               # Playwright; PLAYWRIGHT_E2E=1 for the real-stack fixture
pnpm --filter @wukong/db db:migrate
```

Local deps: `docker compose up -d postgres minio minio-tls mailpit`.
Full setup incl. the `wukong_app` role and env vars: `docs/runbooks/local-development.md`.

## Project Structure

```
apps/web        Next.js UI + API routes (Vercel)
apps/worker     Cloudflare Worker: HMAC ingress + Queue consumers
packages/core   Domain: listing schema, workflow state machine, compliance, review, audit ports
packages/db     Drizzle schema, raw SQL migrations, workspace-scoped repositories, audit:verify CLI
packages/ai     ListingAIProvider contract, OpenAI + fake implementations, prompts, evals
packages/shopline  SHOPLINE connector, projection, CSV fallback, token vault
packages/assets S3/R2 asset store, presigning, key canonicalization
packages/jobs   Queue message contracts (zod)
docs/runbooks   Local dev, production AI runtime, readiness gate, pilot onboarding
docs/superpowers/{specs,plans}  Dated design docs — read before changing a subsystem
```

## Architecture Rules

- **Ports and adapters.** Route handlers and pipeline stages take an injected `deps` object and
  are exported as factories (`createListingHandler(deps)`), with the concrete binding at the
  bottom of the file (`export const POST = createListingHandler({ ... })`). Tests inject fakes;
  never reach for a global singleton inside a handler.
- **Workspace scoping is the security boundary.** All data access goes through
  `db.forWorkspace(workspaceId, repos => ...)`. The workspace ID comes from the resolved server
  session (`authSessionContext`), **never** from request JSON. Postgres RLS + the non-superuser
  `wukong_app` role enforce it a second time. Middleware cookie checks are UX only.
- **Status changes go through `transitionListing`** in `packages/core/src/workflow.ts`. Illegal
  transitions throw. Don't write `listing.status` directly.
- **Every domain mutation writes an audit event** via the `AuditWriter` port. `audit:verify` is a
  release gate and must report `0` missing actions and `0` accessible foreign records.
- **Queue work is idempotent.** Pipeline steps claim leases keyed by
  `listing:<workspace>:<draft>:<sequence>` and cache step output; re-delivery must be a no-op.

## Conventions

- **Files**: kebab-case, everywhere, including components.
- **Tests**: colocated `*.test.ts(x)` next to the source; `*.integration.test.ts` for anything
  needing a live Postgres (excluded from `pnpm test`); Playwright `*.spec.ts` in `tests/`.
- **Errors**: throw `ApiError(status, code, message)` and wrap handlers in `withRouteErrors`.
  Never swallow an error; never leak internals into a response body.
- **Logs**: single-line `console.info(JSON.stringify({ event, ... }))`. No credentials, signed
  URLs, prompts, model output, or customer content — this is enforced by the readiness gate.
- **Commits**: lowercase conventional prefixes — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `ops:`. Short imperative subject, usually no body. Work happens on `codex/<topic>` branches
  merged into `main` via PR merge commits.
- **Secrets**: `.env.example` lists names only. Never commit a value, a customer document, or a
  real SHOPLINE/OpenAI credential — not even in fixtures.

## Deployment

Web → Vercel. Worker → Cloudflare (`pnpm --filter @wukong/worker deploy:preview|deploy:production`),
which renders `.wrangler/wrangler.generated.jsonc` from `cloudflare-runtime.config.json` and
verifies required secrets first. SHOPLINE writes are gated: preview is `SHOPLINE_ADAPTER=mock`,
production acceptance is `disabled` + `SHOPLINE_PUBLISH_ENABLED=false`. Enabling the first real
write requires a separate explicit confirmation — see `docs/runbooks/production-readiness.md`.
