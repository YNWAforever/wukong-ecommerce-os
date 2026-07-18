# Wukong Production AI Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the existing Opak listing workflow in production by connecting Vercel to a durable BullMQ queue, private R2 assets, an OpenAI-powered Railway worker, and explicit enqueue-recovery UI.

**Architecture:** Extract the existing BullMQ protocol into a focused `@wukong/jobs` workspace package shared by the Vercel publisher and Railway consumer. Keep Neon as the system of record, use private Cloudflare R2 for workspace-prefixed source assets, publish idempotent jobs through Upstash Redis, and run the existing listing pipeline as a private Railway worker. A saved-but-not-queued listing remains `received` and exposes an operator-safe retry; terminal worker failures remain diagnostic in this increment.

**Tech Stack:** Node.js 24, pnpm 11.7, TypeScript, Next.js 16.2, BullMQ 5.80, ioredis 5.10, Zod 4.4, AWS SDK v3, Cloudflare R2, Upstash Redis Fixed 250MB, Railway Railpack, Neon Postgres, OpenAI Responses API, Vitest, Playwright, Vercel.

## Global Constraints

- Preserve tenant isolation: every database lookup derives `workspaceId` and `actorId` from the authenticated session; request JSON never supplies either value.
- Queue payloads contain only `workspaceId`, `draftId`, and `activeVersionSequence`; never include file bytes, signed URLs, prompts, model output, or credentials.
- Use queue name `listing-pipeline`, three attempts, and exponential backoff beginning at 2,000 ms.
- Treat Neon as authoritative; Redis queue state is transport state, not listing state.
- `POST /api/listings` returns HTTP 201 after the database commit whether enqueue succeeds or fails, with `processing.state` equal to `queued` or `retry_required`.
- `POST /api/listings/{id}/process` repairs only a `received` listing that was not claimed by a pipeline run and requires `operator` or higher.
- Do not add terminal `failed` pipeline retry in this increment; it needs a separate lease-reset contract.
- Use `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION=auto`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE=false` in both web and worker runtimes.
- The Railway worker receives no Better Auth, Resend, or SHOPLINE secrets. Vercel receives no `OPENAI_API_KEY`.
- Railway startup never runs database migrations. Run migrations once in the controlled release workflow.
- Use `AI_PROVIDER=openai` and `OPENAI_LISTING_MODEL=gpt-5.6-terra`; unavailable model access blocks deployment rather than silently selecting another model.
- Keep the R2 bucket private and limit its token to Object Read & Write on that bucket.
- Do not commit or print secrets. Enter sensitive values through provider dashboards or approved CLI stdin flows.
- Do not perform the first real SHOPLINE product write without a separate final user confirmation.
- Preserve the unrelated working-tree changes in `.gitignore`, `apps/web/.gitignore`, `apps/web/auth.test.ts`, and `docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md`.

## File Structure

### New files

- `packages/jobs/package.json` — workspace metadata and BullMQ/Zod dependencies.
- `packages/jobs/tsconfig.json` — package build configuration.
- `packages/jobs/src/listing-queue.ts` — payload schema, job IDs, queue factory, and enqueue policy.
- `packages/jobs/src/index.ts` — public package exports.
- `packages/jobs/src/listing-queue.test.ts` — protocol and idempotency unit tests.
- `packages/jobs/src/listing-queue.integration.test.ts` — Redis duplicate-enqueue integration test.
- `packages/assets/src/s3-runtime-config.ts` — one strict R2/S3 environment parser used by both runtimes.
- `packages/assets/src/s3-runtime-config.test.ts` — credential-pair, region, endpoint, and path-style tests.
- `apps/web/lib/listing-queue-runtime.ts` — lazy server-only Upstash/ioredis publisher singleton.
- `apps/web/lib/listing-queue-runtime.test.ts` — fail-closed configuration and injected-queue tests.
- `apps/web/app/api/listings/route.create.test.ts` — creation response tests for queued and retry-required outcomes.
- `apps/web/app/api/listings/[id]/process/route.ts` — authenticated publication-gap retry endpoint.
- `apps/web/app/api/listings/[id]/process/route.test.ts` — role, tenant, status, assets, active-run, idempotency, and outage tests.
- `apps/web/components/listing-processing-panel.tsx` — received, processing, needs-info, and failed operator state.
- `apps/web/components/listing-processing-panel.test.tsx` — processing copy and retry-control tests.
- `railway.json` — private worker build, start, watch, and restart policy.
- `tests/railway-config.test.mjs` — config-as-code regression test.
- `docs/runbooks/production-ai-runtime.md` — exact resource, variable, deployment, verification, and rollback procedure.

### Modified files

- `pnpm-lock.yaml` — records the new workspace package and dependency edges.
- `package.json` — includes the Railway config test in the repository test gate.
- `.env.example` — documents names and non-secret fixed values only.
- `packages/assets/src/index.ts` — exports the shared runtime parser.
- `apps/worker/package.json` — consumes `@wukong/jobs` and adds `start:production`.
- `apps/worker/src/index.ts` — imports the shared queue protocol.
- `apps/worker/src/listing-pipeline.ts` — imports the canonical input and ID helper from `@wukong/jobs`.
- `apps/worker/src/runtime.ts` — uses explicit shared R2 configuration and never migrates at startup.
- `apps/worker/src/runtime.test.ts` — verifies credentials and no startup migration.
- `apps/worker/src/queue.test.ts`, `queue-job-id.test.ts`, `queue.integration.test.ts`, `queue.ts` — removed after their behavior moves to `@wukong/jobs`.
- `apps/web/package.json` — consumes `@wukong/jobs` and `ioredis`.
- `apps/web/lib/intake-runtime.ts` — consumes the shared R2 parser.
- `apps/web/lib/intake-route-deps.ts` — adds the narrow listing publisher port.
- `apps/web/app/api/listings/route.ts` — enqueues after commit and returns explicit processing state.
- `apps/web/app/api/intake-routes.test.ts`, `listing-validation.test.ts`, `listing-composition.test.ts` — inject a fake publisher into existing route harnesses.
- `apps/web/app/api/listings/[id]/route.ts` and `.test.ts` — expose `canProcess` using the existing role hierarchy.
- `apps/web/components/listing-intake-client.tsx` and `.test.ts` — retain processing outcome and navigate to the created listing.
- `apps/web/app/(app)/listings/[id]/page.tsx` — validates the creation outcome query and passes it as initial processing state.
- `apps/web/components/listing-review-client.tsx` and `.test.ts` — render/poll processing state instead of treating no active version as a mapping error.
- `docs/runbooks/production-readiness.md` — links the runtime runbook and records the no-worker-migration rule.

---

### Task 1: Extract the Shared Listing Queue Contract

**Files:**
- Create: `packages/jobs/package.json`
- Create: `packages/jobs/tsconfig.json`
- Create: `packages/jobs/src/listing-queue.ts`
- Create: `packages/jobs/src/index.ts`
- Create: `packages/jobs/src/listing-queue.test.ts`
- Create: `packages/jobs/src/listing-queue.integration.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/listing-pipeline.ts`
- Delete: `apps/worker/src/queue.ts`
- Delete: `apps/worker/src/queue.test.ts`
- Delete: `apps/worker/src/queue-job-id.test.ts`
- Delete: `apps/worker/src/queue.integration.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: BullMQ `Queue`, `ConnectionOptions`, and `JobsOptions`; Zod.
- Produces: `listingJobSchema`, `ListingJobInput`, `ListingQueuePayload`, `ListingQueuePort`, `LISTING_QUEUE`, `listingPipelineJobId(input)`, `bullmqListingJobId(input)`, `createListingQueue(connection)`, and `enqueueListingPipeline(input, { queue })`.

- [ ] **Step 1: Create package scaffolding and the failing protocol tests**

`packages/jobs/package.json`:

```json
{
  "name": "@wukong/jobs",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "development": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --exclude src/**/*.integration.test.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "bullmq": "^5.80.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "latest",
    "ioredis": "^5.10.1",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

`packages/jobs/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

Move the assertions from the three worker queue tests into `packages/jobs/src/listing-queue.test.ts`, and add malformed-payload cases:

```ts
it.each([
  {},
  { workspaceId: "", draftId: "draft_1", activeVersionSequence: 0 },
  { workspaceId: "ws_opak", draftId: "", activeVersionSequence: 0 },
  { workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: -1 },
])("rejects malformed queue identity %#", (input) => {
  expect(() => listingJobSchema.parse(input)).toThrow();
});
```

- [ ] **Step 2: Install the workspace graph and run the tests to verify failure**

Run: `pnpm.cmd install --lockfile-only`

Run: `pnpm.cmd --filter @wukong/jobs test`

Expected: FAIL because `listing-queue.ts` and its exports do not exist.

- [ ] **Step 3: Implement the complete shared protocol**

`packages/jobs/src/listing-queue.ts`:

```ts
import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { z } from "zod";

export const LISTING_QUEUE = "listing-pipeline";

export const listingJobSchema = z.object({
  workspaceId: z.string().trim().min(1),
  draftId: z.string().trim().min(1),
  activeVersionSequence: z.number().int().nonnegative(),
}).strict();

export type ListingJobInput = z.infer<typeof listingJobSchema>;
export type ListingQueuePayload = Readonly<ListingJobInput>;

export type ListingQueuePort = {
  add(
    name: string,
    data: ListingQueuePayload,
    options: JobsOptions,
  ): Promise<{ id?: string }>;
};

export function listingPipelineJobId(input: ListingJobInput): string {
  const parsed = listingJobSchema.parse(input);
  return `listing:${parsed.workspaceId}:${parsed.draftId}:${parsed.activeVersionSequence}`;
}

export function bullmqListingJobId(input: ListingJobInput): string {
  return Buffer.from(listingPipelineJobId(input), "utf8").toString("base64url");
}

export function createListingQueue(
  connection: ConnectionOptions,
): Queue<ListingQueuePayload> {
  return new Queue<ListingQueuePayload>(LISTING_QUEUE, { connection });
}

export async function enqueueListingPipeline(
  input: ListingJobInput,
  dependencies: { queue: ListingQueuePort },
): Promise<{ id?: string }> {
  const data = listingJobSchema.parse(input);
  return dependencies.queue.add(LISTING_QUEUE, data, {
    jobId: bullmqListingJobId(data),
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
  });
}
```

`packages/jobs/src/index.ts` exports every symbol listed in the Interfaces block. Move the existing Redis integration test unchanged except for imports from `./listing-queue.js`.

- [ ] **Step 4: Verify the package tests pass**

Run: `pnpm.cmd --filter @wukong/jobs test`

Expected: PASS for payload validation, exact queue policy, canonical IDs, BullMQ-safe IDs, and payload-key allowlist.

- [ ] **Step 5: Repoint the worker and remove the duplicated files**

Add `"@wukong/jobs": "workspace:*"` to `apps/worker/package.json`. In `apps/worker/src/listing-pipeline.ts`, replace the local input and ID definitions with:

```ts
import { listingPipelineJobId, type ListingJobInput } from "@wukong/jobs";

export type ListingPipelineInput = ListingJobInput;
```

In `apps/worker/src/index.ts`, import and re-export the shared protocol:

```ts
import {
  LISTING_QUEUE,
  type ListingQueuePayload,
} from "@wukong/jobs";

export {
  LISTING_QUEUE,
  bullmqListingJobId,
  createListingQueue,
  enqueueListingPipeline,
  type ListingQueuePayload,
  type ListingQueuePort,
} from "@wukong/jobs";
```

Delete the four obsolete worker queue files listed above.

- [ ] **Step 6: Run package and worker verification**

Run: `pnpm.cmd --filter @wukong/jobs build; pnpm.cmd --filter @wukong/jobs test; pnpm.cmd --filter @wukong/worker test; pnpm.cmd --filter @wukong/worker typecheck`

Expected: all commands PASS; the worker processor still passes BullMQ attempt numbers into `runListingPipeline`.

- [ ] **Step 7: Run Redis integration verification**

Run with Redis on port 6389: `pnpm.cmd exec vitest run packages/jobs/src/listing-queue.integration.test.ts --config vitest.integration.config.ts`

Expected: PASS; duplicate enqueue produces one waiting job with the original payload.

- [ ] **Step 8: Commit the shared protocol**

```powershell
git add packages/jobs apps/worker/package.json apps/worker/src/index.ts apps/worker/src/listing-pipeline.ts apps/worker/src/queue.ts apps/worker/src/queue.test.ts apps/worker/src/queue-job-id.test.ts apps/worker/src/queue.integration.test.ts pnpm-lock.yaml
git commit -m "refactor: share listing queue protocol"
```

### Task 2: Unify R2 Runtime Configuration and Remove Worker Migrations

**Files:**
- Create: `packages/assets/src/s3-runtime-config.ts`
- Create: `packages/assets/src/s3-runtime-config.test.ts`
- Modify: `packages/assets/src/index.ts`
- Modify: `apps/web/lib/intake-runtime.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`

**Interfaces:**
- Consumes: `NodeJS.ProcessEnv`-shaped records and AWS SDK `S3ClientConfig`.
- Produces: `readS3RuntimeConfig(env): { bucket: string; client: S3ClientConfig }`.

- [ ] **Step 1: Write failing shared configuration tests**

`packages/assets/src/s3-runtime-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readS3RuntimeConfig } from "./s3-runtime-config.js";

const valid = {
  S3_BUCKET: "wukong-opak-prod-assets",
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_FORCE_PATH_STYLE: "false",
};

it("returns one explicit R2 client configuration", () => {
  expect(readS3RuntimeConfig(valid)).toEqual({
    bucket: "wukong-opak-prod-assets",
    client: {
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      forcePathStyle: false,
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
    },
  });
});

it.each(["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])(
  "fails closed when %s is missing",
  (name) => expect(() => readS3RuntimeConfig({ ...valid, [name]: "" })).toThrow(name),
);

it("rejects a non-boolean path-style value", () => {
  expect(() => readS3RuntimeConfig({ ...valid, S3_FORCE_PATH_STYLE: "sometimes" })).toThrow("S3_FORCE_PATH_STYLE");
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `pnpm.cmd --filter @wukong/assets test -- s3-runtime-config.test.ts`

Expected: FAIL because `readS3RuntimeConfig` does not exist.

- [ ] **Step 3: Implement and export the shared parser**

`packages/assets/src/s3-runtime-config.ts`:

```ts
import type { S3ClientConfig } from "@aws-sdk/client-s3";

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function required(env: RuntimeEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readS3RuntimeConfig(env: RuntimeEnv): {
  bucket: string;
  client: S3ClientConfig;
} {
  const pathStyle = env.S3_FORCE_PATH_STYLE ?? "false";
  if (pathStyle !== "true" && pathStyle !== "false") {
    throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  }
  return {
    bucket: required(env, "S3_BUCKET"),
    client: {
      endpoint: required(env, "S3_ENDPOINT"),
      region: env.S3_REGION?.trim() || "auto",
      forcePathStyle: pathStyle === "true",
      credentials: {
        accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
      },
    },
  };
}
```

Export `readS3RuntimeConfig` from `packages/assets/src/index.ts`.

- [ ] **Step 4: Run the shared tests**

Run: `pnpm.cmd --filter @wukong/assets test -- s3-runtime-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Consume the parser in web and worker runtimes**

Replace the web asset initialization with:

```ts
const config = readS3RuntimeConfig(process.env);
assetStore ??= S3AssetStore.fromConfig(config.bucket, config.client);
```

In `apps/worker/src/runtime.ts`, remove `migrationUrl` and the `database.migrate()` call. Change the asset factory to accept the full AWS client config, and construct it from `readS3RuntimeConfig(process.env)`:

```ts
const storage = readS3RuntimeConfig(process.env);
const assetStore = (config.assetStoreFactory ??
  ((bucket, client) => DefaultS3AssetStore.fromConfig(bucket, client)))(
  storage.bucket,
  storage.client,
);
```

Keep explicit `databaseUrl`, `redisUrl`, and injected test factories. Do not read `DATABASE_ADMIN_URL` or `DATABASE_MIGRATION_URL` in worker startup.

- [ ] **Step 6: Extend worker runtime tests**

Add assertions that the worker passes the explicit endpoint, region, force-path-style, and credential pair into `assetStoreFactory`, and that `database.migrate` is not called:

```ts
expect(database.migrate).not.toHaveBeenCalled();
expect(assetStoreFactory).toHaveBeenCalledWith(
  "wukong-opak-prod-assets",
  expect.objectContaining({
    region: "auto",
    forcePathStyle: false,
    credentials: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
  }),
);
```

Use `vi.stubEnv` for every required S3 variable and restore it in `afterEach`.

- [ ] **Step 7: Run focused and cross-runtime verification**

Run: `pnpm.cmd --filter @wukong/assets test; pnpm.cmd --filter @wukong/worker test; pnpm.cmd --filter @wukong/worker typecheck; pnpm.cmd --filter @wukong/web typecheck`

Expected: all PASS; no worker runtime reference to either migration URL remains.

- [ ] **Step 8: Commit unified storage configuration**

```powershell
git add packages/assets/src apps/web/lib/intake-runtime.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts
git commit -m "fix: unify production asset runtime"
```

### Task 3: Publish a Listing Job After the Database Commit

**Files:**
- Create: `apps/web/lib/listing-queue-runtime.ts`
- Create: `apps/web/lib/listing-queue-runtime.test.ts`
- Create: `apps/web/app/api/listings/route.create.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/lib/intake-route-deps.ts`
- Modify: `apps/web/app/api/listings/route.ts`
- Modify: `apps/web/app/api/intake-routes.test.ts`
- Modify: `apps/web/app/api/listing-validation.test.ts`
- Modify: `apps/web/app/api/listing-composition.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `ListingJobInput`, `createListingQueue`, `enqueueListingPipeline`, `REDIS_URL`, session context, and workspace repositories.
- Produces: `ListingPublisher.enqueue(input): Promise<{ id: string }>` and creation JSON `{ listing, processing: { state, jobId, errorCode } }`.

- [ ] **Step 1: Write failing publisher-runtime tests**

`apps/web/lib/listing-queue-runtime.test.ts` must assert:

```ts
it("fails closed without REDIS_URL", async () => {
  await expect(createListingPublisher({ env: {} }).enqueue({
    workspaceId: "ws_opak",
    draftId: "draft_1",
    activeVersionSequence: 0,
  })).rejects.toThrow("REDIS_URL is required");
});

it("passes only listing identity to the injected queue", async () => {
  const add = vi.fn(async (_name, _data, options) => ({ id: String(options.jobId) }));
  const publisher = createListingPublisher({
    env: { REDIS_URL: "rediss://default:secret@example.upstash.io:6379" },
    redisFactory: () => ({ quit: vi.fn() }) as never,
    queueFactory: () => ({ add }) as never,
  });
  const result = await publisher.enqueue({
    workspaceId: "ws_opak",
    draftId: "draft_1",
    activeVersionSequence: 0,
  });
  expect(result.id).toBeTruthy();
  expect(add.mock.calls[0]?.[1]).toEqual({
    workspaceId: "ws_opak",
    draftId: "draft_1",
    activeVersionSequence: 0,
  });
});
```

- [ ] **Step 2: Run the publisher test to verify failure**

Run: `pnpm.cmd --filter @wukong/web test -- lib/listing-queue-runtime.test.ts`

Expected: FAIL because the runtime and dependencies do not exist.

- [ ] **Step 3: Implement the lazy server-only publisher**

Add `@wukong/jobs` and `ioredis` to web dependencies. Implement:

```ts

import { Redis } from "ioredis";
import {
  createListingQueue,
  enqueueListingPipeline,
  type ListingJobInput,
  type ListingQueuePort,
} from "@wukong/jobs";

export type ListingPublisher = {
  enqueue(input: ListingJobInput): Promise<{ id: string }>;
};

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  redisFactory?: (url: string) => Redis;
  queueFactory?: (connection: Redis) => ListingQueuePort;
};

export function createListingPublisher(options: Options = {}): ListingPublisher {
  let queue: ListingQueuePort | undefined;
  return {
    async enqueue(input) {
      const url = (options.env ?? process.env).REDIS_URL?.trim();
      if (!url) throw new Error("REDIS_URL is required");
      if (!queue) {
        const redis = (options.redisFactory ??
          ((value) => new Redis(value, { maxRetriesPerRequest: null })))(url);
        queue = (options.queueFactory ??
          ((connection) => createListingQueue(connection as never)))(redis);
      }
      const job = await enqueueListingPipeline(input, { queue });
      if (!job.id) throw new Error("listing queue did not return a job id");
      return { id: job.id };
    },
  };
}

export const listingPublisher = createListingPublisher();
```

- [ ] **Step 4: Run publisher tests**

Run: `pnpm.cmd install --lockfile-only; pnpm.cmd --filter @wukong/jobs build; pnpm.cmd --filter @wukong/web test -- lib/listing-queue-runtime.test.ts`

Expected: PASS without a network connection.

- [ ] **Step 5: Write failing listing-creation outcome tests**

Build a route harness that commits one `received` listing and injects `publisher.enqueue`. Assert the success path:

```ts
expect(response.status).toBe(201);
expect(await response.json()).toMatchObject({
  listing: { id: listingId, status: "received", target: "shopline" },
  processing: { state: "queued", jobId: "job_1", errorCode: null },
});
expect(enqueue).toHaveBeenCalledWith({
  workspaceId: "ws_opak",
  draftId: listingId,
  activeVersionSequence: 0,
});
```

Assert the Redis failure path still returns the committed listing:

```ts
enqueue.mockRejectedValueOnce(new Error("connect timeout"));
expect(response.status).toBe(201);
expect(await response.json()).toMatchObject({
  listing: { id: listingId, status: "received" },
  processing: {
    state: "retry_required",
    jobId: null,
    errorCode: "queue_unavailable",
  },
});
expect(mutations).toEqual(["create", "attach", "audit"]);
```

- [ ] **Step 6: Run route tests to verify failure**

Run: `pnpm.cmd --filter @wukong/web test -- app/api/listings/route.create.test.ts`

Expected: FAIL because listing creation does not publish or return `processing`.

- [ ] **Step 7: Implement the post-commit handoff**

Add `publisher: ListingPublisher` to `IntakeRouteDeps`. Keep the existing database unit of work unchanged, then enqueue outside it:

```ts
let processing:
  | { state: "queued"; jobId: string; errorCode: null }
  | { state: "retry_required"; jobId: null; errorCode: "queue_unavailable" };

try {
  const job = await deps.publisher.enqueue({
    workspaceId: context.workspaceId,
    draftId: listing.id,
    activeVersionSequence: 0,
  });
  processing = { state: "queued", jobId: job.id, errorCode: null };
  console.info(JSON.stringify({
    event: "listing.enqueue_accepted",
    workspaceId: context.workspaceId,
    listingId: listing.id,
    jobId: job.id,
  }));
} catch {
  processing = {
    state: "retry_required",
    jobId: null,
    errorCode: "queue_unavailable",
  };
  console.error(JSON.stringify({
    event: "listing.enqueue_failed",
    workspaceId: context.workspaceId,
    listingId: listing.id,
    errorCode: "queue_unavailable",
  }));
}

return jsonResponse(201, { listing: { id: listing.id, status: listing.status, target: listing.target }, processing });
```

Wire the production route to `listingPublisher`. Update every existing `createListingHandler` harness to inject a fake publisher that returns `{ id: "job_test" }`.

- [ ] **Step 8: Run all affected web tests and typecheck**

Run: `pnpm.cmd --filter @wukong/web test -- app/api/listings/route.create.test.ts app/api/intake-routes.test.ts app/api/listing-validation.test.ts app/api/listing-composition.test.ts lib/listing-queue-runtime.test.ts; pnpm.cmd --filter @wukong/web typecheck`

Expected: PASS; outage logs contain IDs and safe code only, never the thrown connection message.

- [ ] **Step 9: Commit the web publisher**

```powershell
git add apps/web/package.json apps/web/lib/listing-queue-runtime.ts apps/web/lib/listing-queue-runtime.test.ts apps/web/lib/intake-route-deps.ts apps/web/app/api/listings/route.ts apps/web/app/api/listings/route.create.test.ts apps/web/app/api/intake-routes.test.ts apps/web/app/api/listing-validation.test.ts apps/web/app/api/listing-composition.test.ts pnpm-lock.yaml
git commit -m "feat: enqueue new listings for processing"
```

### Task 4: Add Safe Queue-Publication Retry and Processing UI

**Files:**
- Create: `apps/web/app/api/listings/[id]/process/route.ts`
- Create: `apps/web/app/api/listings/[id]/process/route.test.ts`
- Create: `apps/web/components/listing-processing-panel.tsx`
- Create: `apps/web/components/listing-processing-panel.test.tsx`
- Modify: `apps/web/app/api/listings/[id]/route.ts`
- Modify: `apps/web/app/api/listings/[id]/route.test.ts`
- Modify: `apps/web/components/listing-intake-client.tsx`
- Modify: `apps/web/components/listing-intake-client.test.ts`
- Modify: `apps/web/components/listing-review-client.tsx`
- Modify: `apps/web/components/listing-review-client.test.ts`

**Interfaces:**
- Consumes: `requireWorkspaceRole("operator", role)`, `listings.requireById`, `sourceAssets.listForListing`, `pipelineRuns.getState`, and `ListingPublisher`.
- Produces: process response `{ processing: { state: "queued"; jobId: string } }`, `permissions.canProcess`, and `ListingProcessingPanel`.

- [ ] **Step 1: Write failing process-route authorization and state tests**

Use a tenant-scoped database harness and assert:

```ts
it.each(["operator", "reviewer", "admin", "owner"] as const)(
  "allows %s to repair a received listing",
  async (role) => {
    const response = await handlerFor({ role, status: "received", assets: 1 })(request, context);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      processing: { state: "queued", jobId: "job_1" },
    });
  },
);

it("rejects viewers", async () => {
  expect((await handlerFor({ role: "viewer" })(request, context)).status).toBe(403);
});

it.each(["processing", "needs_info", "in_review", "failed", "approved"])(
  "rejects non-received status %s",
  async (status) => expect((await handlerFor({ status })(request, context)).status).toBe(409),
);

it("rejects a received listing with no finalized assets", async () => {
  expect((await handlerFor({ status: "received", assets: 0 })(request, context)).status).toBe(409);
});

it("rejects an existing pipeline run", async () => {
  expect((await handlerFor({ pipelineState: "started" })(request, context)).status).toBe(409);
});

it("returns 503 without changing the listing when Redis is unavailable", async () => {
  expect((await handlerFor({ enqueueError: true })(request, context)).status).toBe(503);
});
```

Also prove a foreign listing ID returns 404 from the scoped repository and never enqueues.

- [ ] **Step 2: Run the process-route tests to verify failure**

Run: `pnpm.cmd --filter @wukong/web test -- 'app/api/listings/[id]/process/route.test.ts'`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement the process endpoint**

Use the existing route error wrapper and exact guards:

```ts
const session = await requireSessionContext(deps.sessionContext);
if (!requireWorkspaceRole("operator", session.role)) {
  throw new ApiError(403, "insufficient_role", "Operator access is required.");
}
const { id } = await context.params;
if (!/^[0-9a-f-]{36}$/i.test(id)) {
  throw new ApiError(404, "listing_not_found", "Listing not found.");
}

const input = await deps.getDatabase().forWorkspace(session.workspaceId, async (repositories) => {
  const listing = await repositories.listings.getById(id);
  if (!listing) throw new ApiError(404, "listing_not_found", "Listing not found.");
  if (listing.status !== "received") {
    throw new ApiError(409, "listing_not_retryable", "Only a received listing can start processing.");
  }
  const revision = await repositories.listings.requireById(id);
  const assets = await repositories.sourceAssets.listForListing(id);
  if (assets.length === 0) {
    throw new ApiError(409, "listing_has_no_assets", "The listing has no finalized source assets.");
  }
  const key = listingPipelineJobId({
    workspaceId: session.workspaceId,
    draftId: id,
    activeVersionSequence: revision.activeVersionSequence,
  });
  if (await repositories.pipelineRuns.getState(key)) {
    throw new ApiError(409, "processing_already_started", "Processing has already started.");
  }
  return { workspaceId: session.workspaceId, draftId: id, activeVersionSequence: revision.activeVersionSequence };
});

try {
  const job = await deps.publisher.enqueue(input);
  return jsonResponse(202, { processing: { state: "queued", jobId: job.id } });
} catch {
  throw new ApiError(503, "queue_unavailable", "Processing could not be queued. Try again.");
}
```

Export a dependency-injected handler and wire it to `authSessionContext`, `getDatabase`, and `listingPublisher`.

- [ ] **Step 4: Run process-route tests**

Run: `pnpm.cmd --filter @wukong/web test -- 'app/api/listings/[id]/process/route.test.ts'`

Expected: PASS for permissions, tenant isolation, status, assets, active run, outage, and job response.

- [ ] **Step 5: Expose the process permission in listing detail**

Extend `listingPermissions` with:

```ts
canProcess: rank >= 20,
```

Add `canProcess` to `ListingPermissions` and update the existing role matrix: viewer false; operator, reviewer, admin, and owner true.

- [ ] **Step 6: Write failing processing-panel and view-state tests**

Assert exact behavior:

```tsx
expect(renderToStaticMarkup(
  <ListingProcessingPanel status="received" enqueueState="retry_required" canProcess onProcess={vi.fn()} busy={false} />,
)).toContain("Start processing");

expect(renderToStaticMarkup(
  <ListingProcessingPanel status="received" enqueueState="queued" canProcess onProcess={vi.fn()} busy={false} />,
)).not.toContain("Start processing");

expect(renderToStaticMarkup(
  <ListingProcessingPanel status="processing" canProcess onProcess={vi.fn()} busy={false} />,
)).not.toContain("Start processing");

expect(resolveListingViewState({
  snapshotStatus: "received",
  hasSnapshot: true,
  hasMappedView: false,
  loadError: null,
  mappingError: null,
})).toEqual({ kind: "processing", status: "received" });
```

Add equivalent tests for `processing`, `needs_info`, and `failed`. Only `received` with `enqueueState="retry_required"` or no known enqueue outcome has a retry/start button; `enqueueState="queued"` shows a waiting state without the button. Keep the existing mapping-error test for an invalid active version.

- [ ] **Step 7: Run UI tests to verify failure**

Run: `pnpm.cmd --filter @wukong/web test -- components/listing-processing-panel.test.tsx components/listing-review-client.test.ts components/listing-intake-client.test.ts`

Expected: FAIL because the processing render state and panel do not exist.

- [ ] **Step 8: Implement processing UI, polling, and navigation**

Change intake result to:

```ts
export type CreateListingDraftResult = {
  listingId: string;
  processing: "queued" | "retry_required";
};
```

Read `result.processing.state`, return it, and navigate to:

```ts
router.push(`/listings/${encodeURIComponent(result.listingId)}?processing=${result.processing}`);
```

Change `apps/web/app/(app)/listings/[id]/page.tsx` to validate `searchParams.processing` against `queued` and `retry_required`, then pass `initialProcessing` to `ListingReviewClient`. Keep this value in component state, set it to `queued` after a successful process request, and clear it once the persisted status becomes `processing`, `needs_info`, `in_review`, or `failed`.

```tsx
export default async function ListingReviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ processing?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const initialProcessing = query.processing === "queued" || query.processing === "retry_required"
    ? query.processing
    : undefined;
  return <ListingReviewClient listingId={id} initialProcessing={initialProcessing} />;
}
```

`ListingProcessingPanel` renders status-specific Cantonese-first copy with short English labels:

- `received` plus `queued`: “已加入處理佇列 · Queued for processing”, without a retry button.
- `received` plus `retry_required` or no known outcome: “尚未開始處理 · Processing not started” and “開始處理 · Start processing”.
- `processing`: “AI 正在建立商品資料 · AI processing”.
- `needs_info`: “需要補充商品資料 · More information needed”.
- `failed`: “AI 處理未完成 · Processing failed” and a support-recovery explanation, no retry button.

In `ListingReviewClient`, do not call `mapListingView` when `activeVersion` is null and the status is one of those four states. Render the panel, call `POST /api/listings/{id}/process` for `received`, reload after success, and poll `GET /api/listings/{id}` every three seconds only while status is `received` or `processing`. Clear the interval on unmount.

```tsx
useEffect(() => {
  if (snapshot?.status !== "received" && snapshot?.status !== "processing") return;
  const timer = window.setInterval(() => {
    load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Unable to refresh listing.");
    });
  }, 3_000);
  return () => window.clearInterval(timer);
}, [load, snapshot?.status]);
```

- [ ] **Step 9: Run focused UI/API verification**

Run: `pnpm.cmd --filter @wukong/web test -- components/listing-processing-panel.test.tsx components/listing-review-client.test.ts components/listing-intake-client.test.ts 'app/api/listings/[id]/route.test.ts' 'app/api/listings/[id]/process/route.test.ts'; pnpm.cmd --filter @wukong/web typecheck`

Expected: PASS; a listing without an AI version no longer renders a false mapping error.

- [ ] **Step 10: Commit retry and processing UX**

```powershell
git add apps/web/app/api/listings/[id]/process apps/web/app/api/listings/[id]/route.ts apps/web/app/api/listings/[id]/route.test.ts apps/web/app/(app)/listings/[id]/page.tsx apps/web/components/listing-processing-panel.tsx apps/web/components/listing-processing-panel.test.tsx apps/web/components/listing-intake-client.tsx apps/web/components/listing-intake-client.test.ts apps/web/components/listing-review-client.tsx apps/web/components/listing-review-client.test.ts
git commit -m "feat: add listing processing recovery"
```

### Task 5: Add Railway Configuration and Production Runbook

**Files:**
- Create: `railway.json`
- Create: `tests/railway-config.test.mjs`
- Create: `docs/runbooks/production-ai-runtime.md`
- Modify: `apps/worker/package.json`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `docs/runbooks/production-readiness.md`

**Interfaces:**
- Consumes: root pnpm workspace, `@wukong/worker` compiled entrypoint, and environment variables in Global Constraints.
- Produces: a private Railpack worker deployment with restart-on-failure and a reproducible operator runbook.

- [ ] **Step 1: Write the failing Railway config regression test**

`tests/railway-config.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(readFileSync(new URL("../railway.json", import.meta.url), "utf8"));
const worker = JSON.parse(readFileSync(new URL("../apps/worker/package.json", import.meta.url), "utf8"));

test("runs only the compiled private worker with bounded restart recovery", () => {
  assert.equal(config.build.builder, "RAILPACK");
  assert.match(config.build.buildCommand, /pnpm --filter @wukong\/worker\.\.\. build/);
  assert.equal(config.deploy.startCommand, "pnpm --filter @wukong/worker start:production");
  assert.equal(config.deploy.restartPolicyType, "ON_FAILURE");
  assert.equal(config.deploy.restartPolicyMaxRetries, 10);
  assert.equal(worker.scripts["start:production"], "node dist/cli.js");
  assert.equal(config.deploy.preDeployCommand, undefined);
  assert.equal(config.deploy.healthcheckPath, undefined);
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `node --test tests/railway-config.test.mjs`

Expected: FAIL because `railway.json` does not exist.

- [ ] **Step 3: Add exact worker config-as-code**

`railway.json`:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @wukong/worker... build",
    "watchPatterns": [
      "apps/worker/**",
      "packages/ai/**",
      "packages/assets/**",
      "packages/core/**",
      "packages/db/**",
      "packages/jobs/**",
      "packages/shopline/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "turbo.json",
      "railway.json"
    ]
  },
  "deploy": {
    "startCommand": "pnpm --filter @wukong/worker start:production",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10,
    "drainingSeconds": "30"
  }
}
```

Add `"start:production": "node dist/cli.js"` to the worker. Do not add a health check because this process intentionally exposes no port. Do not add a pre-deploy migration command.

- [ ] **Step 4: Add the config test to the repository gate**

Change the root test script to:

```json
"test": "node --test tests/ci-workflow.test.mjs tests/railway-config.test.mjs && turbo run test"
```

Run: `node --test tests/ci-workflow.test.mjs tests/railway-config.test.mjs`

Expected: PASS.

- [ ] **Step 5: Document non-secret environment names**

Expand `.env.example` with names only and safe fixed values:

```dotenv
DATABASE_URL=
REDIS_URL=
S3_BUCKET=
S3_ENDPOINT=
S3_REGION=auto
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_LISTING_MODEL=gpt-5.6-terra
```

State beside the Railway section that `DATABASE_ADMIN_URL` is a release-only variable and must not be stored on the worker.

- [ ] **Step 6: Write the production runtime runbook**

The runbook must contain these exact sections and checks:

1. Cost decision: Upstash Fixed 250MB at the current $10/month because Upstash warns that BullMQ polls while idle; Railway Hobby has its current monthly minimum; R2 Standard begins with its published free tier.
2. Resource names: R2 `wukong-opak-prod-assets`, Upstash `wukong-listing-queue-prod`, Railway project `wukong-ecommerce-os`, service `listing-worker`.
3. R2 CORS JSON:

```json
[
  {
    "AllowedOrigins": [
      "https://wukong-ecommerce-os.vercel.app",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

The selected preview deployment origin is added immediately before preview browser acceptance and removed after the preview is retired.

4. Vercel variable allowlist: `REDIS_URL` and all six S3 variables; no OpenAI key.
5. Railway variable allowlist: `DATABASE_URL`, `REDIS_URL`, all six S3 variables, `AI_PROVIDER`, `OPENAI_API_KEY`, and `OPENAI_LISTING_MODEL`; no admin database URL, auth mail variables, or SHOPLINE secrets.
6. Deployment-specific log checks for `listing.enqueue_accepted`, Railway startup, job consumption, terminal safe codes, and secret absence.
7. Rollback: roll back Vercel, roll back/stop Railway, retain Redis queue and Neon records, and never delete the R2 bucket during incident response.
8. Official references:
   - `https://upstash.com/docs/redis/integrations/bullmq`
   - `https://upstash.com/pricing/redis`
   - `https://developers.cloudflare.com/r2/api/s3/presigned-urls/`
   - `https://developers.cloudflare.com/r2/buckets/cors/`
   - `https://docs.railway.com/config-as-code/reference`
   - `https://docs.railway.com/deployments/monorepo`
   - `https://vercel.com/docs/cli/env`

- [ ] **Step 7: Verify docs and config**

Run: `node --test tests/ci-workflow.test.mjs tests/railway-config.test.mjs; pnpm.cmd --filter @wukong/worker build`

Run: `rg -n "OPENAI_API_KEY|DATABASE_ADMIN_URL|AUTH_SMTP_URL|SHOPLINE" docs/runbooks/production-ai-runtime.md .env.example railway.json`

Expected: tests and build PASS; every secret name appears only in an allowlist/denylist or empty template, with no value.

- [ ] **Step 8: Commit deploy configuration and runbook**

```powershell
git add railway.json tests/railway-config.test.mjs apps/worker/package.json package.json .env.example docs/runbooks/production-ai-runtime.md docs/runbooks/production-readiness.md
git commit -m "ops: define production listing worker"
```

### Task 6: Run the Complete Local and CI Gate

**Files:**
- Modify only when a failure is caused by Tasks 1-5; preserve unrelated working-tree files.

**Interfaces:**
- Consumes: every deliverable from Tasks 1-5.
- Produces: a clean, reproducible commit range ready for managed preview infrastructure.

- [ ] **Step 1: Start service dependencies and apply migrations**

Use the existing local-development runbook to start Postgres on 54329 and Redis on 6389.

Run: `pnpm.cmd --filter @wukong/db build; pnpm.cmd --filter @wukong/db db:migrate`

Expected: migrations complete with the configured admin/runtime separation.

- [ ] **Step 2: Run formatting and diff checks**

Run: `pnpm.cmd exec prettier --check "packages/jobs/**/*.{ts,json}" "packages/assets/src/s3-runtime-config*.ts" "apps/web/**/*.{ts,tsx,json}" "apps/worker/**/*.{ts,json}" railway.json tests/railway-config.test.mjs docs/runbooks/production-ai-runtime.md .env.example`

Run: `git diff --check`

Expected: PASS. If formatting fails, run the same Prettier command with `--write`, inspect the diff, and rerun `--check`.

- [ ] **Step 3: Run all unit checks**

Run: `pnpm.cmd lint; pnpm.cmd typecheck; pnpm.cmd test`

Expected: all workspace lint, typecheck, Node config tests, and unit tests PASS.

- [ ] **Step 4: Run all service-backed integration tests**

Run: `pnpm.cmd test:integration`

Expected: Postgres and Redis integration suites PASS, including the moved `@wukong/jobs` duplicate-enqueue test.

- [ ] **Step 5: Build the production artifacts**

Run: `pnpm.cmd build`

Expected: all packages, the Next.js production app, and the Railway worker compile successfully on Node 24.

- [ ] **Step 6: Run Playwright with fake external adapters**

Set `PLAYWRIGHT_E2E=1`, `AI_PROVIDER=fake`, and `SHOPLINE_ADAPTER=mock` using the existing test runbook.

Run: `pnpm.cmd test:e2e`

Expected: the Opak intake, generation, review, compliance, approval, CSV, and mock SHOPLINE workflow PASS.

- [ ] **Step 7: Review the final commit range**

Run: `git diff --stat 1c523144..HEAD; git log --oneline --decorate 1c523144..HEAD; git status --short`

Expected: the intended listing workflow, production runtime commits, and design/plan docs are present. Only the four pre-existing unrelated files remain unstaged.

### Task 7: Provision and Verify the Managed Preview Runtime

**Files:**
- No repository file contains credentials or provider-generated secrets.
- Update: deployment handoff notes with non-secret resource IDs, regions, deployment IDs, spend, and verification timestamps.

**Interfaces:**
- Consumes: verified branch, approved provider accounts, Neon preview/runtime URL, and an OpenAI project key entered directly into Railway.
- Produces: isolated R2, Redis, Vercel preview variables, Railway preview worker, and an end-to-end synthetic acceptance result.

- [ ] **Step 1: Reconfirm current prices immediately before creation**

Open the official pricing pages in the authenticated browser and record the displayed prices in the handoff:

- Upstash Fixed 250MB: expected $10/month with no per-command billing.
- Railway Hobby: record the displayed monthly minimum and included usage.
- R2 Standard: expected first 10 GB-month, 1 million Class A, and 10 million Class B operations monthly within the free tier.

Expected: if any price is materially higher than the recorded expectation, stop before creation and report the change.

- [ ] **Step 2: Create private R2 storage**

In Cloudflare R2:

1. Create Standard bucket `wukong-opak-prod-assets` with public access disabled.
2. Apply the runbook CORS policy.
3. Create an Object Read & Write API token scoped only to this bucket.
4. Record the account-scoped S3 endpoint and access key ID; enter the secret key directly into provider environment forms.

Expected: bucket details show private access; `GetBucketCors` returns the intended origins/methods; no token value appears in terminal or chat output.

- [ ] **Step 3: Create the BullMQ Redis database**

In Upstash:

1. Create `wukong-listing-queue-prod` on Fixed 250MB.
2. Select AWS Singapore as the primary region when offered.
3. Require TLS and copy the `rediss://` endpoint directly into Vercel/Railway environment forms.
4. Do not add read regions or Prod Pack for the MVP.

Expected: TLS connection succeeds and the database shows Fixed 250MB with command-count billing disabled.

- [ ] **Step 4: Configure branch-scoped Vercel preview variables**

For Git branch `codex/production-listing-workflow`, add sensitive preview variables `REDIS_URL`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE`. Use `auto` and `false` for the two fixed non-secret values.

Run: `vercel env ls preview codex/production-listing-workflow`

Expected: all seven names are present and values remain hidden; `OPENAI_API_KEY` is absent.

- [ ] **Step 5: Create and configure the private Railway worker**

1. Create Railway project `wukong-ecommerce-os` on Hobby.
2. Add service `listing-worker` from `YNWAforever/wukong-ecommerce-os` and branch `codex/production-listing-workflow`.
3. Keep the repository root as the service root so shared packages and `railway.json` are available.
4. Select Singapore region and one replica.
5. Do not generate a public domain.
6. Set `NIXPACKS_NODE_VERSION=24` only if the deployment log does not select Node 24 from `package.json`.
7. Add exactly the Railway variable allowlist from the runbook, with `AI_PROVIDER=openai` and `OPENAI_LISTING_MODEL=gpt-5.6-terra`.

Expected: deployment details show config sourced from `railway.json`, worker process remains running, and logs contain neither a migration attempt nor a missing-variable error.

- [ ] **Step 6: Deploy the Vercel preview and finish CORS**

Push the verified branch, wait for the PR preview deployment, and record its exact origin. Add that one origin to R2 `AllowedOrigins`, then redeploy the preview if environment variables were added after its first build.

Expected: preview `/signin`, `/register`, `/dashboard`, and `/listings/new` return non-404 responses; R2 preflight from the preview origin permits `PUT` with `Content-Type`.

- [ ] **Step 7: Run a synthetic full preview flow**

Use a non-customer synthetic wine image and notes containing producer, country, region, vintage, grape, volume, ABV, pack quantity, price, and bilingual naming clues.

Verify in order:

1. registration/sign-in;
2. R2 upload and finalize;
3. HTTP 201 creation with `processing.state=queued`;
4. one BullMQ job ID;
5. Railway consumption and OpenAI call;
6. Neon status transition `received -> processing -> in_review`;
7. evidence and AI-run metadata in the live UI;
8. edit, compliance resolution, approval, CSV download;
9. mock SHOPLINE delivery only.

Expected: the workflow completes without a manual database change and without exposing a signed URL or secret in logs.

- [ ] **Step 8: Exercise enqueue-outage recovery**

Temporarily set the branch-scoped Vercel `REDIS_URL` to a non-routable TLS endpoint through the sensitive environment editor, redeploy, create a second synthetic listing, and verify `processing.state=retry_required` while the listing remains `received`. Restore the valid URL, redeploy, click “開始處理 · Start processing,” and verify exactly one job processes.

Expected: uploaded assets are not repeated, the retry endpoint returns 202, and the listing reaches `in_review`.

- [ ] **Step 9: Restore and verify all preview settings**

Confirm the valid Redis URL is restored, remove the temporary bad value, check Vercel and Railway logs for safe structured fields, and retain the exact preview deployment ID and Railway deployment ID in the handoff.

Expected: preview runtime is healthy and no diagnostic output contains a secret or raw model content.

### Task 8: Merge, Deploy Production, and Complete Non-Destructive Opak Acceptance

**Files:**
- No secret-bearing repository changes.
- Update: deployment handoff notes with PR, merge commit, production deployment IDs, resource IDs, spend, timestamps, and unresolved provider/mailbox evidence.

**Interfaces:**
- Consumes: green preview, PR #8 branch, production Neon/auth/Resend settings, and the provisioned managed services.
- Produces: production Vercel app, production Railway worker, verified Opak workflow through CSV, and a hard stop before the first real SHOPLINE write.

- [ ] **Step 1: Push the complete branch and update PR #8**

Run: `git push origin codex/production-listing-workflow`

Expected: remote branch contains every approved commit and PR #8 reports the new head SHA.

- [ ] **Step 2: Wait for all GitHub and Vercel checks**

Inspect PR #8 and require CI build, migrations, lint, typecheck, unit tests, integration tests, Playwright fake AI/mock SHOPLINE, and Vercel preview to pass.

Expected: every required check is green at the same head SHA used in preview acceptance.

- [ ] **Step 3: Merge PR #8 without bypassing checks**

Use the repository's normal merge method and record the merge commit. Do not merge if the accepted preview SHA differs from the PR head.

Expected: `origin/main` contains the accepted commit range and the GitHub PR is closed as merged.

- [ ] **Step 4: Configure production-scoped service variables**

Add the Vercel and Railway production allowlists from the runbook using sensitive inputs. Keep `DATABASE_ADMIN_URL` only in the controlled migration environment, not Railway. Keep `OPENAI_API_KEY` only on Railway.

Expected: provider dashboards show every required name with hidden values and no forbidden cross-runtime variable.

- [ ] **Step 5: Run the controlled production migration command**

Use the approved release environment with both Neon runtime and admin URLs:

Run: `pnpm.cmd --filter @wukong/db build; pnpm.cmd --filter @wukong/db db:migrate`

Expected: migration command succeeds once before the new worker starts; Railway logs never show migration execution.

- [ ] **Step 6: Deploy and verify both production runtimes**

Trigger Vercel production from `main` and Railway production from the same merge commit. Record both deployment IDs.

Expected: Vercel production aliases to `https://wukong-ecommerce-os.vercel.app`; Railway `listing-worker` stays running privately in Singapore; both show the same source commit.

- [ ] **Step 7: Verify Opak authentication and Resend delivery evidence**

Register or sign in as `laichiwillyjp@gmail.com` with email and password. In Resend, inspect the exact authentication email event and record one of Delivered, Bounced, Failed, Suppressed, or no event. If Delivered, confirm mailbox receipt including spam/junk. If another outcome appears, capture its provider reason without exposing the token or message body.

Expected: authentication succeeds and mailbox receipt is confirmed, or the remaining downstream provider/mailbox cause is conclusively evidenced.

- [ ] **Step 8: Run the production Opak listing flow through CSV**

With approved Opak pilot material:

1. upload to R2;
2. create and queue the listing;
3. observe Railway processing;
4. review evidence and bilingual fields;
5. resolve blocking flags;
6. approve;
7. download the validated SHOPLINE CSV.

Expected: persisted production state and deployment-specific logs prove every transition; the CSV uses `SHOPLINE_CSV_SPEC_VERSION=opak-2026-07`.

- [ ] **Step 9: Stop before direct SHOPLINE publication**

Do not press “發布至 SHOPLINE · Publish to SHOPLINE” and do not call the production delivery endpoint with `shopline_api`.

Expected: report the approved listing ID and CSV result, then request separate user confirmation for the first real SHOPLINE product write.

- [ ] **Step 10: Deliver the production handoff**

Report:

- GitHub PR and merge commit;
- Vercel and Railway production deployment IDs;
- non-secret R2, Upstash, and Railway resource names/regions;
- current monthly committed spend and free-tier assumptions;
- authentication/Resend outcome;
- Opak listing ID and CSV validation result;
- rollback points;
- the explicit SHOPLINE-write hold.

Expected: the MVP is production-usable through CSV with a clearly isolated remaining approval for the first real SHOPLINE write.
