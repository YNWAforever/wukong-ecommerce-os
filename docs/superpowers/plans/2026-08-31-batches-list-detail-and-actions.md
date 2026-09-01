# Attended Batches — List, Detail, Create, Advance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/batches` a real list/detail UI backed by two new `GET` routes, add create-batch and advance-batch actions to that UI, and enforce the 1–5 wave-size cap that §7 G12 of the master plan calls for but neither the route nor the service currently enforces.

**Architecture:** `enrichment_batches`/`enrichment_batch_items` and the `createBatch`/`advanceBatch` service functions already exist and work — this plan adds two read paths (repository → service → route) following those files' own established shape, plus a `/batches` page and a `/batches/[id]` page built from thin client components mirroring `bulk-import-panel.tsx`'s pure-logic-plus-component split.

**Tech Stack:** Drizzle ORM, Next.js App Router route handlers, Vitest, plain CSS (no new tokens).

---

## Environment note for every `Run:` step

`pnpm` is not on a normal PATH in this environment. Prefix every command with:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
```

The integration test in Task 2 needs live Postgres (`docker compose up -d postgres`). If unavailable, say so explicitly and move on rather than silently skipping it.

---

### Task 1: Enforce the 1–5 wave-size cap (§7 G12)

**Files:**

- Modify: `apps/web/app/api/enrichment-batches/route.ts`
- Modify: `apps/web/app/api/enrichment-batches/route.test.ts`
- Modify: `apps/web/lib/enrichment-batch-service.ts`
- Modify: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/web/app/api/enrichment-batches/route.test.ts`, add after the `"rejects an unknown gap"` test:

```ts
it("rejects a wave size above the 1-5 cap", async () => {
  const response = await handlerFor("operator")(
    post({ ...validBody, waveSize: 6 }),
  );

  expect(response.status).toBe(400);
});
```

In `apps/web/lib/enrichment-batch-service.test.ts`, add after `"refuses a wave size that is not a positive whole number"`:

```ts
it("refuses a wave size above the 1-5 cap", async () => {
  const { service, recorded } = serviceWith();

  await expect(
    service.createBatch({
      workspaceId: "ws_opak",
      actorId: "user_1",
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 5,
      waveSize: 6,
    }),
  ).rejects.toThrow(/wave size/i);
  expect(recorded.created).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- enrichment-batch-service.test.ts route.test.ts
```

Expected: FAIL — both currently accept `waveSize: 6`.

- [ ] **Step 3: Implement the fix**

In `apps/web/app/api/enrichment-batches/route.ts`, change:

```ts
    waveSize: z.number().int().min(1).max(500),
```

to:

```ts
    waveSize: z.number().int().min(1).max(5),
```

In `apps/web/lib/enrichment-batch-service.ts`, change:

```ts
if (!Number.isInteger(input.waveSize) || input.waveSize < 1) {
  throw new ApiError(
    400,
    "invalid_wave_size",
    "Wave size must be a positive whole number.",
  );
}
```

to:

```ts
if (
  !Number.isInteger(input.waveSize) ||
  input.waveSize < 1 ||
  input.waveSize > 5
) {
  throw new ApiError(
    400,
    "invalid_wave_size",
    "Wave size must be a whole number from 1 to 5.",
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- enrichment-batch-service.test.ts route.test.ts
```

Expected: PASS, all tests. Note the existing test `"creates a batch for an operator"` uses `waveSize: 10` in `validBody` — this must be changed to a value `<= 5` (e.g. `3`) or it will now fail; check every existing literal in both test files with a `waveSize` above 5 and lower it to a valid value, preserving each test's original intent.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/enrichment-batches/route.ts apps/web/app/api/enrichment-batches/route.test.ts apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "fix: enforce the 1-5 attended-batch wave-size cap"
```

---

### Task 2: Repository — `createdAt` and `listForWorkspace`

**Files:**

- Modify: `packages/db/src/repositories/enrichment-batches.ts`
- Modify: `packages/db/src/repositories/enrichment-batches.integration.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/db/src/repositories/enrichment-batches.integration.test.ts`, add after the `"never exposes a batch to another workspace"` test:

```ts
it("lists every batch for the workspace, newest first, and none from another", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const first = await repositories.enrichmentBatches.create({
      label: "first",
      budgetUsd: 1,
      waveSize: 1,
      createdBy: "operator@example.com",
      listingIds: [],
    });
    const second = await repositories.enrichmentBatches.create({
      label: "second",
      budgetUsd: 1,
      waveSize: 1,
      createdBy: "operator@example.com",
      listingIds: [],
    });

    const listed = await repositories.enrichmentBatches.listForWorkspace();
    const ids = listed.map((batch) => batch.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(
      listed.find((batch) => batch.id === first.id)?.createdAt,
    ).toBeInstanceOf(Date);
  });

  await database.forWorkspace(otherWorkspaceId, async (repositories) => {
    expect(await repositories.enrichmentBatches.listForWorkspace()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
docker compose up -d postgres
pnpm test:integration -- enrichment-batches.integration.test.ts
```

Expected: FAIL — `listForWorkspace` does not exist.

- [ ] **Step 3: Implement it**

In `packages/db/src/repositories/enrichment-batches.ts`:

Add `createdAt: Date;` to `EnrichmentBatch` (after `createdBy: string;`):

```ts
export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  createdBy: string;
  createdAt: Date;
};
```

Add `createdAt: enrichmentBatches.createdAt,` to `COLUMNS` (after `createdBy: enrichmentBatches.createdBy,`).

Add `listForWorkspace(): Promise<EnrichmentBatch[]>;` to `EnrichmentBatchRepository` (after the `create`/before `getById`, or wherever reads are grouped — place it directly after `getById`).

In the function body (find `createEnrichmentBatchRepository`'s returned object, alongside `create`/`getById`), add:

```ts
    async listForWorkspace() {
      scope.assertOpen();
      const rows = await transaction
        .select(COLUMNS)
        .from(enrichmentBatches)
        .where(eq(enrichmentBatches.workspaceId, workspaceId))
        .orderBy(desc(enrichmentBatches.createdAt));
      return rows.map(toEnrichmentBatch);
    },
```

This needs `desc` added to the existing `import { and, asc, eq, inArray, sql } from "drizzle-orm";` line — change it to `import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";`. Read the actual current file first to confirm `workspaceId`/`scope`/`transaction` are the exact parameter names this factory function uses (matching every other method already in this file) before writing this addition — the existing `getById`/`create` methods show the exact pattern to copy.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test:integration -- enrichment-batches.integration.test.ts
```

Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/enrichment-batches.ts packages/db/src/repositories/enrichment-batches.integration.test.ts
git commit -m "feat: add createdAt and a workspace-scoped batch listing to the repository"
```

---

### Task 3: Service — `listBatches` and `getBatch`

**Files:**

- Modify: `apps/web/lib/enrichment-batch-service.ts`
- Modify: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/enrichment-batch-service.test.ts`, after the `describe("enrichment batch creation", ...)` block's closing `});` (as new top-level `describe` blocks):

```ts
describe("enrichment batch listing", () => {
  it("returns every batch the repository lists", async () => {
    const batches = [
      {
        id: "batch_1",
        label: "first",
        budgetUsd: 5,
        waveSize: 2,
        status: "open" as const,
        createdBy: "user_1",
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async listForWorkspace() {
                  return batches;
                },
              },
            });
          },
        }) as never,
      publisher: {
        async enqueue() {
          return { id: "job_1" };
        },
      },
    });

    const result = await service.listBatches({ workspaceId: "ws_opak" });
    expect(result).toEqual(batches);
  });
});

describe("enrichment batch detail", () => {
  it("returns a batch with its item status counts", async () => {
    const counts = {
      pending: 1,
      queued: 0,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    };
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async getById(id: string) {
                  return {
                    id,
                    label: "detail test",
                    budgetUsd: 5,
                    waveSize: 2,
                    status: "running",
                    createdBy: "user_1",
                    createdAt: new Date("2026-08-01T00:00:00Z"),
                  };
                },
                async countByStatus() {
                  return counts;
                },
              },
            });
          },
        }) as never,
      publisher: {
        async enqueue() {
          return { id: "job_1" };
        },
      },
    });

    const result = await service.getBatch({
      workspaceId: "ws_opak",
      batchId: "batch_1",
    });
    expect(result.batch.id).toBe("batch_1");
    expect(result.counts).toEqual(counts);
  });

  it("rejects an unknown batch", async () => {
    const service = createEnrichmentBatchService({
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              enrichmentBatches: {
                async getById() {
                  return null;
                },
              },
            });
          },
        }) as never,
      publisher: {
        async enqueue() {
          return { id: "job_1" };
        },
      },
    });

    await expect(
      service.getBatch({ workspaceId: "ws_opak", batchId: "missing" }),
    ).rejects.toThrow(/no such enrichment batch/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- enrichment-batch-service.test.ts
```

Expected: FAIL — `listBatches`/`getBatch` don't exist.

- [ ] **Step 3: Implement it**

In `apps/web/lib/enrichment-batch-service.ts`, add these types near the existing `AdvanceBatchInput`/`AdvanceBatchResult`:

```ts
export type ListBatchesInput = { workspaceId: string };

export type GetBatchInput = { workspaceId: string; batchId: string };

export type GetBatchResult = {
  batch: EnrichmentBatch;
  counts: EnrichmentBatchCounts;
};
```

This needs `EnrichmentBatch` and `EnrichmentBatchCounts` imported from `@wukong/db` — add them to the existing `import type { Database, PlatformProduct } from "@wukong/db";` line:

```ts
import type {
  Database,
  EnrichmentBatch,
  EnrichmentBatchCounts,
  PlatformProduct,
} from "@wukong/db";
```

Add these two functions inside `createEnrichmentBatchService`, alongside `createBatch`/`advanceBatch`, and add them to the final `return { createBatch, advanceBatch };` statement:

```ts
async function listBatches(
  input: ListBatchesInput,
): Promise<EnrichmentBatch[]> {
  return deps
    .getDatabase()
    .forWorkspace(input.workspaceId, (repositories) =>
      repositories.enrichmentBatches.listForWorkspace(),
    );
}

async function getBatch(input: GetBatchInput): Promise<GetBatchResult> {
  return deps
    .getDatabase()
    .forWorkspace(input.workspaceId, async (repositories) => {
      const batch = await repositories.enrichmentBatches.getById(input.batchId);
      if (!batch) {
        throw new ApiError(404, "batch_not_found", "No such enrichment batch.");
      }
      const counts = await repositories.enrichmentBatches.countByStatus(
        input.batchId,
      );
      return { batch, counts };
    });
}
```

```ts
return { createBatch, advanceBatch, listBatches, getBatch };
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- enrichment-batch-service.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "feat: add listBatches and getBatch to the enrichment batch service"
```

---

### Task 4: `GET /api/enrichment-batches` (list route)

**Files:**

- Modify: `apps/web/app/api/enrichment-batches/route.ts`
- Modify: `apps/web/app/api/enrichment-batches/route.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/web/app/api/enrichment-batches/route.test.ts`, change `handlerFor` to also accept a `listBatches` override, and add a new `describe` block:

```ts
function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  createBatch = async () => okResult,
  listBatches: () => Promise<unknown[]> = async () => [],
) {
  return createEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    createBatch,
    listBatches,
  });
}
```

```ts
const get = () =>
  new Request("http://localhost/api/enrichment-batches", { method: "GET" });

describe("GET /api/enrichment-batches", () => {
  it("lists batches for an operator", async () => {
    const batch = {
      id: "batch_1",
      label: "zh names",
      budgetUsd: 5,
      waveSize: 3,
      status: "open",
      createdBy: "user_1",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    const response = await handlerFor("operator", undefined, async () => [
      batch,
    ])(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      batches: [{ ...batch, createdAt: batch.createdAt.toISOString() }],
    });
  });

  it("refuses a viewer", async () => {
    const response = await handlerFor("viewer")(get());
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- apps/web/app/api/enrichment-batches/route.test.ts
```

Expected: FAIL — `createEnrichmentBatchHandler` doesn't handle GET yet and its deps type has no `listBatches`.

- [ ] **Step 3: Implement it**

In `apps/web/app/api/enrichment-batches/route.ts`, add `EnrichmentBatch` to the existing named import from `"../../../lib/enrichment-batch-service"`:

```ts
import {
  createEnrichmentBatchService,
  type CreateBatchInput,
  type CreateBatchResult,
  type EnrichmentBatch,
} from "../../../lib/enrichment-batch-service";
```

Extend `EnrichmentBatchRouteDeps`:

```ts
export type EnrichmentBatchRouteDeps = {
  sessionContext: SessionContextPort;
  createBatch(input: CreateBatchInput): Promise<CreateBatchResult>;
  listBatches(input: { workspaceId: string }): Promise<EnrichmentBatch[]>;
};
```

Add a new exported handler factory in the same file, alongside `createEnrichmentBatchHandler`:

```ts
export function createListEnrichmentBatchesHandler(
  deps: EnrichmentBatchRouteDeps,
) {
  return async function listEnrichmentBatches(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const batches = await deps.listBatches({
        workspaceId: context.workspaceId,
      });

      return jsonResponse(200, {
        batches: batches.map((batch) => ({
          ...batch,
          createdAt: batch.createdAt.toISOString(),
        })),
      });
    });
  };
}
```

Change the production wiring at the bottom of the file:

```ts
const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const POST = createEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  createBatch: service.createBatch,
  listBatches: service.listBatches,
});

export const GET = createListEnrichmentBatchesHandler({
  sessionContext: authSessionContext,
  createBatch: service.createBatch,
  listBatches: service.listBatches,
});
```

Note both `POST` and `GET` now need the full `EnrichmentBatchRouteDeps` shape (both `createBatch` and `listBatches`), since the type is shared — this matches how `BulkFormImportRouteDeps` already bundles more than one route's worth of deps in a single type elsewhere in this codebase, so it is an intentional, consistent choice, not an oversight. Update `handlerFor` in the test file (already done in Step 1) to always pass both.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- apps/web/app/api/enrichment-batches/route.test.ts
```

Expected: PASS, all tests including the new `GET` ones.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/enrichment-batches/route.ts apps/web/app/api/enrichment-batches/route.test.ts
git commit -m "feat: add GET /api/enrichment-batches to list a workspace's batches"
```

---

### Task 5: `GET /api/enrichment-batches/[id]` (detail route)

**Files:**

- Create: `apps/web/app/api/enrichment-batches/[id]/route.ts`
- Create: `apps/web/app/api/enrichment-batches/[id]/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/api/enrichment-batches/[id]/route.test.ts`, mirroring `[id]/advance/route.test.ts`'s exact structure:

```ts
import { describe, expect, it } from "vitest";

import { ApiError } from "../../../../lib/route-support";
import { createGetEnrichmentBatchHandler } from "./route.js";

const okBatch = {
  id: "batch_1",
  label: "zh names",
  budgetUsd: 5,
  waveSize: 3,
  status: "running" as const,
  createdBy: "user_1",
  createdAt: new Date("2026-08-01T00:00:00Z"),
};
const okCounts = {
  pending: 1,
  queued: 0,
  succeeded: 2,
  failed: 0,
  skipped: 0,
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  getBatch: () => Promise<{
    batch: typeof okBatch;
    counts: typeof okCounts;
  }> = async () => ({
    batch: okBatch,
    counts: okCounts,
  }),
) {
  return createGetEnrichmentBatchHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    getBatch,
  });
}

const request = new Request("http://localhost/api/enrichment-batches/batch_1", {
  method: "GET",
});
const context = { params: Promise.resolve({ id: "batch_1" }) };

describe("GET /api/enrichment-batches/[id]", () => {
  it("returns the batch and its counts for an operator", async () => {
    const response = await handlerFor("operator")(request, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      batch: { ...okBatch, createdAt: okBatch.createdAt.toISOString() },
      counts: okCounts,
    });
  });

  it("refuses a viewer", async () => {
    const response = await handlerFor("viewer")(request, context);
    expect(response.status).toBe(403);
  });

  it("reports a missing batch as 404", async () => {
    const handler = handlerFor("operator", async () => {
      throw new ApiError(404, "batch_not_found", "No such enrichment batch.");
    });

    const response = await handler(request, context);
    expect(response.status).toBe(404);
  });
});
```

Before writing this, read `apps/web/lib/route-support.ts` to confirm `ApiError`'s real constructor signature/export path, and read `[id]/advance/route.ts` to confirm the exact relative import depth (`../../../../lib/...`) — both files already establish the pattern this test copies.

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- apps/web/app/api/enrichment-batches/[id]/route.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/app/api/enrichment-batches/[id]/route.ts`, mirroring `[id]/advance/route.ts`'s exact structure:

```ts
import {
  createEnrichmentBatchService,
  type GetBatchInput,
  type GetBatchResult,
} from "../../../../lib/enrichment-batch-service";
import { getDatabase } from "../../../../lib/intake-runtime";
import { listingPublisher } from "../../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

export type GetEnrichmentBatchRouteDeps = {
  sessionContext: SessionContextPort;
  getBatch(input: GetBatchInput): Promise<GetBatchResult>;
};

type RouteContext = { params: Promise<{ id: string }> };

export function createGetEnrichmentBatchHandler(
  deps: GetEnrichmentBatchRouteDeps,
) {
  return async function getEnrichmentBatch(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const { id } = await context.params;
      const { batch, counts } = await deps.getBatch({
        workspaceId: session.workspaceId,
        batchId: id,
      });

      return jsonResponse(200, {
        batch: { ...batch, createdAt: batch.createdAt.toISOString() },
        counts,
      });
    });
  };
}

const service = createEnrichmentBatchService({
  getDatabase,
  publisher: listingPublisher,
});

export const GET = createGetEnrichmentBatchHandler({
  sessionContext: authSessionContext,
  getBatch: service.getBatch,
});
```

Read the real `route-support.ts` and `[id]/advance/route.ts` files first to fix the exact import list/order/paths above if they differ from this sketch — don't leave an import out of the order/grouping every other route file in this codebase already uses.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- apps/web/app/api/enrichment-batches/[id]/route.test.ts
```

Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/enrichment-batches/[id]/route.ts apps/web/app/api/enrichment-batches/[id]/route.test.ts
git commit -m "feat: add GET /api/enrichment-batches/[id] for a single batch's detail"
```

---

### Task 6: Batch status pill CSS

**Files:**

- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add the shared pill class**

In `apps/web/app/globals.css`, find the existing shared-pill selector:

```css
.review-status,
.connection-status {
```

Change it to include the new class:

```css
.review-status,
.connection-status,
.batch-status {
```

No other CSS is needed — `.status-neutral`/`.status-success`/`.status-danger` (already defined a few lines below, at the `.connection-status { border-radius: 8px; }` section) are generic modifiers this component will combine with `.batch-status`.

- [ ] **Step 2: Verify format/typecheck are unaffected**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm format:runtime:check
```

Expected: PASS (or run the format-write step if it flags this file, then re-check).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "style: add a shared batch-status pill class"
```

---

### Task 7: `create-batch-form.tsx`

**Files:**

- Create: `apps/web/components/create-batch-form.tsx`
- Create: `apps/web/components/create-batch-form.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/create-batch-form.test.ts`, mirroring `bulk-import-panel.test.ts`'s structure (pure-logic tests first, no DOM):

```ts
import { describe, expect, it, vi } from "vitest";

import { submitCreateBatch } from "./create-batch-form.js";

const validInput = {
  label: "zh names",
  gap: "untranslatedName" as const,
  budgetUsd: 5,
  waveSize: 3,
};

describe("submitCreateBatch", () => {
  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { batchId: "batch_1", selected: 4, budgetUsd: 5, waveSize: 3 },
          { status: 201 },
        ),
      );

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({
      kind: "success",
      batchId: "batch_1",
      selected: 4,
      budgetUsd: 5,
      waveSize: 3,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["invalid_budget", "A batch needs a budget greater than zero."],
    ["invalid_wave_size", "Wave size must be a whole number from 1 to 5."],
    [
      "empty_cohort",
      "No products match that gap, so there is nothing to enrich.",
    ],
    ["insufficient_role", "Operator access is required."],
  ])("maps API error code %s to its message", async (code, message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status: 400 }),
      );

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({ kind: "api_error", code, message });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- create-batch-form.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/components/create-batch-form.tsx`, mirroring `bulk-import-panel.tsx`'s pure-logic-plus-component split:

```tsx
"use client";

import { useState } from "react";

export type EnrichmentGap =
  | "untranslatedName"
  | "untranslatedSeoTitle"
  | "seoTitleMirrorsName"
  | "seoDescriptionMirrorsSeoTitle"
  | "keywordsMirrorName"
  | "summaryMissing";

const GAP_LABELS: Record<EnrichmentGap, string> = {
  untranslatedName: "商品名稱缺少中文翻譯",
  untranslatedSeoTitle: "SEO 標題缺少中文翻譯",
  seoTitleMirrorsName: "SEO 標題與商品名稱相同",
  seoDescriptionMirrorsSeoTitle: "SEO 描述與 SEO 標題相同",
  keywordsMirrorName: "關鍵字與商品名稱相同",
  summaryMissing: "缺少商品摘要",
};

export type CreateBatchFormInput = {
  label: string;
  gap: EnrichmentGap;
  budgetUsd: number;
  waveSize: number;
};

export type CreateBatchSuccess = {
  kind: "success";
  batchId: string;
  selected: number;
  budgetUsd: number;
  waveSize: number;
};

export type CreateBatchFailure =
  | { kind: "validation_error"; message: string }
  | { kind: "api_error"; code: string; message: string }
  | { kind: "network_error"; message: string };

export type CreateBatchOutcome = CreateBatchSuccess | CreateBatchFailure;

export type CreateBatchDeps = { fetcher: typeof fetch };

const API_ERROR_MESSAGES: Record<string, string> = {
  invalid_budget: "A batch needs a budget greater than zero.",
  invalid_wave_size: "Wave size must be a whole number from 1 to 5.",
  empty_cohort: "No products match that gap, so there is nothing to enrich.",
  insufficient_role: "Operator access is required.",
};

export async function submitCreateBatch(
  input: CreateBatchFormInput,
  deps: CreateBatchDeps = { fetcher: fetch },
): Promise<CreateBatchOutcome> {
  let response: Response;
  try {
    response = await deps.fetcher("/api/enrichment-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    const message =
      API_ERROR_MESSAGES[code] ??
      (typeof body.message === "string"
        ? body.message
        : "The batch could not be created.");
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    batchId: body.batchId as string,
    selected: body.selected as number,
    budgetUsd: body.budgetUsd as number,
    waveSize: body.waveSize as number,
  };
}

export function CreateBatchForm({ onCreated }: { onCreated?: () => void }) {
  const [label, setLabel] = useState("");
  const [gap, setGap] = useState<EnrichmentGap>("untranslatedName");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [waveSize, setWaveSize] = useState("3");
  const [outcome, setOutcome] = useState<CreateBatchOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    const result = await submitCreateBatch({
      label,
      gap,
      budgetUsd: Number(budgetUsd),
      waveSize: Number(waveSize),
    });
    setOutcome(result);
    setBusy(false);
    if (result.kind === "success") {
      onCreated?.();
    }
  }

  return (
    <form className="intake-form" onSubmit={handleSubmit}>
      <label>
        名稱 <span>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
        />
      </label>
      <label>
        缺口類型 <span>Gap</span>
        <select
          value={gap}
          onChange={(e) => setGap(e.target.value as EnrichmentGap)}
        >
          {Object.entries(GAP_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label>
        預算 (USD) <span>Budget</span>
        <input
          type="number"
          step="0.01"
          value={budgetUsd}
          onChange={(e) => setBudgetUsd(e.target.value)}
          required
        />
      </label>
      <label>
        每波數量 (1-5) <span>Wave size</span>
        <input
          type="number"
          min={1}
          max={5}
          value={waveSize}
          onChange={(e) => setWaveSize(e.target.value)}
          required
        />
      </label>
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "建立中…" : "建立批次"} <span>Create batch</span>
      </button>
      {outcome && outcome.kind !== "success" ? (
        <p className="intake-message" role="status" aria-live="polite">
          {outcome.message}
        </p>
      ) : null}
    </form>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- create-batch-form.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/create-batch-form.tsx apps/web/components/create-batch-form.test.ts
git commit -m "feat: add the create-batch form component"
```

---

### Task 8: `advance-batch-button.tsx`

**Files:**

- Create: `apps/web/components/advance-batch-button.tsx`
- Create: `apps/web/components/advance-batch-button.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/advance-batch-button.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { submitAdvanceBatch } from "./advance-batch-button.js";

describe("submitAdvanceBatch", () => {
  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          batchId: "batch_1",
          status: "running",
          enqueued: 2,
          spentUsd: 1,
          budgetUsd: 5,
        },
        { status: 200 },
      ),
    );

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({
      kind: "success",
      batchId: "batch_1",
      status: "running",
      enqueued: 2,
      spentUsd: 1,
      budgetUsd: 5,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches/batch_1/advance",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps a 403 to its message", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "insufficient_role", message: "server detail" },
          { status: 403 },
        ),
      );

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({
      kind: "api_error",
      code: "insufficient_role",
      message: "Operator access is required.",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- advance-batch-button.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/components/advance-batch-button.tsx`:

```tsx
"use client";

import { useState } from "react";

export type AdvanceBatchSuccess = {
  kind: "success";
  batchId: string;
  status: "running" | "completed" | "budget_exhausted";
  enqueued: number;
  spentUsd: number;
  budgetUsd: number;
};

export type AdvanceBatchFailure =
  | { kind: "api_error"; code: string; message: string }
  | { kind: "network_error"; message: string };

export type AdvanceBatchOutcome = AdvanceBatchSuccess | AdvanceBatchFailure;

export type AdvanceBatchDeps = { fetcher: typeof fetch };

const API_ERROR_MESSAGES: Record<string, string> = {
  insufficient_role: "Operator access is required.",
  batch_not_found: "This batch no longer exists.",
};

export async function submitAdvanceBatch(
  batchId: string,
  deps: AdvanceBatchDeps = { fetcher: fetch },
): Promise<AdvanceBatchOutcome> {
  let response: Response;
  try {
    response = await deps.fetcher(
      `/api/enrichment-batches/${batchId}/advance`,
      { method: "POST" },
    );
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    const message =
      API_ERROR_MESSAGES[code] ??
      (typeof body.message === "string"
        ? body.message
        : "The batch could not be advanced.");
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    batchId: body.batchId as string,
    status: body.status as AdvanceBatchSuccess["status"],
    enqueued: body.enqueued as number,
    spentUsd: body.spentUsd as number,
    budgetUsd: body.budgetUsd as number,
  };
}

export function AdvanceBatchButton({
  batchId,
  onAdvanced,
}: {
  batchId: string;
  onAdvanced?: (outcome: AdvanceBatchOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setMessage(null);
    const result = await submitAdvanceBatch(batchId);
    if (result.kind !== "success") {
      setMessage(result.message);
    }
    setBusy(false);
    onAdvanced?.(result);
  }

  return (
    <div>
      <button
        type="button"
        className="primary-button"
        disabled={busy}
        onClick={handleClick}
      >
        {busy ? "推進中…" : "推進下一波"} <span>Advance</span>
      </button>
      {message ? (
        <p className="intake-message" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- advance-batch-button.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/advance-batch-button.tsx apps/web/components/advance-batch-button.test.ts
git commit -m "feat: add the advance-batch button component"
```

---

### Task 9: Batch list page

**Files:**

- Create: `apps/web/components/batch-list.tsx`
- Create: `apps/web/components/batch-list.test.tsx`
- Create: `apps/web/app/(app)/batches/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/components/batch-list.test.tsx`, following `bulk-import-panel.test.ts`'s DOM-mount convention (this fetches on mount, so a static `renderToStaticMarkup` check is not enough — use the manual `createRoot`/`act` pattern):

```tsx
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BatchList } from "./batch-list.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BatchList", () => {
  it("renders each batch's label and status after fetching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batches: [
          {
            id: "batch_1",
            label: "zh names",
            budgetUsd: 5,
            waveSize: 3,
            status: "running",
            createdBy: "user_1",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(BatchList));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("zh names");
    expect(fetcher).toHaveBeenCalledWith("/api/enrichment-batches");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- batch-list.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/components/batch-list.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type BatchSummary = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: "open" | "running" | "completed" | "budget_exhausted" | "cancelled";
  createdBy: string;
  createdAt: string;
};

const STATUS_TONE: Record<
  BatchSummary["status"],
  "status-neutral" | "status-success" | "status-danger"
> = {
  open: "status-neutral",
  running: "status-neutral",
  completed: "status-success",
  budget_exhausted: "status-danger",
  cancelled: "status-danger",
};

export function BatchList() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/enrichment-batches")
      .then((response) => response.json())
      .then((body: { batches: BatchSummary[] }) => {
        if (!cancelled) setBatches(body.batches);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (batches === null) {
    return <p className="intake-message">載入中…</p>;
  }
  if (batches.length === 0) {
    return <p className="intake-message">尚無批次紀錄。</p>;
  }

  return (
    <ul className="file-list">
      {batches.map((batch) => (
        <li key={batch.id}>
          <Link href={`/batches/${batch.id}`}>{batch.label}</Link>{" "}
          <span className={`batch-status ${STATUS_TONE[batch.status]}`}>
            <span />
            {batch.status}
          </span>{" "}
          · 每波 {batch.waveSize} · 預算 ${batch.budgetUsd}
        </li>
      ))}
    </ul>
  );
}
```

Create `apps/web/app/(app)/batches/page.tsx`, mirroring `apps/web/app/(app)/catalog/page.tsx`'s shell:

```tsx
import { BatchList } from "../../../components/batch-list";
import { CreateBatchForm } from "../../../components/create-batch-form";

export default function BatchesPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            Attended batches <span>ENRICHMENT WORKFLOW</span>
          </p>
          <h1>批次進度與新批次建立</h1>
          <p className="lede">
            查看現有批次的進度與花費，或針對特定內容缺口建立新的批次。
          </p>
        </div>
      </div>
      <CreateBatchForm />
      <BatchList />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- batch-list.test.tsx
pnpm --filter @wukong/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/batch-list.tsx apps/web/components/batch-list.test.tsx "apps/web/app/(app)/batches/page.tsx"
git commit -m "feat: add the /batches list page"
```

---

### Task 10: Batch detail page and nav link

**Files:**

- Create: `apps/web/components/batch-detail.tsx`
- Create: `apps/web/components/batch-detail.test.tsx`
- Create: `apps/web/app/(app)/batches/[id]/page.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/components/batch-detail.test.tsx`, same DOM-mount convention as Task 9's test:

```tsx
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BatchDetail } from "./batch-detail.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("BatchDetail", () => {
  it("renders the batch's status and item counts after fetching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batch: {
          id: "batch_1",
          label: "zh names",
          budgetUsd: 5,
          waveSize: 3,
          status: "running",
          createdBy: "user_1",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        counts: { pending: 1, queued: 0, succeeded: 2, failed: 0, skipped: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(BatchDetail, { batchId: "batch_1" }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("zh names");
    expect(container.textContent).toContain("succeeded");
    expect(fetcher).toHaveBeenCalledWith("/api/enrichment-batches/batch_1");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- batch-detail.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/components/batch-detail.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

import { AdvanceBatchButton } from "./advance-batch-button";

type BatchDetailData = {
  batch: {
    id: string;
    label: string;
    budgetUsd: number;
    waveSize: number;
    status: string;
    createdBy: string;
    createdAt: string;
  };
  counts: {
    pending: number;
    queued: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
};

export function BatchDetail({ batchId }: { batchId: string }) {
  const [data, setData] = useState<BatchDetailData | null>(null);

  const reload = useCallback(() => {
    fetch(`/api/enrichment-batches/${batchId}`)
      .then((response) => response.json())
      .then((body: BatchDetailData) => setData(body));
  }, [batchId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (data === null) {
    return <p className="intake-message">載入中…</p>;
  }

  return (
    <div>
      <h2>{data.batch.label}</h2>
      <p>
        狀態: {data.batch.status} · 每波 {data.batch.waveSize} · 預算 $
        {data.batch.budgetUsd}
      </p>
      <ul className="file-list">
        <li>pending: {data.counts.pending}</li>
        <li>queued: {data.counts.queued}</li>
        <li>succeeded: {data.counts.succeeded}</li>
        <li>failed: {data.counts.failed}</li>
        <li>skipped: {data.counts.skipped}</li>
      </ul>
      <AdvanceBatchButton batchId={batchId} onAdvanced={reload} />
    </div>
  );
}
```

Create `apps/web/app/(app)/batches/[id]/page.tsx`:

```tsx
import Link from "next/link";

import { BatchDetail } from "../../../../components/batch-detail";

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="page-wrap narrow-page">
      <div className="breadcrumb">
        <Link href="/batches">批次</Link>
        <span aria-hidden="true">/</span>
        <span>{id}</span>
      </div>
      <BatchDetail batchId={id} />
    </div>
  );
}
```

In `apps/web/app/(app)/layout.tsx`, add one nav link after the existing `/listings/import` link:

```tsx
<Link href="/batches">
  批次 <span>Batches</span>
</Link>
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- batch-detail.test.tsx
pnpm --filter @wukong/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/batch-detail.tsx apps/web/components/batch-detail.test.tsx "apps/web/app/(app)/batches/[id]/page.tsx" "apps/web/app/(app)/layout.tsx"
git commit -m "feat: add the /batches/[id] detail page and nav link"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm typecheck
```

Expected: PASS across every package.

- [ ] **Step 2: Format check**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm format:runtime:check
```

Expected: PASS, or fix and re-check as in earlier plans this session.

- [ ] **Step 3: Full unit suite**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test
```

Expected: PASS, all packages.

- [ ] **Step 4: Integration suite (requires live Postgres)**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
docker compose up -d postgres
pnpm test:integration
```

Expected: PASS, all packages, including the extended `enrichment-batches.integration.test.ts`. If Postgres is unreachable, state that explicitly rather than reporting this step as passed.

- [ ] **Step 5: `pnpm runtime:forbidden:check`**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm runtime:forbidden:check
```

Expected: PASS.

---

## Self-Review

**Spec coverage:** §2's wave-cap fix → Task 1. §3's `listForWorkspace`/`createdAt` → Task 2. §4's two GET routes → Tasks 3–5. §5's frontend (list/detail pages, create/advance components, status CSS, nav link) → Tasks 6–10.

**Placeholder scan:** none — every step has literal, complete code.

**Type consistency:** `EnrichmentBatch` gains `createdAt: Date` once (Task 2) and every later task's fakes/fixtures use that same shape. `GetBatchInput`/`GetBatchResult`/`ListBatchesInput` (Task 3) are the exact types the routes in Tasks 4–5 import and use. `EnrichmentBatchRouteDeps` (Task 4) intentionally bundles both `createBatch` and `listBatches` since `POST`/`GET` share one deps type in this file, matching the note in Task 4's implementation step.
