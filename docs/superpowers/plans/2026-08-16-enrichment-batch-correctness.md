# Enrichment Batch Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three known correctness gaps in the enrichment batch service so a batch always terminates, always charges the right budget, and cannot be resurrected once finished.

**Architecture:** All three fixes live behind the existing `createEnrichmentBatchService(deps)` factory and the two repositories it already uses. No new tables, no new routes, no schema migration, and no change to the worker pipeline. Two of the fixes replace an implicit list with a construct the type checker enforces, so the same class of gap cannot reopen silently.

**Tech Stack:** TypeScript 7 (5.9 in `apps/web`), Drizzle ORM, Postgres, Vitest, zod v4.

---

## Prerequisites

### Branch

**This work cannot branch off `main`.** Verified on 2026-08-16: `origin/main` contains neither
`apps/web/lib/enrichment-batch-service.ts` nor `packages/db/src/repositories/enrichment-batches.ts`.
Both arrive with PR #33 (`claude/catalog-enrichment-batches`), which is still open.

Branch off the enrichment branch:

```bash
git fetch origin
git checkout -b claude/enrichment-batch-correctness origin/claude/catalog-enrichment-batches
```

If PR #33 has merged by the time you start, branch off `main` instead — nothing else in this plan
changes:

```bash
git fetch origin && git checkout -b claude/enrichment-batch-correctness origin/main
```

### Local services

Tasks 3 and 7 run integration tests, which need Postgres on port 54329 with the `wukong_app` role.
Full setup is in `docs/runbooks/local-development.md`. If `docker compose` is unavailable:

```bash
docker run -d --name wukong-postgres -p 54329:5432 -e POSTGRES_USER=wukong -e POSTGRES_PASSWORD=wukong -e POSTGRES_DB=wukong postgres:17
```

The integration suites create the `wukong_app` role themselves in `beforeAll`.

### Read before starting

- `docs/superpowers/specs/2026-08-16-catalog-enrichment-batches-design.md` — the design these
  fixes patch. Its reconciliation section is the thing that was incomplete.
- `docs/runbooks/shopline-pilot-onboarding.md` §5 — the operator-facing description of the flow.

## The three defects

| # | Defect | Consequence | Task |
|---|--------|-------------|------|
| 1 | `needs_info` and `reopened` appear in neither terminal list | A draft landing there is neither finished nor in flight, so `countByStatus().queued` never reaches 0 and the batch can never report `completed` | 1 |
| 2 | Spend is summed per listing over all time | A draft enriched by an earlier batch carries its old cost into a new batch's budget, so the new batch can report itself exhausted before doing any work | 2, 3, 4 |
| 3 | `advanceBatch` has no status guard | A `cancelled` batch with pending items can be advanced back to `running` and spend its budget | 5 |

**Honest scoping note on defect 3.** There is no cancel route today (`apps/web/app/api/enrichment-batches/`
holds only `route.ts` and `[id]/advance/route.ts`), so `cancelled` is currently unreachable and
`completed` is self-healing — a completed batch has no pending items, so `claimWave` returns `[]`
and the code re-sets `completed` rather than `running`. The guard is therefore **defensive**: it
exists so that the first cancel API is not born broken. Implement it, but do not describe it as a
live bug fix in the commit message.

## Hard constraints

Carried forward from the enrichment design. Violating any of these invalidates the approach:

- **Do not modify** `apps/worker/src/listing-pipeline.ts`, `packages/ai/src/contracts.ts`, or
  `packages/ai/src/prompts.ts`. The whole design rests on reusing them unchanged.
- **Do not add a `batch_id` column to `ai_runs`.** The worker writes that table and knows nothing
  about batches; teaching it would couple the pipeline to the batching feature. Defect 2 is fixed
  with a time bound instead.
- **Audit metadata carries identifiers, counts and money only** — never a product name, SKU, price,
  or draft note. Same for `console.info` logs.
- **Workspace scoping**: every data access stays inside `db.forWorkspace(workspaceId, ...)`, and the
  workspace ID keeps coming from the resolved session, never from request JSON.

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `apps/web/lib/enrichment-batch-service.ts` | Modify | Replace the two status arrays with one exhaustive map; scope spend to the batch window; guard terminal batches |
| `apps/web/lib/enrichment-batch-service.test.ts` | Modify | Unit coverage for all three fixes; helper gains a `status` option |
| `packages/db/src/repositories/ai-runs.ts` | Modify | `sumCostForListings` accepts an optional lower time bound |
| `packages/db/src/repositories/ai-runs.integration.test.ts` | Modify | Prove the bound excludes older runs, using the database clock |
| `packages/db/src/repositories/enrichment-batches.ts` | Modify | `EnrichmentBatch` carries `createdAt`, which is the spend window's start |
| `packages/db/src/repositories/enrichment-batches.integration.test.ts` | Modify | Prove `createdAt` round-trips as a `Date` |
| `docs/runbooks/shopline-pilot-onboarding.md` | Modify | Document how a stalled draft is counted and what the budget window is |

---

### Task 1: A batch reads every listing status

The service classifies a queued draft by its listing status. Today it does so with two `readonly`
arrays and an `includes` test, and two of the ten statuses are in neither array. Replace both arrays
with a single `Record<ListingStatus, ...>`: TypeScript requires every key of a `Record` over a union,
so adding an eleventh listing status will fail `pnpm lint` until someone decides how a batch reads it.

**Files:**

- Modify: `apps/web/lib/enrichment-batch-service.ts:47-61`
- Test: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these three tests inside the existing `describe("enrichment batch advance", ...)` block in
`apps/web/lib/enrichment-batch-service.test.ts`, immediately after the
`"does not complete a batch whose queued drafts are still running"` test:

```ts
  it("counts a draft that stopped for more information as finished, not in flight", async () => {
    const { service, marked } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_stuck"],
      listingStatuses: { draft_stuck: "needs_info" },
      counts: { pending: 0, queued: 0 },
    });

    await service.advanceBatch(advanceInput);

    // It spent budget and produced no listing, so it is a failure for the
    // batch — but above all it must not stay queued forever.
    expect(marked).toContainEqual({
      listingIds: ["draft_stuck"],
      status: "failed",
    });
  });

  it("completes a batch whose last draft stopped for more information", async () => {
    const { service, statuses } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_stuck"],
      listingStatuses: { draft_stuck: "needs_info" },
      counts: { pending: 0, queued: 0 },
    });

    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("completed");
    expect(statuses).toContain("completed");
  });

  it("counts a reopened draft as enriched", async () => {
    const { service, marked } = advanceServiceWith({
      spent: 1,
      budget: 10,
      pending: [],
      queued: ["draft_reopened"],
      listingStatuses: { draft_reopened: "reopened" },
      counts: { pending: 0, queued: 0 },
    });

    await service.advanceBatch(advanceInput);

    // A human approved it and then reopened it. The enrichment run the batch
    // paid for did its job; what happened afterwards is review work.
    expect(marked).toContainEqual({
      listingIds: ["draft_reopened"],
      status: "succeeded",
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run lib/enrichment-batch-service.test.ts
```

Expected: 3 failures. The two `needs_info` tests fail because the draft is classified as neither
succeeded nor failed — `marked` contains two empty-list entries and the batch reports `running`
rather than `completed`. The `reopened` test fails the same way.

- [ ] **Step 3: Replace the two arrays with an exhaustive map**

In `apps/web/lib/enrichment-batch-service.ts`, replace this block:

```ts
/**
 * A queued draft in one of these states has finished its enrichment run. The
 * two lists are disjoint and neither contains `received` or `processing`, so a
 * draft still in flight stays queued and cannot be counted twice.
 */
const SUCCEEDED_STATUSES = [
  "in_review",
  "approved",
  "publishing",
  "published",
] as const;
const FAILED_STATUSES = ["failed", "publish_failed"] as const;

const includes = (statuses: readonly string[], value: string | undefined) =>
  value !== undefined && statuses.includes(value);
```

with:

```ts
/**
 * How a queued draft's listing status resolves for the batch that queued it.
 *
 * `null` means still in flight: the draft stays queued and is reconciled on a
 * later advance. Every other status is terminal for the batch.
 *
 * This is a `Record` over `ListingStatus` rather than a pair of arrays
 * precisely because the arrays could be — and were — incomplete. `needs_info`
 * and `reopened` appeared in neither, so a draft landing there was counted as
 * neither finished nor in flight, and its batch could never reach `completed`.
 * A `Record` over a union requires every key, so an eleventh listing status
 * fails `pnpm lint` until someone decides how a batch reads it.
 */
const BATCH_OUTCOME: Record<ListingStatus, "succeeded" | "failed" | null> = {
  received: null,
  processing: null,
  // The pipeline ran, spent budget, and concluded it cannot produce a listing
  // without more information. Nothing further happens without operator action,
  // so it is finished as far as the batch is concerned — and it produced no
  // enrichment, so it is not a success.
  needs_info: "failed",
  in_review: "succeeded",
  approved: "succeeded",
  // Approved and then reopened by a human. The enrichment run succeeded; the
  // reopen is review work that happens to overlap the batch's lifetime.
  reopened: "succeeded",
  publishing: "succeeded",
  published: "succeeded",
  publish_failed: "failed",
  failed: "failed",
};

const outcomeOf = (status: string | undefined): "succeeded" | "failed" | null =>
  status === undefined ? null : (BATCH_OUTCOME[status as ListingStatus] ?? null);
```

Add the type import at the top of the file, after the existing `@wukong/db` import:

```ts
import type { ListingStatus } from "@wukong/core";
```

- [ ] **Step 4: Use the map in `advanceBatch`**

In `apps/web/lib/enrichment-batch-service.ts`, replace:

```ts
          const succeeded = queued.filter((id) =>
            includes(SUCCEEDED_STATUSES, statuses[id]),
          );
          const failed = queued.filter((id) =>
            includes(FAILED_STATUSES, statuses[id]),
          );
```

with:

```ts
          const succeeded = queued.filter(
            (id) => outcomeOf(statuses[id]) === "succeeded",
          );
          const failed = queued.filter(
            (id) => outcomeOf(statuses[id]) === "failed",
          );
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run lib/enrichment-batch-service.test.ts
```

Expected: PASS, all tests in the file. Do **not** pipe this into `grep`, `head`, or `tail` — the
shell reports the pipe's exit code, which has masked a red suite in this repo before.

- [ ] **Step 6: Typecheck**

```bash
pnpm lint
```

Expected: 14/14 tasks successful. If `@wukong/core` is not already a dependency of `apps/web`, this
step fails on the `ListingStatus` import — it is (`"@wukong/core": "workspace:*"` in
`apps/web/package.json`), so a failure here means something else.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "fix(web): let a stalled draft finish its enrichment batch"
```

---

### Task 2: Observed spend accepts a lower time bound

`sumCostForListings` sums every run a draft ever had. A draft enriched by an earlier batch therefore
arrives in a new batch already carrying spend. Add an optional lower bound; the caller supplies it
in Task 4.

**Files:**

- Modify: `packages/db/src/repositories/ai-runs.ts`
- Test: `packages/db/src/repositories/ai-runs.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test to `packages/db/src/repositories/ai-runs.integration.test.ts`, inside the existing
`describe("ai run repository", ...)` block, after the
`"returns zero for an empty set of drafts without querying"` test:

```ts
  it("counts only runs at or after the given instant", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });

      const run = (idempotencyKey: string, estimatedCostUsd: number) => ({
        listingId: draft.id,
        task: "extract" as const,
        idempotencyKey,
        provider: "fake",
        model: "fake-1",
        promptVersion: "1.0.0",
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 5,
        estimatedCostUsd,
      });

      await repositories.aiRuns.append(run("older-batch", 4));

      // Read the cutoff from the database, not from Date.now(). `created_at`
      // defaults to the database's now(), so an app-side clock would make this
      // assertion depend on the two clocks agreeing.
      const [marker] = await admin<{ now: Date }[]>`select now() as now`;
      const cutoff = marker!.now;
      await new Promise((resolve) => setTimeout(resolve, 10));

      await repositories.aiRuns.append(run("this-batch", 1.5));

      // Without a bound, the earlier batch's spend is charged to this one.
      expect(
        await repositories.aiRuns.sumCostForListings([draft.id]),
      ).toBeCloseTo(5.5, 6);
      expect(
        await repositories.aiRuns.sumCostForListings([draft.id], cutoff),
      ).toBeCloseTo(1.5, 6);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/ai-runs.integration.test.ts
```

Expected: FAIL — TypeScript rejects the second argument, or the bounded call returns `5.5`.

- [ ] **Step 3: Add the bound to the port**

In `packages/db/src/repositories/ai-runs.ts`, replace the `sumCostForListings` declaration in the
`AiRunRepository` type:

```ts
  /**
   * Observed spend across the given drafts, in USD.
   *
   * `estimated_cost_usd` is a numeric column written via `toFixed(6)`, so it
   * returns as a string and must be cast before summing. Budgets are enforced
   * on this number rather than on a running total stored elsewhere, so the
   * budget can never drift out of sync with the runs it is counting.
   */
  sumCostForListings(listingIds: readonly string[]): Promise<number>;
```

with:

```ts
  /**
   * Observed spend across the given drafts, in USD.
   *
   * `estimated_cost_usd` is a numeric column written via `toFixed(6)`, so it
   * returns as a string and must be cast before summing. Budgets are enforced
   * on this number rather than on a running total stored elsewhere, so the
   * budget can never drift out of sync with the runs it is counting.
   *
   * `since` bounds the sum below, and is what makes a budget belong to one
   * batch rather than to a draft's whole history: a draft enriched by an
   * earlier batch would otherwise arrive already carrying that batch's spend.
   * Omit it to sum a draft's entire history.
   */
  sumCostForListings(
    listingIds: readonly string[],
    since?: Date,
  ): Promise<number>;
```

- [ ] **Step 4: Implement the bound**

In the same file, replace the implementation:

```ts
    async sumCostForListings(listingIds) {
      scope.assertOpen();
      if (listingIds.length === 0) return 0;
      const [row] = await transaction
        .select({
          total: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}::numeric), 0)::text`,
        })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, workspaceId),
            inArray(aiRuns.listingId, [...listingIds]),
          ),
        );
      return Number(row?.total ?? 0);
    },
```

with:

```ts
    async sumCostForListings(listingIds, since) {
      scope.assertOpen();
      if (listingIds.length === 0) return 0;
      const [row] = await transaction
        .select({
          total: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}::numeric), 0)::text`,
        })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, workspaceId),
            inArray(aiRuns.listingId, [...listingIds]),
            // Inclusive: a run recorded in the same instant the batch was
            // created belongs to that batch.
            ...(since === undefined ? [] : [gte(aiRuns.createdAt, since)]),
          ),
        );
      return Number(row?.total ?? 0);
    },
```

Extend the drizzle import on line 1 of the same file to include `gte`:

```ts
import { and, eq, gte, inArray, sql } from "drizzle-orm";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/ai-runs.integration.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/ai-runs.ts packages/db/src/repositories/ai-runs.integration.test.ts
git commit -m "feat(db): bound observed spend to an instant"
```

---

### Task 3: A batch knows when it was created

`advanceBatch` needs the batch's creation instant to pass as the spend bound. The column exists;
the repository just does not select it.

**Files:**

- Modify: `packages/db/src/repositories/enrichment-batches.ts:12-19,50-57`
- Test: `packages/db/src/repositories/enrichment-batches.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test to `packages/db/src/repositories/enrichment-batches.integration.test.ts`, inside its
top-level `describe` block:

```ts
  it("carries the batch's creation instant as a Date", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: null,
      });
      const before = new Date(Date.now() - 60_000);

      const created = await repositories.enrichmentBatches.create({
        label: "created at",
        budgetUsd: 5,
        waveSize: 2,
        createdBy: "user_1",
        listingIds: [draft.id],
      });

      // A Date, not the string the driver hands back for a timestamp column:
      // the spend bound is compared against it, and a string would be silently
      // accepted by the query builder and compared as text.
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.createdAt.getTime()).toBeGreaterThan(before.getTime());

      const fetched = await repositories.enrichmentBatches.getById(created.id);
      expect(fetched?.createdAt.getTime()).toBe(created.createdAt.getTime());
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/enrichment-batches.integration.test.ts
```

Expected: FAIL — TypeScript reports `createdAt` does not exist on `EnrichmentBatch`.

- [ ] **Step 3: Add the field to the type**

In `packages/db/src/repositories/enrichment-batches.ts`, replace:

```ts
export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  createdBy: string;
};
```

with:

```ts
export type EnrichmentBatch = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: EnrichmentBatchStatus;
  createdBy: string;
  /**
   * Start of the batch's spend window. Runs recorded before this instant belong
   * to whatever enriched the draft previously, and are not charged here.
   */
  createdAt: Date;
};
```

- [ ] **Step 4: Select the column**

In the same file, replace:

```ts
const COLUMNS = {
  id: enrichmentBatches.id,
  label: enrichmentBatches.label,
  budgetUsd: enrichmentBatches.budgetUsd,
  waveSize: enrichmentBatches.waveSize,
  status: enrichmentBatches.status,
  createdBy: enrichmentBatches.createdBy,
};
```

with:

```ts
const COLUMNS = {
  id: enrichmentBatches.id,
  label: enrichmentBatches.label,
  budgetUsd: enrichmentBatches.budgetUsd,
  waveSize: enrichmentBatches.waveSize,
  status: enrichmentBatches.status,
  createdBy: enrichmentBatches.createdBy,
  createdAt: enrichmentBatches.createdAt,
};
```

No change is needed to `EnrichmentBatchRow` or `toEnrichmentBatch`: the row type is
`Omit<EnrichmentBatch, "budgetUsd"> & { budgetUsd: string }`, so `createdAt` flows through as the
`Date` the driver already produces for a `timestamptz` column.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/enrichment-batches.integration.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/enrichment-batches.ts packages/db/src/repositories/enrichment-batches.integration.test.ts
git commit -m "feat(db): expose a batch's creation instant"
```

---

### Task 4: A budget belongs to its batch

Wire Task 2's bound to Task 3's field.

**Files:**

- Modify: `apps/web/lib/enrichment-batch-service.ts:188-191`
- Test: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Extend the test helper to record the spend bound**

In `apps/web/lib/enrichment-batch-service.test.ts`, the `advanceServiceWith` helper currently
discards `sumCostForListings`' arguments. Replace its `aiRuns` fake:

```ts
            aiRuns: {
              async sumCostForListings() {
                return options.spent;
              },
            },
```

with:

```ts
            aiRuns: {
              async sumCostForListings(_ids: string[], since?: Date) {
                spendBounds.push(since);
                return options.spent;
              },
            },
```

Declare the recorder alongside the other recorders near the top of the same helper, next to
`const audits: AuditRecord[] = [];`:

```ts
  const spendBounds: (Date | undefined)[] = [];
```

And add it to the helper's return value, replacing:

```ts
  return { service, enqueued, statuses, marked, audits };
```

with:

```ts
  return { service, enqueued, statuses, marked, audits, spendBounds };
```

The helper's `getById` fake must now return the field Task 3 added. Replace:

```ts
              async getById() {
                return {
                  id: "batch_1",
                  label: "zh names",
                  budgetUsd: options.budget,
                  waveSize: 2,
                  status: "open",
                  createdBy: "user_1",
                };
              },
```

with:

```ts
              async getById() {
                return {
                  id: "batch_1",
                  label: "zh names",
                  budgetUsd: options.budget,
                  waveSize: 2,
                  status: options.status ?? "open",
                  createdBy: "user_1",
                  createdAt: BATCH_CREATED_AT,
                };
              },
```

Add the fixed instant just above the `advanceServiceWith` declaration:

```ts
/** Fixed so the spend-window assertion does not depend on wall-clock time. */
const BATCH_CREATED_AT = new Date("2026-08-16T00:00:00.000Z");
```

Add `status` to the helper's options type, replacing:

```ts
function advanceServiceWith(options: {
  spent: number;
  budget: number;
  pending: string[];
  queued?: string[];
  listingStatuses?: Record<string, string>;
  counts?: Record<string, number>;
}) {
```

with:

```ts
function advanceServiceWith(options: {
  spent: number;
  budget: number;
  pending: string[];
  queued?: string[];
  listingStatuses?: Record<string, string>;
  counts?: Record<string, number>;
  status?: string;
}) {
```

(`status` is unused until Task 5; adding it here keeps the helper edited once.)

- [ ] **Step 2: Write the failing test**

Append to the `describe("enrichment batch advance", ...)` block:

```ts
  it("charges only spend recorded since the batch was created", async () => {
    const { service, spendBounds } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
    });

    await service.advanceBatch(advanceInput);

    // Unbounded, a draft that an earlier batch already enriched would arrive
    // carrying that batch's cost and could exhaust this budget immediately.
    expect(spendBounds).toEqual([BATCH_CREATED_AT]);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run lib/enrichment-batch-service.test.ts
```

Expected: FAIL — `spendBounds` is `[undefined]`.

- [ ] **Step 4: Pass the bound**

In `apps/web/lib/enrichment-batch-service.ts`, replace:

```ts
        // Budget is enforced on observed spend, never on a stored running
        // total, so it cannot drift out of sync with the runs it counts.
        const itemIds = await repositories.enrichmentBatches.listItemIds(
          input.batchId,
        );
        const spentUsd = await repositories.aiRuns.sumCostForListings(itemIds);
```

with:

```ts
        // Budget is enforced on observed spend, never on a stored running
        // total, so it cannot drift out of sync with the runs it counts.
        //
        // Bounded by the batch's own creation instant: a draft that an earlier
        // batch enriched still has those runs on record, and charging them here
        // would let a fresh batch report itself exhausted before doing any work.
        const itemIds = await repositories.enrichmentBatches.listItemIds(
          input.batchId,
        );
        const spentUsd = await repositories.aiRuns.sumCostForListings(
          itemIds,
          batch.createdAt,
        );
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run lib/enrichment-batch-service.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "fix(web): charge a batch only for its own runs"
```

---

### Task 5: A finished batch cannot be advanced

Defensive, per the scoping note above: no cancel route exists yet, so this exists to stop the first
one being born broken.

**Files:**

- Modify: `apps/web/lib/enrichment-batch-service.ts:145-155`
- Test: `apps/web/lib/enrichment-batch-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("enrichment batch advance", ...)` block:

```ts
  it.each(["completed", "cancelled"])(
    "refuses to advance a %s batch",
    async (status) => {
      const { service, enqueued, statuses } = advanceServiceWith({
        spent: 0,
        budget: 10,
        pending: ["draft_1"],
        status,
      });

      await expect(service.advanceBatch(advanceInput)).rejects.toThrow(
        /finished/i,
      );
      // The point of the guard: a cancelled batch with pending items would
      // otherwise claim a wave and set itself back to running.
      expect(enqueued).toEqual([]);
      expect(statuses).toEqual([]);
    },
  );

  it("still advances a batch that previously exhausted its budget", async () => {
    const { service, enqueued } = advanceServiceWith({
      spent: 0,
      budget: 10,
      pending: ["draft_1"],
      status: "budget_exhausted",
    });

    // Not terminal: re-advancing re-derives spend, which is the only way an
    // operator learns the batch is still stuck.
    const result = await service.advanceBatch(advanceInput);

    expect(result.status).toBe("running");
    expect(enqueued).toEqual(["draft_1"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run lib/enrichment-batch-service.test.ts
```

Expected: 2 failures (the `it.each` cases). The `budget_exhausted` case already passes; it is there
to pin the boundary so a future edit does not over-broaden the guard.

- [ ] **Step 3: Add the guard**

In `apps/web/lib/enrichment-batch-service.ts`, replace:

```ts
        if (!batch) {
          throw new ApiError(
            404,
            "batch_not_found",
            "No such enrichment batch.",
          );
        }
```

with:

```ts
        if (!batch) {
          throw new ApiError(
            404,
            "batch_not_found",
            "No such enrichment batch.",
          );
        }

        // `completed` and `cancelled` are terminal. Without this, a cancelled
        // batch that still holds pending items would claim a wave on the next
        // advance and set itself back to `running` — spending a budget an
        // operator believed they had stopped. `budget_exhausted` is deliberately
        // absent: re-advancing it re-derives observed spend, which is how an
        // operator confirms it is still stuck.
        if (batch.status === "completed" || batch.status === "cancelled") {
          throw new ApiError(
            409,
            "batch_not_advanceable",
            "This batch is finished and cannot be advanced.",
          );
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run lib/enrichment-batch-service.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/enrichment-batch-service.ts apps/web/lib/enrichment-batch-service.test.ts
git commit -m "feat(web): refuse to advance a finished batch"
```

---

### Task 6: Document the two behaviours an operator can observe

Defects 1 and 2 change what an operator sees. Defect 3 does not, because no cancel route exists.

**Files:**

- Modify: `docs/runbooks/shopline-pilot-onboarding.md`

- [ ] **Step 1: Document the stalled-draft outcome and the budget window**

In `docs/runbooks/shopline-pilot-onboarding.md`, replace the closing paragraph of §5:

```markdown
**Budget is a stop condition between waves, not a hard ceiling within one.** A
wave already in flight can overshoot by at most the cost of that wave, so size
`waveSize` for the overshoot you are willing to accept. Spend is measured from
`ai_runs.estimated_cost_usd`, which is the actual recorded cost of each run.
```

with:

```markdown
**Budget is a stop condition between waves, not a hard ceiling within one.** A
wave already in flight can overshoot by at most the cost of that wave, so size
`waveSize` for the overshoot you are willing to accept. Spend is measured from
`ai_runs.estimated_cost_usd`, which is the actual recorded cost of each run.

**A batch is charged only for runs recorded after it was created.** Re-enriching
a product that an earlier batch already processed starts that product's spend at
zero for the new batch, so an old run cannot exhaust a fresh budget.

**A product that stops for more information counts as failed, not pending.** If
the pipeline decides it cannot write a listing without more detail, the draft
lands in `needs_info` and the batch records it as a failure and moves on. It is
not retried — re-running failures is a new, separately budgeted batch. Without
this the batch would wait on it forever and never report `completed`.

A batch that has reached `completed` cannot be advanced again; the request is
refused with `batch_not_advanceable` (409).
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md
git commit -m "docs: describe batch spend windows and stalled drafts"
```

---

### Task 7: Full verification

- [ ] **Step 1: Typecheck**

```bash
pnpm lint
```

Expected: 14/14 tasks successful. Note this is `tsc --noEmit`, not ESLint.

- [ ] **Step 2: Unit tests**

```bash
pnpm test
```

Expected: 14/14 tasks successful. Do not pipe into `grep`/`head`/`tail`.

- [ ] **Step 3: Integration tests**

```bash
pnpm test:integration
```

Expected: PASS. Needs the Postgres container from the Prerequisites section.

- [ ] **Step 4: Format gate**

```bash
pnpm format:runtime:check
```

Expected: exits 0, `hash-pinned format debt waived: 0`. If it names files needing Prettier, run
`npx prettier --write <files>` and re-check. **Do not add a format-debt waiver.**

- [ ] **Step 5: Confirm the exhaustiveness gate actually bites**

This is the fix's whole value, so prove it rather than assuming it. Temporarily add an eleventh
status to `packages/core/src/workflow.ts`'s `ListingStatus` union:

```ts
  | "archived";
```

Then:

```bash
pnpm lint
```

Expected: FAIL, naming `BATCH_OUTCOME` in `apps/web/lib/enrichment-batch-service.ts` as missing the
`archived` property. **Revert the edit** and re-run `pnpm lint` to confirm 14/14 before continuing:

```bash
git checkout packages/core/src/workflow.ts && pnpm lint
```

- [ ] **Step 6: Confirm the working tree is clean**

```bash
git status --porcelain
```

Expected: no output. Any output here means Step 5's revert was incomplete.

---

## Out of scope

Named so a reviewer does not read their absence as an oversight:

- **A cancel route.** The Task 5 guard makes one safe to add; adding one is a separate change with
  its own audit event and role gate.
- **Retrying failed items.** Deliberate: re-running failures is a new batch with its own budget.
  A `needs_info` draft that an operator later completes is enriched by whatever batch selects it next.
- **Running `audit:verify` on an enriched draft.** Still the one unrun step of the enrichment plan.
  It needs a real batch run end to end, which is now possible — `AI_PROVIDER=fake` can enrich an
  imported draft as of `a0ba5a6` — but it is verification of the previous plan, not of this one.
- **Per-item spend windows.** The bound is the batch's creation instant, not each item's claim
  instant. Two concurrent batches sharing a draft could both count the same run. That requires two
  live batches selecting the same product, which the operator flow does not produce today.
