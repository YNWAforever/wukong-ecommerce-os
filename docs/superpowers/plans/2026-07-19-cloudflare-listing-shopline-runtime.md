# Cloudflare Listing and SHOPLINE Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Redis/BullMQ and Railway with an authenticated Cloudflare Worker, Cloudflare Queues, DLQs, Hyperdrive-to-Neon, and Wrangler acceptance while closing the reviewed SHOPLINE, authorization, AI-copy, and image-delivery gaps.

**Architecture:** Vercel commits tenant state first and signs narrow enqueue requests to one Cloudflare Worker. The Worker publishes to two Queue bindings and consumes both queues with at-least-once semantics; Neon RLS leases provide idempotency, Hyperdrive supplies pooled Postgres connectivity, and private R2 presigned reads supply AI/SHOPLINE assets. Real SHOPLINE writes remain fail-closed until a separate production confirmation.

**Tech Stack:** Node.js 24, pnpm 11.7, TypeScript 7, Next.js 16.2, Cloudflare Workers, Cloudflare Queues, Wrangler/Miniflare, Hyperdrive, Neon Postgres, Drizzle ORM, Postgres.js 3.4.7, private R2/S3, Web Crypto AES-GCM/HMAC, OpenAI Responses API, Vitest, Playwright.

## Global Constraints

- Keep `codex/production-listing-workflow`; do not stage or modify the four protected user paths: `.gitignore`, `apps/web/.gitignore`, `apps/web/auth.test.ts`, and `docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md`.
- Remove Redis, BullMQ, Upstash, Railway configuration, and Railway runtime from the target application and release gate.
- Preserve tenant isolation: every repository operation runs through `database.forWorkspace`; queue bodies contain IDs only.
- Hyperdrive caching is disabled; Worker Postgres clients use at most five connections and close in `finally`.
- Real SHOPLINE writes remain disabled until a separate final user confirmation. Preview uses `SHOPLINE_ADAPTER=mock`.
- Never commit or print database URLs, API keys, ingress secrets, token-encryption keys, raw SHOPLINE tokens, ciphertext, signed URLs, or model output.
- Use Cloudflare Queue batches of one, three retries, bounded retry delay, and environment-specific DLQs.
- Use explicit OpenAI and SHOPLINE timeouts below the Queue consumer's 15-minute wall limit.
- Follow TDD: each behavior change begins with a focused failing test, then minimal implementation, then focused and affected-suite verification.

## Primary references

- Cloudflare Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- Queue batching, retry, and acknowledgement: https://developers.cloudflare.com/queues/configuration/batching-retries/
- Queue local development: https://developers.cloudflare.com/queues/configuration/local-development/
- Hyperdrive with Postgres.js: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
- Hyperdrive local connection strings: https://developers.cloudflare.com/hyperdrive/configuration/local-development/

---

## File structure

### Shared protocol

- `packages/jobs/src/cloudflare-queue.ts`: strict queue schemas, ingress paths, stable request serialization, and HMAC signing/verification.
- `packages/jobs/src/index.ts`: public protocol exports.
- Remove `packages/jobs/src/listing-queue.ts` and its BullMQ integration test after parity tests pass.

### Web producer

- `apps/web/lib/cloudflare-queue-runtime.ts`: signed Worker ingress client.
- `apps/web/lib/listing-queue-runtime.ts`: retained compatibility facade backed by Cloudflare.
- `apps/web/app/api/listings/route.ts`: operator guard and AI enqueue.
- `apps/web/app/api/listings/[id]/deliver/route.ts`: two-phase SHOPLINE enqueue.

### Database

- `packages/db/drizzle/0003_publish_job_leases.sql`: publish lease columns and supporting index.
- `packages/db/src/repositories/publish-jobs.ts`: pending-enqueue, mark-queued, atomic claim, lease-guarded completion/failure.
- `packages/db/src/schema.ts`: lease columns.

### Cloudflare Worker

- `apps/worker/src/cloudflare.ts`: `fetch` and `queue` exported handler.
- `apps/worker/src/ingress.ts`: signed enqueue HTTP handler.
- `apps/worker/src/queue-consumer.ts`: queue dispatch, ack/retry classification, lifecycle cleanup.
- `apps/worker/src/cloudflare-runtime.ts`: Hyperdrive database, assets, AI, and SHOPLINE dependencies.
- `apps/worker/src/shopline-runtime.ts`: adapter modes, token decryption, connector factory.
- `apps/worker/src/image-resolver.ts`: listing-owned ordered signed URLs.
- `scripts/render-cloudflare-config.mjs`: generates ignored Wrangler config from non-secret resource IDs/names.
- `cloudflare-runtime.config.json`: checked-in non-secret names and queue policies.

### Security and correctness

- `packages/shopline/src/token-vault.ts`: Web Crypto AES-256-GCM envelope.
- `packages/ai/src/openai-listing-provider.ts`: bounded abort signal and return grounded model copy.
- Presign, finalize, and listing-create routes: operator authorization.

### Acceptance and operations

- `tests/e2e/real-stack-server.mjs`: starts Wrangler instead of the Node/Railway CLI.
- `tests/e2e/real-stack-fixture.ts`: removes direct publisher helper.
- `tests/cloudflare-config.test.mjs`: config/security contract.
- `.github/workflows/ci.yml`: Wrangler build/local Queue release gate; no Redis service.
- `docs/runbooks/production-ai-runtime.md`: Cloudflare resources, secrets, deployment, metrics, rollback.
- Remove `railway.json` and `tests/railway-config.test.mjs` after replacement tests pass.

---

### Task 1: Replace BullMQ with strict Cloudflare queue protocols

**Files:**

- Create: `packages/jobs/src/cloudflare-queue.ts`
- Create: `packages/jobs/src/cloudflare-queue.test.ts`
- Modify: `packages/jobs/src/index.ts`
- Modify: `packages/jobs/package.json`
- Modify: `pnpm-lock.yaml`
- Delete after green: `packages/jobs/src/listing-queue.ts`
- Delete after green: `packages/jobs/src/listing-queue.test.ts`
- Delete after green: `packages/jobs/src/listing-queue.integration.test.ts`

**Interfaces:**

- Produces `listingJobSchema`, `shoplinePublishJobSchema`, `QueueMessage`, `LISTING_INGRESS_PATH`, `SHOPLINE_INGRESS_PATH`, `signQueueRequest`, and `verifyQueueRequest`.
- Queue bodies contain only workspace/listing/version/connection identifiers.

- [ ] **Step 1: Write failing schema and HMAC tests**

```ts
it("accepts IDs only and rejects extra queue fields", () => {
  expect(
    listingJobSchema.parse({
      workspaceId: "ws_opak",
      draftId,
      activeVersionSequence: 0,
    }),
  ).toEqual({ workspaceId: "ws_opak", draftId, activeVersionSequence: 0 });
  expect(() =>
    shoplinePublishJobSchema.parse({
      workspaceId: "ws_opak",
      draftId,
      versionId,
      connectionId,
      token: "secret",
    }),
  ).toThrow();
});

it("signs exact path, timestamp, and bytes", async () => {
  const signature = await signQueueRequest({
    secret: "a".repeat(32),
    timestamp: 1_784_455_200,
    path: LISTING_INGRESS_PATH,
    body: '{"draftId":"x"}',
  });
  await expect(
    verifyQueueRequest({
      secret: "a".repeat(32),
      nowSeconds: 1_784_455_200,
      timestamp: "1784455200",
      signature,
      path: LISTING_INGRESS_PATH,
      body: '{"draftId":"x"}',
    }),
  ).resolves.toBe(true);
  await expect(
    verifyQueueRequest({
      secret: "a".repeat(32),
      nowSeconds: 1_784_455_501,
      timestamp: "1784455200",
      signature,
      path: LISTING_INGRESS_PATH,
      body: '{"draftId":"x"}',
    }),
  ).resolves.toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `corepack pnpm --filter @wukong/jobs exec vitest run src/cloudflare-queue.test.ts`

Expected: FAIL because `cloudflare-queue.ts` and its exports do not exist.

- [ ] **Step 3: Implement strict schemas and Web Crypto HMAC**

```ts
export const listingJobSchema = z
  .object({
    workspaceId: safeId,
    draftId: z.string().uuid(),
    activeVersionSequence: z.number().int().nonnegative(),
  })
  .strict();

export const shoplinePublishJobSchema = z
  .object({
    workspaceId: safeId,
    draftId: z.string().uuid(),
    versionId: z.string().uuid(),
    connectionId: z.string().uuid(),
  })
  .strict();

export async function signQueueRequest(input: SignInput): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new TextEncoder().encode(
    `${input.timestamp}\n${input.path}\n${input.body}`,
  );
  return Buffer.from(await crypto.subtle.sign("HMAC", key, bytes)).toString(
    "base64url",
  );
}
```

Use constant-time byte comparison in `verifyQueueRequest`, reject timestamps outside 300 seconds, and never include secrets or signatures in errors.

- [ ] **Step 4: Remove BullMQ/ioredis from `@wukong/jobs` and export the new protocol**

`packages/jobs/package.json` keeps only `zod` at runtime. `src/index.ts` exports the two schemas, paths, payload types, and signing functions.

- [ ] **Step 5: Run package verification**

Run: `corepack pnpm --filter @wukong/jobs test; corepack pnpm --filter @wukong/jobs typecheck`

Expected: all new protocol tests pass; no BullMQ or ioredis import remains under `packages/jobs`.

- [ ] **Step 6: Commit**

```powershell
git add packages/jobs pnpm-lock.yaml
git commit -m "refactor: define Cloudflare queue protocols"
```

---

### Task 2: Enforce operator authorization before intake side effects

**Files:**

- Modify: `apps/web/app/api/assets/presign/route.ts`
- Modify: `apps/web/app/api/assets/finalize/route.ts`
- Modify: `apps/web/app/api/listings/route.ts`
- Modify: `apps/web/app/api/assets/finalize/route.test.ts`
- Create: `apps/web/app/api/assets/presign/route.test.ts`
- Modify: `apps/web/app/api/listings/route.create.test.ts`

**Interfaces:**

- Consumes `requireWorkspaceRole("operator", context.role)`.
- Produces `403 insufficient_role` before parsing asset IDs, touching storage/database, or enqueueing AI.

- [ ] **Step 1: Add viewer-403 tests with side-effect spies**

```ts
it("rejects a viewer before creating an upload", async () => {
  const createUpload = vi.fn();
  const response = await createPresignAssetHandler(
    harness({ role: "viewer", createUpload }),
  )(validRequest);
  expect(response.status).toBe(403);
  expect(createUpload).not.toHaveBeenCalled();
});
```

Repeat for finalize (`head`, DB untouched) and listing create (`getByIds`, publisher untouched).

- [ ] **Step 2: Run RED tests**

Run: `corepack pnpm --filter @wukong/web exec vitest run app/api/assets/presign/route.test.ts app/api/assets/finalize/route.test.ts app/api/listings/route.create.test.ts`

Expected: viewer requests currently reach side effects or succeed.

- [ ] **Step 3: Add the same guard immediately after session resolution**

```ts
if (!requireWorkspaceRole("operator", context.role)) {
  throw new ApiError(403, "insufficient_role", "Operator access is required.");
}
```

- [ ] **Step 4: Run focused and session-policy tests**

Run: `corepack pnpm --filter @wukong/web exec vitest run app/api/assets app/api/listings/route.create.test.ts lib/session-context.test.ts`

Expected: viewer `403`; operator and higher paths remain green.

- [ ] **Step 5: Commit**

```powershell
git add apps/web/app/api/assets apps/web/app/api/listings/route.ts apps/web/app/api/listings/route.create.test.ts
git commit -m "fix: restrict listing intake to operators"
```

---

### Task 3: Add durable publish-job leases for Cloudflare at-least-once delivery

**Files:**

- Create: `packages/db/drizzle/0003_publish_job_leases.sql`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/publish-jobs-schema.test.ts`
- Modify: `packages/db/src/repositories/publish-jobs.ts`
- Modify: `packages/db/src/repositories/publish-jobs.integration.test.ts`
- Modify: `packages/db/src/migrations.test.ts`

**Interfaces:**

- `PublishJobStatus` adds `pending_enqueue`.
- Adds `markQueued(key)`, `claim(input)`, and lease-token parameters on terminal updates.

- [ ] **Step 1: Write failing schema and repository tests**

```ts
expect(columns.leaseToken.dataType).toBe("string");
expect(columns.attemptCount.notNull).toBe(true);

const first = await repos.publishJobs.claim({
  key,
  expectedVersionId: versionId,
  now,
  leaseMs: 60_000,
});
const duplicate = await repos.publishJobs.claim({
  key,
  expectedVersionId: versionId,
  now,
  leaseMs: 60_000,
});
expect(first.claimed).toBe(true);
expect(duplicate.claimed).toBe(false);
await expect(
  repos.publishJobs.markPublished(key, randomUUID(), "remote", digest),
).rejects.toThrow(/lease/i);
```

Add a test that an expired lease is reclaimed and the stale lease cannot mark failure afterward.

- [ ] **Step 2: Run RED tests**

Run: `corepack pnpm --filter @wukong/db exec vitest run src/publish-jobs-schema.test.ts src/repositories/publish-jobs.integration.test.ts`

Expected: missing columns and methods.

- [ ] **Step 3: Add migration and schema fields**

```sql
alter table publish_jobs add column if not exists lease_token uuid;
alter table publish_jobs add column if not exists lease_expires_at timestamptz;
alter table publish_jobs add column if not exists attempt_count integer not null default 0;
create index if not exists publish_jobs_workspace_lease_idx
  on publish_jobs (workspace_id, status, lease_expires_at);
```

- [ ] **Step 4: Implement conditional state transitions**

`ensure` inserts `pending_enqueue`. `markQueued` updates only `pending_enqueue`. `claim` performs one `UPDATE ... WHERE` for eligible status/expiry/version and returns a new UUID lease. `markPublished` and `markFailed` include both workspace id and lease token in their predicates and clear lease fields.

```ts
claim(input: { key: string; expectedVersionId: string; now: Date; leaseMs: number }): Promise<{ claimed: boolean; job: PublishJob | null; leaseToken: string | null }>;
markPublished(key: string, leaseToken: string, remoteProductId: string, payloadDigest: string): Promise<void>;
markFailed(key: string, leaseToken: string, errorCode: string): Promise<void>;
```

- [ ] **Step 5: Build dependencies, migrate, and run integration GREEN**

Run: `corepack pnpm --filter @wukong/db... build`

Run with local admin/runtime URLs: `corepack pnpm --filter @wukong/db db:migrate; corepack pnpm --filter @wukong/db exec vitest run src/repositories/publish-jobs.integration.test.ts --config ../../vitest.integration.config.ts`

Expected: lease, expiry, idempotency, and RLS tests pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/db/drizzle/0003_publish_job_leases.sql packages/db/src/schema.ts packages/db/src/publish-jobs-schema.test.ts packages/db/src/repositories/publish-jobs.ts packages/db/src/repositories/publish-jobs.integration.test.ts packages/db/src/migrations.test.ts
git commit -m "feat: lease SHOPLINE publish jobs"
```

---

### Task 4: Replace the web Redis publisher with signed Cloudflare ingress

**Files:**

- Create: `apps/web/lib/cloudflare-queue-runtime.ts`
- Create: `apps/web/lib/cloudflare-queue-runtime.test.ts`
- Modify: `apps/web/lib/listing-queue-runtime.ts`
- Modify: `apps/web/lib/listing-queue-runtime.test.ts`
- Modify: `apps/web/lib/intake-route-deps.ts`
- Modify: `apps/web/package.json`
- Modify: `.env.example`

**Interfaces:**

- `CloudflareIngressClient.enqueue(path, payload): Promise<{ accepted: true }>`.
- `ListingPublisher.enqueue` remains compatible and returns a deterministic application job ID.

- [ ] **Step 1: Write failing signed-request tests**

```ts
it("posts exact JSON with timestamp and HMAC without logging the secret", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 202 }));
  const client = createCloudflareIngressClient({
    env: {
      QUEUE_INGRESS_URL: "https://queue.example",
      QUEUE_INGRESS_SECRET: "s".repeat(32),
    },
    now: () => 1_784_455_200_000,
    fetch,
  });
  await client.enqueue(LISTING_INGRESS_PATH, payload);
  const [, init] = fetch.mock.calls[0]!;
  expect(init.headers).toMatchObject({ "x-wukong-timestamp": "1784455200" });
  expect(JSON.stringify(init)).not.toContain("s".repeat(32));
});
```

Also test missing env, non-202, timeout, and safe error messages.

- [ ] **Step 2: Run RED tests**

Run: `corepack pnpm --filter @wukong/web exec vitest run lib/cloudflare-queue-runtime.test.ts lib/listing-queue-runtime.test.ts`

- [ ] **Step 3: Implement the ingress client with a bounded abort**

```ts
const body = JSON.stringify(schema.parse(payload));
const timestamp = Math.floor(now() / 1000);
const signature = await signQueueRequest({ secret, timestamp, path, body });
const response = await fetch(new URL(path, ingressUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-wukong-timestamp": String(timestamp),
    "x-wukong-signature": signature,
  },
  body,
  signal: AbortSignal.timeout(5_000),
});
if (response.status !== 202) throw new QueueIngressError("queue_unavailable");
```

- [ ] **Step 4: Reimplement `listingPublisher` over the client**

Return `listing:<workspaceId>:<draftId>:<activeVersionSequence>` as the application job ID after `202`. Remove ioredis from `apps/web` if no other import remains.

- [ ] **Step 5: Run focused web tests and secret scan**

Run: `corepack pnpm --filter @wukong/web exec vitest run lib/cloudflare-queue-runtime.test.ts lib/listing-queue-runtime.test.ts app/api/listings/route.create.test.ts`

Run: `rg -n "REDIS_URL|ioredis|bullmq" apps/web packages/jobs`

Expected: tests pass; search returns no runtime use.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/lib apps/web/package.json .env.example pnpm-lock.yaml
git commit -m "feat: enqueue listings through Cloudflare ingress"
```

---

### Task 5: Build the Cloudflare Worker ingress and Hyperdrive shell

**Files:**

- Create: `apps/worker/src/worker-env.ts`
- Create: `apps/worker/src/ingress.ts`
- Create: `apps/worker/src/ingress.test.ts`
- Create: `apps/worker/src/queue-consumer.ts`
- Create: `apps/worker/src/cloudflare.ts`
- Create: `apps/worker/src/cloudflare-runtime.ts`
- Create: `apps/worker/src/cloudflare-runtime.test.ts`
- Create: `cloudflare-runtime.config.json`
- Create: `scripts/render-cloudflare-config.mjs`
- Create: `tests/cloudflare-config.test.mjs`
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/tsconfig.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Delete after green: `apps/worker/src/cli.ts`
- Delete after green: `apps/worker/src/runtime.ts`
- Delete after green: `apps/worker/src/runtime.test.ts`
- Delete after green: `railway.json`
- Delete after green: `tests/railway-config.test.mjs`

**Interfaces:**

- Default export satisfies `ExportedHandler<WorkerEnv, QueueMessage>` with `fetch` and `queue`.
- `WorkerEnv.HYPERDRIVE.connectionString` is the only Worker database URL source.

- [ ] **Step 1: Write failing config and ingress tests**

Assert exact queue/DLQ names, batch size 1, three retries, compatibility date `2026-07-19`, `nodejs_compat`, CPU limit, observability, Hyperdrive binding, and absence of Redis/Railway.

```ts
const response = await handleIngress(signedRequest, envWithQueueSpy);
expect(response.status).toBe(202);
expect(env.LISTING_QUEUE.send).toHaveBeenCalledWith(payload);
```

Add 401 tests for skewed, tampered, missing signatures and 404 for other paths.

- [ ] **Step 2: Run RED tests**

Run: `corepack pnpm --filter @wukong/worker exec vitest run src/ingress.test.ts src/cloudflare-runtime.test.ts`

Run: `node --test tests/cloudflare-config.test.mjs`

- [ ] **Step 3: Add deterministic non-secret config source and renderer**

`cloudflare-runtime.config.json` stores environment-specific Worker, Queue, and DLQ names plus consumer policy. `scripts/render-cloudflare-config.mjs` requires `CLOUDFLARE_ENV` and `CLOUDFLARE_HYPERDRIVE_ID`, builds a JSON object, and writes `.wrangler/wrangler.generated.jsonc`. It never reads or writes secrets.

```js
const wrangler = {
  name: selected.worker,
  main: "apps/worker/src/cloudflare.ts",
  compatibility_date: "2026-07-19",
  compatibility_flags: ["nodejs_compat"],
  limits: { cpu_ms: 240000 },
  observability: { enabled: true },
  hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
  queues: { producers, consumers },
};
```

- [ ] **Step 4: Implement Worker env parsing and Hyperdrive database factory**

```ts
export function createWorkerDatabase(env: WorkerEnv): Database {
  return createDatabase(env.HYPERDRIVE.connectionString, { maxConnections: 5 });
}
```

Validate required bindings/secrets per handler. Close the database in `finally` for every queue batch.

- [ ] **Step 5: Implement signed ingress and health handler**

Use the shared verification function, exact raw request bytes, 4 KiB body maximum, strict path-specific schema, and Queue binding `send`. `/health` returns only build SHA, adapter mode, and booleans for binding presence.

- [ ] **Step 6: Export Worker handlers and remove Node CLI/BullMQ runtime**

```ts
export default {
  fetch: (request, env, context) => handleIngress(request, env, context),
  queue: (batch, env, context) => handleQueue(batch, env, context),
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
```

Remove BullMQ/ioredis dependencies. Add pinned `wrangler` and `@cloudflare/workers-types` dev dependencies and `build`, `types`, `dev:local`, `deploy:preview`, `deploy:production` scripts.

- [ ] **Step 7: Run Worker/config GREEN**

Run: `corepack pnpm --filter @wukong/worker test; node --test tests/cloudflare-config.test.mjs; corepack pnpm --filter @wukong/worker build`

Expected: handlers and generated config validate; no Railway file/test remains.

- [ ] **Step 8: Commit**

```powershell
git add apps/worker cloudflare-runtime.config.json scripts/render-cloudflare-config.mjs tests/cloudflare-config.test.mjs package.json pnpm-lock.yaml railway.json tests/railway-config.test.mjs
git commit -m "feat: add Cloudflare Worker runtime"
```

---

### Task 6: Adapt AI processing to Cloudflare Queues and add provider timeout

**Files:**

- Modify: `apps/worker/src/listing-pipeline.ts`
- Create: `apps/worker/src/listing-consumer.ts`
- Create: `apps/worker/src/listing-consumer.test.ts`
- Modify: `apps/worker/src/queue-consumer.ts`
- Modify: `packages/ai/src/openai-listing-provider.ts`
- Modify: `packages/ai/src/openai-listing-provider.test.ts`

**Interfaces:**

- `consumeListingMessage(payload, env): Promise<"ack" | { retryAfterSeconds: number }>`.
- `ResponsesClientPort.responses.parse(request, { signal })` supports abort.

- [ ] **Step 1: Add RED tests for ack/retry classification and abort**

```ts
expect(await consumeListingMessage(valid, harness())).toBe("ack");
expect(
  await consumeListingMessage(
    valid,
    harness({ error: new ProviderApiError("AI provider request timed out") }),
  ),
).toEqual({ retryAfterSeconds: 30 });
expect(client.responses.parse.mock.calls[0]![1]?.signal).toBeInstanceOf(
  AbortSignal,
);
```

Terminal schema/evidence/refusal errors must persist a safe failure and ack; availability/timeouts retry.

- [ ] **Step 2: Run RED tests**

Run: `corepack pnpm --filter @wukong/worker exec vitest run src/listing-consumer.test.ts; corepack pnpm --filter @wukong/ai exec vitest run src/openai-listing-provider.test.ts`

- [ ] **Step 3: Add an explicit provider deadline**

Extend `OpenAIListingProviderConfig` with `timeoutMs`, default 120,000, validate 1,000-600,000, and pass `AbortSignal.timeout(timeoutMs)` as the request option for initial and repair calls.

- [ ] **Step 4: Implement the Cloudflare listing consumer**

Reuse `runListingPipeline` domain logic. Parse payload before database access; build dependencies from `createCloudflareRuntime`; return ack/retry without logging model content.

- [ ] **Step 5: Wire per-message ack/retry**

With batch size one, call `message.ack()` for success/terminal outcomes and `message.retry({ delaySeconds })` for transient outcomes. Unknown queue names throw before acknowledgement so deployment config errors surface.

- [ ] **Step 6: Run focused and worker suites**

Run: `corepack pnpm --filter @wukong/ai test; corepack pnpm --filter @wukong/worker test`

- [ ] **Step 7: Commit**

```powershell
git add packages/ai/src/openai-listing-provider.ts packages/ai/src/openai-listing-provider.test.ts apps/worker/src
git commit -m "feat: consume AI jobs with Cloudflare Queues"
```

---

### Task 7: Preserve grounded model copy and resolve owned images

**Files:**

- Modify: `packages/ai/src/openai-listing-provider.ts`
- Modify: `packages/ai/src/openai-listing-provider.test.ts`
- Create: `apps/worker/src/image-resolver.ts`
- Create: `apps/worker/src/image-resolver.test.ts`
- Modify: `apps/web/lib/delivery-service.ts`
- Modify: `apps/web/lib/delivery-service.review-fix.test.ts`
- Modify: `apps/web/app/api/listings/[id]/deliver/route.ts`
- Modify: `apps/web/app/api/listings/[id]/deliver/route.test.ts`

**Interfaces:**

- `generate` returns validated `modelListing`, not `safeListing`.
- `resolveListingImageUrls({ workspaceId, draftId, imageAssetIds, sourceAssets, assetStore })` preserves order and rejects foreign/unattached/non-image IDs.

- [ ] **Step 1: Add RED model-copy tests**

```ts
expect(result.listing.title.en).toBe("Model-authored grounded title");
expect(result.listing.description["zh-Hant"]).toBe(
  "Model-authored grounded Traditional Chinese copy",
);
```

Keep the existing protected-fact mutation test and add an image-order mutation rejection.

- [ ] **Step 2: Run RED AI tests and return `modelListing` after grounding**

Run: `corepack pnpm --filter @wukong/ai exec vitest run src/openai-listing-provider.test.ts`

Implementation: parse, call `assertGenerationGrounding(modelListing, input)`, and return `listing: modelListing`. The compliance engine remains the approval gate for unsupported claims.

- [ ] **Step 3: Add RED image ownership/order tests**

Test requested order `[assetB, assetA]`, missing ID, duplicate ID, PDF ID, and asset attached to another draft. Assert only database storage keys reach `createReadUrl`.

- [ ] **Step 4: Implement the image resolver**

```ts
const assets = await sourceAssets.getByIds([...imageAssetIds]);
const byId = new Map(assets.map((asset) => [asset.id, asset]));
return Promise.all(
  imageAssetIds.map(async (id) => {
    const asset = byId.get(id);
    if (
      !asset ||
      asset.listingId !== draftId ||
      !asset.kind.startsWith("image/")
    )
      throw new ImageResolutionError();
    return (await assetStore.createReadUrl(workspaceId, asset.storageKey)).url;
  }),
);
```

Reject duplicate IDs before repository access.

- [ ] **Step 5: Use real image URLs for CSV and Worker publication**

Inject `getAssetStore()` in web delivery and the Worker runtime. Ensure the stable ledger digest hashes canonical content and asset IDs, not signed URLs.

- [ ] **Step 6: Run AI, web delivery, and worker image tests**

Run: `corepack pnpm --filter @wukong/ai test; corepack pnpm --filter @wukong/web exec vitest run lib/delivery-service.review-fix.test.ts app/api/listings/\[id\]/deliver; corepack pnpm --filter @wukong/worker exec vitest run src/image-resolver.test.ts`

- [ ] **Step 7: Commit**

```powershell
git add packages/ai/src apps/worker/src/image-resolver.ts apps/worker/src/image-resolver.test.ts apps/web/lib/delivery-service.ts apps/web/lib/delivery-service.review-fix.test.ts apps/web/app/api/listings/[id]/deliver
git commit -m "fix: preserve AI copy and deliver owned images"
```

---

### Task 8: Add Web Crypto token vault and fail-closed SHOPLINE adapters

**Files:**

- Create: `packages/shopline/src/token-vault.ts`
- Create: `packages/shopline/src/token-vault.test.ts`
- Modify: `packages/shopline/src/index.ts`
- Create: `apps/worker/src/shopline-runtime.ts`
- Create: `apps/worker/src/shopline-runtime.test.ts`
- Create: `packages/db/src/seed-shopline-connection.ts`
- Create: `packages/db/src/seed-shopline-connection.test.ts`
- Modify: `packages/db/package.json`
- Modify: `packages/db/src/index.ts`

**Interfaces:**

- `encryptShoplineToken(token, base64Key): Promise<string>`.
- `decryptShoplineToken(envelope, base64Key): Promise<string>`.
- `createShoplineConnectorFactory(env)` supports `disabled | mock | real`.

- [ ] **Step 1: Write RED token-vault tests**

```ts
const first = await encryptShoplineToken("shopline-token", key);
const second = await encryptShoplineToken("shopline-token", key);
expect(first).not.toBe(second);
await expect(decryptShoplineToken(first, key)).resolves.toBe("shopline-token");
await expect(decryptShoplineToken(first, wrongKey)).rejects.toThrow(
  "SHOPLINE credential is unavailable",
);
```

Assert errors never contain token, key, ciphertext, or Web Crypto details.

- [ ] **Step 2: Implement `v1` AES-256-GCM envelope**

Use `crypto.getRandomValues(new Uint8Array(12))`, import a decoded 32-byte key, and encode `v1.<iv>.<ciphertext-with-tag>` with base64url.

- [ ] **Step 3: Write RED adapter-mode tests**

Assert disabled never constructs a connector; mock returns a deterministic `mock_` plus SHA-256 prefix; real rejects unless both `SHOPLINE_PUBLISH_ENABLED=true` and a valid encryption key are present; real decrypts inside the Worker and creates `ShoplineConnector` without exposing the token.

- [ ] **Step 4: Implement the connector factory and controlled seed**

The seed reads one token line from stdin, encrypts before DB insertion, and writes only safe JSON:

```json
{
  "workspaceId": "ws_opak",
  "connectionId": "uuid",
  "shopDomain": "opakcellar.com"
}
```

No token argument or environment variable is accepted.

- [ ] **Step 5: Run package and worker tests**

Run: `corepack pnpm --filter @wukong/shopline test; corepack pnpm --filter @wukong/db test; corepack pnpm --filter @wukong/worker exec vitest run src/shopline-runtime.test.ts`

- [ ] **Step 6: Commit**

```powershell
git add packages/shopline packages/db apps/worker/src/shopline-runtime.ts apps/worker/src/shopline-runtime.test.ts pnpm-lock.yaml
git commit -m "feat: secure SHOPLINE credentials for Workers"
```

---

### Task 9: Implement two-phase SHOPLINE enqueue and leased Cloudflare consumer

**Files:**

- Modify: `apps/web/lib/delivery-service.ts`
- Modify: `apps/web/lib/delivery-service.review-fix.test.ts`
- Modify: `apps/web/app/api/listings/[id]/deliver/route.ts`
- Modify: `apps/web/app/api/listings/[id]/deliver/route.test.ts`
- Create: `apps/worker/src/shopline-consumer.ts`
- Create: `apps/worker/src/shopline-consumer.test.ts`
- Modify: `apps/worker/src/publish-product.ts`
- Modify: `apps/worker/src/publish-product.test.ts`
- Modify: `apps/worker/src/queue-consumer.ts`

**Interfaces:**

- `prepareShoplineDelivery` returns `{ kind: "publish_request"; jobId; versionId; connectionId }` after committing `pending_enqueue`.
- `confirmShoplineQueued` conditionally marks queued and audits.
- `consumeShoplineMessage` uses expected version and lease token.

- [ ] **Step 1: Add RED web tests for two-phase truthfulness**

Test that ingress failure returns retry-required, leaves `pending_enqueue`, writes `listing.publish_requested`, and does not write `listing.publish_queued`. Test that `202` then marks queued and returns database job ID. Test a simulated fast consumer state `running` is not regressed by confirmation.

- [ ] **Step 2: Refactor delivery preparation and confirmation**

API delivery orchestration must commit before network enqueue:

```ts
const prepared = await database.forWorkspace(workspaceId, (repos) =>
  prepareShoplineDelivery(input, repos),
);
await ingress.enqueue(SHOPLINE_INGRESS_PATH, {
  workspaceId,
  draftId,
  versionId: prepared.versionId,
  connectionId: prepared.connectionId,
});
await database.forWorkspace(workspaceId, (repos) =>
  confirmShoplineQueued(prepared, repos),
);
return { kind: "queued", jobId: prepared.jobId, versionId: prepared.versionId };
```

CSV remains synchronous and uses owned signed image URLs.

- [ ] **Step 3: Add RED consumer lease/duplicate tests**

Deliver the same message twice concurrently and assert one claim, one connector create, one remote ID, and one final published state. Add stale version, terminal credential, transient timeout, and expired-lease reclaim tests.

- [ ] **Step 4: Make `publishApprovedProduct` lease- and version-aware**

Add `expectedVersionId` and `leaseToken`. Reject a different active version before connector work. Every ledger completion/failure supplies the lease token. Preserve connector idempotency and remote-status recovery.

- [ ] **Step 5: Implement queue outcome classification**

Terminal safe codes acknowledge after persistence. `rate_limited`, `remote_unavailable`, timeout, and database availability request retry. On the final Cloudflare attempt, persist retryable failure and allow the platform to move the message to the configured DLQ.

- [ ] **Step 6: Run web, DB, and worker tests**

Run: `corepack pnpm --filter @wukong/web exec vitest run lib/delivery-service.review-fix.test.ts app/api/listings/\[id\]/deliver; corepack pnpm --filter @wukong/db test:integration; corepack pnpm --filter @wukong/worker exec vitest run src/publish-product.test.ts src/shopline-consumer.test.ts`

- [ ] **Step 7: Commit**

```powershell
git add apps/web/lib/delivery-service.ts apps/web/lib/delivery-service.review-fix.test.ts apps/web/app/api/listings/[id]/deliver apps/worker/src packages/db/src/repositories/publish-jobs.ts
git commit -m "feat: publish SHOPLINE jobs through Cloudflare"
```

---

### Task 10: Replace the direct helper with Wrangler real-stack acceptance

**Files:**

- Modify: `tests/e2e/real-stack-server.mjs`
- Modify: `tests/e2e/real-stack-fixture.ts`
- Modify: `tests/e2e/listing-pilot.spec.ts`
- Modify: `tests/e2e/real-stack-boundary.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `docker-compose.yml`

**Interfaces:**

- Starts `wrangler dev` plus production-built Next, Postgres, MinIO, and Mailpit.
- Uses local Queue simulation and `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`.

- [ ] **Step 1: Strengthen boundary test RED**

```ts
expect(fixtureSource).not.toMatch(
  /publishApprovedProduct|completeMockShoplinePublish/,
);
expect(serverSource).toMatch(/wrangler.+dev/);
expect(workerSource).toMatch(/fetch:/);
expect(workerSource).toMatch(/queue:/);
```

- [ ] **Step 2: Run boundary test and verify RED**

Run: `corepack pnpm exec playwright test tests/e2e/real-stack-boundary.spec.ts --project=chromium --workers=1`

- [ ] **Step 3: Replace the direct helper and Node worker process**

Generate local Wrangler config with non-production queue names and a syntactically valid local Hyperdrive ID. Set the local Hyperdrive connection environment variable to the runtime Postgres URL. Start Wrangler on `127.0.0.1:8787`, set Next's `QUEUE_INGRESS_URL`, and use the same test-only ingress secret on both processes.

- [ ] **Step 4: Make Playwright wait on ordinary published state**

After clicking publish, poll the listing API/UI until `remote_opak_e2e_123` appears. Do not call any worker domain function from the test process. Validate the CSV image URL with `HEAD` before expiry.

- [ ] **Step 5: Remove Redis from local services and E2E environment**

Delete Redis from the release harness and every `REDIS_URL` default. Preserve Postgres, MinIO, and Mailpit.

- [ ] **Step 6: Run the real-stack acceptance**

Run with `PLAYWRIGHT_E2E=1`: `corepack pnpm exec playwright test --project=chromium --workers=1 --reporter=line`

Expected: Opak auth/listing story and Cloudflare boundary pass; only the documented optional auth story may skip; exact draft audit has zero missing actions and zero accessible foreign records.

- [ ] **Step 7: Commit**

```powershell
git add tests/e2e playwright.config.ts docker-compose.yml
git commit -m "test: verify Cloudflare listing runtime end to end"
```

---

### Task 11: Update CI, runbooks, and the reproducible release gate

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ci-workflow.test.mjs`
- Modify: `scripts/check-runtime-format.mjs`
- Modify: `docs/runbooks/local-development.md`
- Rewrite: `docs/runbooks/production-ai-runtime.md`
- Modify: `docs/runbooks/production-readiness.md`
- Modify: `.superpowers/sdd/task-6-report.md`
- Modify: `package.json`

**Interfaces:**

- CI pins Node 24 and pnpm 11.7, builds dependencies, migrates Postgres, validates generated Wrangler config, runs Wrangler local Queue acceptance, and proves Redis/Railway absence.

- [ ] **Step 1: Write RED CI/config assertions**

Assert CI starts Postgres, MinIO, and Mailpit but not Redis; runs config render/validation and full Playwright; and scans for forbidden runtime dependencies. Assert the runbook contains exact Cloudflare resource names, variable allowlists, metrics, DLQ replay, migration, rollback, and first-real-write stop.

- [ ] **Step 2: Run RED configuration tests**

Run: `node --test tests/ci-workflow.test.mjs tests/cloudflare-config.test.mjs`

- [ ] **Step 3: Update CI and root scripts**

Root `test` runs both Node config tests before Turbo. CI uses a fake Hyperdrive ID only for generated-config validation and supplies the local Hyperdrive connection string only to Wrangler E2E.

- [ ] **Step 4: Rewrite runtime runbooks**

Document:

- Cloudflare Workers/Queues/Hyperdrive/R2 resource creation;
- preview and production isolation;
- Vercel and Worker variable allowlists;
- ingress-secret rotation;
- Queue/DLQ/backlog/oldest-message verification;
- Hyperdrive caching disabled;
- controlled migration and Opak seed;
- mock preview and disabled production SHOPLINE mode;
- explicit separate confirmation before enabling a real write;
- rollback without deleting queues, DLQs, R2, or Neon ledgers.

- [ ] **Step 5: Run the complete clean-checkout gate**

From a new detached worktree at the current head:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm format:runtime:check
corepack pnpm --filter @wukong/db... build
corepack pnpm --filter @wukong/db db:migrate
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
$env:PLAYWRIGHT_E2E='1'; corepack pnpm exec playwright test --project=chromium --workers=1 --reporter=line
```

Then run exact-draft `audit:verify` and require missing action count 0 and accessible foreign record count 0.

- [ ] **Step 6: Record exact evidence and run independent review**

Update Task 6 report with head SHA, runtime versions, counts, draft ID, audit sequence, config proof, and clean status. Request read-only review from merge base to head. Fix every Critical or Important issue and rerun affected plus full gates.

- [ ] **Step 7: Commit operations evidence**

```powershell
git add .github/workflows/ci.yml tests/ci-workflow.test.mjs tests/cloudflare-config.test.mjs scripts/check-runtime-format.mjs docs/runbooks package.json .superpowers/sdd/task-6-report.md
git commit -m "ops: define Cloudflare production runtime"
```

---

## Plan self-review checklist

- [x] Every reviewed Critical/Important finding maps to a task and a failing test.
- [x] Redis, BullMQ, Upstash, and Railway removal is tested, not only documented.
- [x] Vercel never receives a Cloudflare account token, OpenAI key, token-encryption key, or raw SHOPLINE credential.
- [x] Duplicate Cloudflare messages are handled by database leases and idempotency.
- [x] Hyperdrive uses RLS-safe transactions, caching disabled, and at most five client connections.
- [x] The browser acceptance uses the ordinary Worker ingress and Queue consumer, never a domain helper.
- [x] Production remains SHOPLINE-disabled until separate confirmation.
- [x] No task stages or edits the four protected user paths.
