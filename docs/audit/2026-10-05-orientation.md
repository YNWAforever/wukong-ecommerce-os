# Final audit — Phase 0 orientation (2026-10-05)

Read-only orientation for the final audit. No code changed. Baseline: `main` at
`dde9e178` (merge of #119). Line references are to that commit unless marked as
PR #121.

Sources read in full: `CLAUDE.md`, `CONTEXT.md`, all nine `docs/runbooks/*`
(the bring-up and pilot-onboarding runbooks were read by section), PR #120 and
#121 descriptions and diffs (#121 by directory and by migration). The 52 specs
and 66 plans in `docs/superpowers/` (about 60k lines) were indexed by title,
not read end to end. Each one is read before its subsystem is audited in Phase 1.

## 1. Package map

| Package             | Role                                                                                                   | Runs on              |
| ------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| `apps/web`          | Next.js 16.2 / React 19.2 UI and all authenticated API routes (61 `route.ts`); signs Worker ingress    | Vercel (Node)        |
| `apps/worker`       | HMAC ingress → Queues, Queue consumers, 5-minute cron sweeper; **every AI/provider call happens here** | Cloudflare Worker    |
| `packages/core`     | Domain: listing schema, `transitionListing`, review/approval, compliance, freshness, wine claim policy | both                 |
| `packages/db`       | Drizzle schema, 51 raw SQL migrations (`drizzle/0000`–`0048`), workspace repositories, `audit:verify`  | both                 |
| `packages/ai`       | `ListingAIProvider` contract, six provider adapters, prompts, eval scripts                             | Worker (+ CLI evals) |
| `packages/jobs`     | zod Queue message contracts, HMAC sign/verify, ingress paths                                           | both                 |
| `packages/shopline` | Connector, 71-col bulk form, 15-col create CSV, token vault                                            | both                 |
| `packages/assets`   | S3/R2 store, presigning, key canonicalization, Node-only render subpath                                | both                 |

Toolchain: pnpm 11.7, Turborepo 2.10, Node 24, TS 7.0.2 at the root and 5.9.3 in
`apps/web`, zod 4.4.3, `openai` ^6.16, better-auth ^1.5.5. `pnpm lint` is
`tsc --noEmit` in every package. There is no ESLint.

## 2. Request and queue flows

### 2.1 Web → Worker ingress (all queue work)

1. A route handler (factory + `deps`, e.g. `createListingHandler` at
   `apps/web/app/api/listings/route.ts:109`) resolves `authSessionContext` and runs
   writes through `db.forWorkspace(context.workspaceId, …)` (`:147`).
2. The handler enqueues through `createCloudflareIngressClient`
   (`apps/web/lib/cloudflare-queue-runtime.ts:68`). It re-validates the payload
   with the path's zod schema, signs `timestamp + path + body` with
   `QUEUE_INGRESS_SECRET` (HMAC-SHA-256, `packages/jobs/src/cloudflare-queue.ts:137`),
   and POSTs with a 5 s timeout and one retry after 750 ms (`:136`). Any non-202
   becomes `QueueIngressError("queue_unavailable")` with a reason that is visible
   only to operators.
3. Worker `fetch` → `handleIngress` (`apps/worker/src/ingress.ts:66`): 4 KiB body
   cap, strict UTF-8, JSON content type, HMAC verify with ±300 s skew and a
   constant-time compare (`cloudflare-queue.ts:160-183`), then a per-path zod parse
   and `send` to the queue:

   | Path                        | Schema                                                    | Queue            |
   | --------------------------- | --------------------------------------------------------- | ---------------- |
   | `/ingress/listings`         | `listingJobSchema` or `wineListingJobSchema`              | `LISTING_QUEUE`  |
   | product-shot path           | `productShotJobSchema`                                    | `LISTING_QUEUE`  |
   | website path                | `websiteJobSchema` (503 without `WEBSITE_FETCH_BASE_URL`) | `LISTING_QUEUE`  |
   | `/ingress/shopline-publish` | `shoplinePublishJobSchema`                                | `SHOPLINE_QUEUE` |

   `POST /health` with a valid signature returns authenticated health. `GET /health`
   is public.

4. Queue payloads are IDs only. `workspaceId` is set by the server session on the
   web side and protected in transit by the HMAC.

### 2.2 Queue consumption

`handleQueue` (`apps/worker/src/queue-consumer.ts:68`) checks the queue name
against a fixed allowlist, then dispatches on the shape of the message body:

- `flowVersion` present → `consumeWineMessage` (wine enrichment stages)
- `kind === "product_shot"` → `consumeProductShotMessage`
- any other `kind` → `consumeWebsiteMessage`
- otherwise → `consumeListingMessage` → `runListingPipeline`

Consumer policy (rendered Wrangler config): batch size 1, max retries 3 (4
deliveries), retry delay 30 s, concurrency 1, one DLQ per queue. The comment at
`queue-consumer.ts:116-119` says the listing DLQ has no consumer, so the final
delivery has to write a terminal state.

Idempotency: listing runs are keyed `listing:<ws>:<draft>:<seq>[#attempt]` or
`listing-run:<runId>` (`cloudflare-queue.ts:81`). Steps claim a lease
(`PIPELINE_STEP_LEASE_MS`). A module-load guard in `listing-consumer.ts` fails
startup if the lease is shorter than 2× the provider timeout plus 60 s. A busy
step returns retry-after-lease-expiry.

Sweeper (`apps/worker/src/sweeper.ts:272`, every 5 min, 300 s grace) re-enqueues
stuck listing jobs, undispatched outbox rows and stuck website scans. It uses
SECURITY DEFINER functions (`0007`) because `wukong_app` cannot enumerate tenants.

### 2.3 Website scan with the signed Worker → Node callback

1. The web creates a `website_scans` row and enqueues `WebsiteJob` through the ingress.
2. `consumeWebsiteMessage` (`apps/worker/src/website-consumer.ts`) loads the scan
   with `forWorkspace(job.workspaceId)` and checks state, revision, deadline and
   lease. It claims a step and gets a `leaseToken`.
3. The Worker validates `WEBSITE_FETCH_BASE_URL`: HTTPS only, or http on
   127.0.0.1/localhost; no credentials, path, query or fragment. It signs
   `{...job, leaseToken}` with the **same** `QUEUE_INGRESS_SECRET` against
   `WEBSITE_DOCUMENT_PATH` and POSTs with `redirect: "manual"` and a 15 s timeout.
   Only 200/202/409 are accepted and the response body is discarded:
   "Callback state is committed by Node."
4. Node handler `createWebsiteDocumentHandler`
   (`apps/web/app/api/internal/website-document/route.ts:16`) verifies the HMAC
   (signatures are path-bound, so a captured ingress message cannot be replayed to
   the callback), parses `websiteDocumentRequestSchema`, and runs
   `createWebsiteDocumentService`. That service does a guarded public fetch
   (`lib/website/public-fetch.ts`, robots policy, `extract-document.ts`) and commits
   the step under the lease.
5. The Worker re-reads the scan. If the revision advanced, it sends the next
   message with a delay and records the dispatch.

**No AI call is made on the website-scan path.** Scans produce read-only
`website_products` observations that cannot be approved, exported or published
(CONTEXT.md "Website catalog observations"). Untrusted HTML reaches a model in
two places, both covered in Phase 1:
(a) wine enrichment, through `/api/internal/wine-evidence-document` → Worker
`wine-document-client.ts` → OpenCode Go;
(b) workbook and spreadsheet cell text that becomes listing inputs for
extraction and generation.

### 2.4 SHOPLINE publish

The web deliver route enqueues on the SHOPLINE queue. `consumeShoplineMessage`
re-evaluates the delivery decision against the exact active version and digest
(CONTEXT.md "Shopline delivery"). The adapter mode comes from
`apps/worker/src/shopline-runtime.ts:60`, `env.SHOPLINE_ADAPTER ?? "disabled"`:
`mock` returns deterministic `mock_<hash>` IDs. The renderer forces preview to
`mock`, production to `disabled`, and both to `SHOPLINE_PUBLISH_ENABLED=false`.

### 2.5 Database tenancy

`createDatabase().forWorkspace` (`packages/db/src/client.ts:262`) opens a
transaction and runs `set_config('app.workspace_id', $1, true)`. RLS policies
plus the `NOSUPERUSER NOBYPASSRLS` `wukong_app` role enforce isolation a second
time. Unscoped entry points, which need checking in Phase 1:

- `findStuckListingJobs`, `findUndispatchedListingJobs`, `findStuckWebsiteScans`
  (SECURITY DEFINER, sweeper only)
- `createAuthDatabase` (`client.ts:~600`, better-auth and provisioning)
- the narrowly privileged public image lookup for `/product-images/<token>.jpg`
- `audit:verify`, which uses its own connection

## 3. Every AI/provider call

All calls happen in `apps/worker`. `apps/web` never imports a provider. Six
external providers exist. **CLAUDE.md lists only OpenAI and OpenRouter, so it has
drifted.**

| #   | Call site                                                                                                                       | Provider / adapter                                                            | Model selection                                                                                                                                                                                                                                        | Gate                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Legacy listing extract/generate: `listing-pipeline.ts:409/519` via `createProvider` (`cloudflare-runtime.ts:87`)                | `OpenAIListingProvider` / `OpenRouterListingProvider` / `FakeListingProvider` | `AI_PROVIDER` (default `openai`). OpenAI model = `process.env.OPENAI_LISTING_MODEL ?? "gpt-5.6-terra"` (`openai-listing-provider.ts:89,209`); the env object is not passed. OpenRouter needs `OPENROUTER_LISTING_MODEL`. `opencode-go` is refused here | none beyond config                                                                                                         |
| 2   | Operation-based listing extract/generate: `operationAI` (`operation-ai.ts:26`), chosen in `listing-operation-pipeline.ts:73-79` | OpenAI / OpenRouter / OpenCode Go / fake                                      | Frozen per operation from the workspace `listingAi` policy (model, max tokens, pricing); prompt versions must equal `LISTING_PROMPT_VERSIONS`                                                                                                          | `LISTING_PAID_OPERATIONS_ENABLED=true` and policy provider = `AI_PROVIDER`; each physical call commits a pending row first |
| 3   | Wine enrichment stages: `wine-operation-ai.ts:81`                                                                               | `WineEnrichmentProvider` over OpenCode Go (`deepseek-v4.1-flash`)             | Accepted execution snapshot                                                                                                                                                                                                                            | `WINE_ENRICHMENT_ENABLED`, paid flag, USD 10 workspace cap, per-call admission, at most 10 calls per flow                  |
| 4   | Wine web research: `wine-evidence-acquisition.ts:564`                                                                           | `TavilyProvider`                                                              | n/a                                                                                                                                                                                                                                                    | wine flags, Tavily credit reservation                                                                                      |
| 5   | Listing verification advisory: `typesafe-config.ts:23-35`                                                                       | TypeSafe "Jev" (`typesafe-listing-verifier.ts`)                               | `TYPESAFE_MODEL` (pinned, e.g. `jev-1.13.0`)                                                                                                                                                                                                           | `TYPESAFE_VERIFICATION_MODE=advisory`; 5 s timeout, no retries                                                             |
| 6   | Product-shot background removal: `cloudflare-runtime.ts:506`                                                                    | `PhotoroomProductShotProvider` (or inline fake)                               | n/a                                                                                                                                                                                                                                                    | `PRODUCT_SHOT_PROVIDER` (default `disabled`), daily per-workspace dispatch allowance                                       |

Prompts: `packages/ai/src/prompts.ts` (extraction 1.1.0, generation 1.0.0,
product-shot 1.0.0, versioned through `packages/core/src/listing-prompt-versions.ts`)
and `wine-enrichment-prompts.ts`. SDK retries are disabled (`maxRetries: 0`);
retrying is left to the Queue.

Evals: `pnpm --filter @wukong/ai eval:verification` (Jev, 40 synthetic cases,
dry-run by default, `--live` gated by four flags), `eval.ts` and `product-type-eval.ts`.
**There is no `eval:live` script and no `fixtures/opak` eval set yet.**

## 4. Test inventory

| Area                | Unit files        | Integration files (`*.integration.test.ts`) |
| ------------------- | ----------------- | ------------------------------------------- |
| apps/web            | 200               | 19                                          |
| apps/worker         | 33                | 11                                          |
| packages/db         | 20                | 50                                          |
| packages/core       | 23                | 0                                           |
| packages/ai         | 22                | 0                                           |
| packages/shopline   | 13                | 0                                           |
| packages/assets     | 11                | 1                                           |
| packages/jobs       | 6                 | 0                                           |
| `tests/integration` | —                 | 2                                           |
| root `tests/*.mjs`  | 9 node:test files | —                                           |

- `pnpm test` runs six root node:test files, then `turbo test` (unit only,
  integration excluded).
- `pnpm test:integration` runs `vitest.integration.config.ts`, serialized
  (`fileParallelism: false`). All 19 web integration files fall under its globs.
- `pnpm test:e2e`: Playwright, 14 specs in `tests/e2e` plus
  `tests/admin-password-auth.e2e.spec.ts`. With `PLAYWRIGHT_E2E=1` it builds
  production Next and starts `wrangler dev` with local Queue/Hyperdrive, MinIO
  and Mailpit, using fake AI and mock SHOPLINE. `product-shot.spec.ts` runs only
  with `WUKONG_PRODUCT_SHOT_E2E=1`, and the wine spec only with `WUKONG_WINE_E2E=1`.
- **`tests/next-config.test.mjs` is not run by `pnpm test` or by CI** (lead for Phase 1).

### What the gates actually check

- **`audit:verify`** (`packages/db/src/cli/audit-verify.ts`):
  1. For one workspace and draft, checks that the ordered audit sequence
     `created|imported → submitted_for_review → approved → csv_exported|bulk_form_exported|published`
     is present (`:28`). It also checks the expected `ai_runs` tasks and the
     product-shot attempt/publication audits.
  2. Runs an RLS leak probe: as the runtime role with `app.workspace_id` set, it
     counts rows with `workspace_id <> $1` in every table listed in `TENANT_TABLES`
     (`:40`).

  The probe covers only the tables in that hand-maintained list. Phase 1 will
  diff the list against every `workspace_id` table in the migrations.
  `verifyWebsiteAudit` (`:274`) checks website scans the same way.

- **"Readiness gate" = `pnpm release-gate:check`** (`scripts/check-release-gate.mjs`).
  Of 20 checklist items in `production-readiness.md`, six are automated and
  fourteen are marked human. The six automated checks are **static source
  assertions**: string presence in `ci.yml`, `playwright.config.ts` and the env
  manifests, for example that `DATABASE_ADMIN_URL` is forbidden on runtime
  surfaces and that the SHOPLINE mock/disabled locks hold. The "no credentials,
  prompts or customer content in logs" rule is a **human** item. No script
  enforces it; `runtime:forbidden:check` only bans legacy runtime packages,
  imports and files. Related: `pnpm runtime:doctor` (pre-deploy and live config
  doctor) and `pnpm format:runtime:check`.

## 5. CI (`.github/workflows/ci.yml`, single `verify` job, 45 min)

Triggers: push to `main` and every pull request. Postgres 17 runs as a service,
and MinIO, minio-tls (Caddy CA) and Mailpit run through compose. In order:

1. Runtime format check.
2. Forbidden-runtime check.
3. Render and validate Cloudflare config (preview, fake AI) plus Worker types.
4. Create the `wukong_app` role.
5. Build `@wukong/db...`, migrate, lint, typecheck, `pnpm test`.
6. Create the integration bucket, then create, migrate and test against the
   isolated `wukong_wine_sdd` database (`pnpm test:integration`).
7. Production `pnpm build` with auth secrets scoped to that step.
8. sharp and pdf-worker bundling tests.
9. Playwright product-shot (synthetic scenarios).
10. Playwright full real-stack suite.
11. **`audit:verify` on the exact real-stack draft.**
12. Wine topology test and wine Playwright.
13. Upload evidence and artifacts.

All of it runs with `AI_PROVIDER=fake` and `SHOPLINE_ADAPTER=mock`. There is no
deploy job. Vercel builds previews separately, and the Worker is deployed
manually through `deploy:preview|production`.

## 6. Open PRs #120 and #121

**PR #121, `codex/opak-runtime-recovery`: "guarded Opak product maintenance workflow"** (open, not draft)

- About 50k lines added and 1.7k removed across 364 files (180 new), 79 commits.
  It is an integration branch that already merged #122–#128.
- Changes are spread across `apps/web/lib` (20%), `apps/web/components` (20%),
  runbooks (16%), `packages/db/src/repositories` (10%) and `apps/web/app/api`.
- **Adds migrations `0049`–`0053`** (batch current-content fences, selection
  previews, operational archive, listing assignments, quality projection). Main
  stops at `0048`, so any migration from this audit must be numbered `0054`+ and
  must be checked for conflict with #121.
- Touches the same areas the brief names: source matching, maintenance drafts,
  bulk approval, per-cell XLSX protection, result reconciliation, queue
  diagnostics, imported-publish snapshot preservation, catalog support IDs,
  assignment handover, sign-out, admin unsaved-change guard, and catalog read
  performance.
- Status from its description: "Main/production remain held". UAT is
  15 PASS / 3 PARTIAL / 12 BLOCKED. The most recent CI was green on retry after
  a wine-acceptance flake whose cause is still unconfirmed. It records that **a
  production Hyperdrive cache-disabled flag was applied once under explicit
  authorization**. No migration, deploy, paid AI or SHOPLINE write was run.

**PR #120, `codex/retained-useful-work-20260926`** (draft, 12 files, +396/−48)

- Five safeguards:
  - bulk-approve response validation (`queue-client.tsx`)
  - "no version" guidance (`source-readiness-summary.tsx`)
  - allowlisted queue-ingress diagnostics (`cloudflare-queue-runtime.ts`)
  - pure domain approval with no duplicate audit (`listing-approval.ts`, `core/review.ts`)
  - newer-imported-snapshot preservation (`worker/publish-product.ts`)
- Its own 2026-10-03 note says all five are already retained or re-implemented in
  #126, which is merged into #121. Its last CI failed. **It is effectively
  superseded by #121.**

**Overlap with this audit.** Every Phase 1 area except the AI package and the
auth core is touched by #121. A finding against `main` may already be fixed in
#121, and a fix on `main` would conflict with it. See "Needs decision".

## 7. Leads queued for Phase 1 (unverified; not findings yet)

- `listing-consumer.ts` returns retry for an unparseable envelope, but the schema
  comment (`cloudflare-queue.ts:34`) says it "acks the message away". Either the
  doc or the behavior has drifted, and every retry ends in the DLQ.
- OpenAI model resolution reads `process.env` inside the Worker rather than
  `env`. This depends on `nodejs_compat` populating `process.env` (compat date
  2026-07-19). Verify.
- `TENANT_TABLES` completeness against all migrated `workspace_id` tables.
- `apps/web/middleware.ts` on Next 16, where `middleware` is deprecated in favor
  of `proxy`.
- `tests/next-config.test.mjs` is not run anywhere.
- One shared HMAC secret is used in both directions, with a single-key verifier
  (rotation runbook acknowledges this).

## 8. Workspace and tool surface

- Required skills: all are installed except `taste-skill:redesign-existing-projects`
  and `taste-skill:high-end-visual-design`. The closest installed equivalents are
  `taste-skill:redesign-skill` and `taste-skill:taste-skill`.
- `ecc:safety-guard` is hook-based; careful mode is being applied manually.
- An ECC GateGuard hook is active on Bash.
- The GitHub, Linear and other plugin MCP servers need OAuth. `gh` CLI works.
- The desktop-commander MCP failed to connect.
- Untracked files at the repo root: `.claude/`, `.codebase-memory/`,
  `.corepack-scratch/`, `.pnpm-store/` and `r2-web-staging.env.txt`. **The
  `.env.txt` file is not git-ignored** (`.env*` only matches names that start
  with `.env`). It was not opened.
