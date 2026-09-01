# `/jobs` Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `/jobs` page showing the recent activity of `enrichment_batches`, `publish_jobs`, `listing_pipeline_runs`, and `export_attempts` merged into one time-sorted list.

**Architecture:** Four small, mechanical `listForWorkspace(limit?)` repository methods (mirroring `listings.ts`'s existing `listRecent` convention) feed a pure merge function (`buildJobsLedger`) that normalizes each source's status vocabulary and sorts by time. A `GET /api/jobs` route wires the four repositories to that function; a client component renders the result with a client-side kind filter.

**Tech Stack:** Drizzle ORM, Next.js App Router, React 19, Vitest.

---

## Environment note for every `Run:` step

`pnpm` is not reliably on PATH in this environment. Prefix every command with `corepack`:

```powershell
corepack pnpm --filter @wukong/db test -- <file>
corepack pnpm --filter @wukong/web test -- <file>
```

Do **not** use an `$env:PATH = "...scratchpad\bin..."` prefix — that shim directory is empty this session. `corepack pnpm` is the confirmed-working form.

Integration tests need live Postgres (`docker compose up -d postgres`). Docker has been unreachable for most of this session's earlier work — if still unreachable when a task reaches an integration-test step, say so explicitly and move on rather than silently skipping it.

---

### Task 1: `listForWorkspace` on all 4 repositories

**Files:**

- Modify: `packages/db/src/repositories/enrichment-batches.ts`
- Modify: `packages/db/src/repositories/enrichment-batches.integration.test.ts`
- Modify: `packages/db/src/repositories/publish-jobs.ts`
- Modify: `packages/db/src/repositories/publish-jobs.integration.test.ts`
- Modify: `packages/db/src/repositories/pipeline-runs.ts`
- Create: `packages/db/src/repositories/pipeline-runs.integration.test.ts`
- Modify: `packages/db/src/repositories/export-attempts.ts`
- Modify: `packages/db/src/repositories/export-attempts.integration.test.ts`

- [ ] **Step 1: Read the pattern this must match**

Read `listings.ts`'s `listRecent` method (`packages/db/src/repositories/listings.ts:318-322`, already known: `async listRecent(limit = 100) { scope.assertOpen(); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("listing limit must be between 1 and 100"); ... .orderBy(desc(...)).limit(limit); }`) — every new method below must throw the same shape of error for an out-of-range `limit`, not silently clamp.

Read the full current content of all 4 files being modified (`enrichment-batches.ts`, `publish-jobs.ts`, `pipeline-runs.ts`, `export-attempts.ts`) to confirm exact current column names, existing `COLUMNS` constants (where present), and existing type shapes before extending them.

**Important, already confirmed by research**: `EnrichmentBatch` (in `enrichment-batches.ts`) and `PublishJob` (in `publish-jobs.ts`) do NOT currently expose `createdAt` in their TypeScript type, even though the underlying `enrichment_batches`/`publish_jobs` columns have it (`packages/db/src/schema.ts`). Adding `createdAt: Date` to both types is required for this task and is additive/non-breaking — every existing caller of `create`/`getById`/`getByIdempotencyKey`/etc. just gains an extra field on the returned object, nothing existing reads a type that would reject the wider shape.

- [ ] **Step 2: Write the failing integration tests**

For each of the 4 repositories, add a test to its integration test file proving: (a) `listForWorkspace()` returns rows newest-first (`createdAt desc`), (b) it never returns another workspace's rows (create rows in two workspaces, assert isolation — the standard RLS pattern used throughout this session), (c) `limit` bounds are enforced (`listForWorkspace(0)` and `listForWorkspace(101)` both throw).

`pipeline-runs.integration.test.ts` is a NEW file (this repository currently has no integration test at all — check this by attempting to find it before assuming; if one somehow exists, extend it instead of creating a duplicate). Mirror `publish-jobs.integration.test.ts`'s existing fixture/lifecycle style (role bootstrap, `database.migrate()`, truncate/seed workspaces) for the new file, and create pipeline-run rows via `repositories.pipelineRuns.claimStep`/`complete` (the only way to create a row — there's no direct `create`/`insert` helper) rather than raw SQL, to exercise the real code path.

- [ ] **Step 3: Run tests to verify they fail**

Run (once for each of the 4, or all together):

```powershell
docker compose up -d postgres
corepack pnpm test:integration -- enrichment-batches.integration.test.ts publish-jobs.integration.test.ts pipeline-runs.integration.test.ts export-attempts.integration.test.ts
```

Expected: FAIL — `listForWorkspace` does not exist on any of the 4. If Docker/Postgres is unreachable, state that explicitly and proceed to Step 4 anyway; verification happens once Postgres is reachable.

- [ ] **Step 4: Implement it**

**`enrichment-batches.ts`**: add `createdAt: Date` to the `EnrichmentBatch` type, add `enrichmentBatches.createdAt` to the `COLUMNS` constant, update `toEnrichmentBatch` if needed (it currently just spreads `row` and overrides `budgetUsd`, so the new field flows through automatically once it's in `COLUMNS`/`EnrichmentBatchRow`). Add to `EnrichmentBatchRepository`:

```ts
listForWorkspace(limit?: number): Promise<EnrichmentBatch[]>;
```

Implementation mirrors `listRecent`'s validation, `SELECT ... WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`, mapped through `toEnrichmentBatch`.

**`publish-jobs.ts`**: add `createdAt: Date` to `PublishJob`, add `createdAt: row.createdAt` to `toPublishJob`'s return (the underlying `.select()` calls in this file already select `*`, so `row.createdAt` is already available — confirm this by re-reading the file, since some call sites might use an explicit column list instead of `.select()`). Add:

```ts
listForWorkspace(limit?: number): Promise<PublishJob[]>;
```

Same validation/query/limit shape, `orderBy(desc(publishJobs.createdAt))`, mapped through `toPublishJob` (filter out any `null` result the way other methods do, or confirm `toPublishJob` never returns `null` for a real row from this query specifically — check its `if (!row?.versionId) return null` guard against whether `versionId` can genuinely be null on a real row before assuming this filter is unreachable here).

**`pipeline-runs.ts`**: this repository has NO existing list capability — add a new type:

```ts
export type PipelineRunSummary = {
  id: string;
  listingId: string;
  versionId: string | null;
  status: "started" | "succeeded" | "failed";
  errorCode: string | null;
  createdAt: Date;
};
```

and to `PipelineRunRepository`:

```ts
listForWorkspace(limit?: number): Promise<PipelineRunSummary[]>;
```

Query `listingPipelineRuns` directly (not through `listingPipelineSteps`), same validation/ordering/limit shape as the others.

**`export-attempts.ts`**: add to `ExportAttemptRepository`:

```ts
listForWorkspace(limit?: number): Promise<ExportAttempt[]>;
```

Same validation/ordering/limit shape (`orderBy(desc(exportAttempts.createdAt))`), using the existing `COLUMNS` constant this file already has.

- [ ] **Step 5: Register nothing new — these are additions to existing repository interfaces already wired into `client.ts`**

No changes needed to `packages/db/src/client.ts` (the repositories are already constructed there) — only `packages/db/src/index.ts` needs a check: if `PipelineRunSummary` is new, export it alongside the repository's existing type exports (read the file first to find where `PipelineRunRepository`'s other types are exported, if at all — this repository's types may not currently be re-exported from `index.ts` at all, in which case add exactly the new type, not a wholesale new export block for types that were previously intentionally internal).

Run:

```powershell
corepack pnpm test:integration -- enrichment-batches.integration.test.ts publish-jobs.integration.test.ts pipeline-runs.integration.test.ts export-attempts.integration.test.ts
```

Expected: PASS, or explicitly reported as blocked if Postgres is unreachable. Also run `corepack pnpm --filter @wukong/db exec tsc --noEmit` (works without Postgres) as the fallback correctness signal.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/enrichment-batches.ts packages/db/src/repositories/enrichment-batches.integration.test.ts packages/db/src/repositories/publish-jobs.ts packages/db/src/repositories/publish-jobs.integration.test.ts packages/db/src/repositories/pipeline-runs.ts packages/db/src/repositories/pipeline-runs.integration.test.ts packages/db/src/repositories/export-attempts.ts packages/db/src/repositories/export-attempts.integration.test.ts packages/db/src/index.ts
git commit -m "feat: add listForWorkspace to the 4 jobs-ledger source repositories"
```

---

### Task 2: `buildJobsLedger` — the pure merge function

**Files:**

- Create: `apps/web/lib/jobs-ledger.ts`
- Create: `apps/web/lib/jobs-ledger.test.ts`

- [ ] **Step 1: Confirm the exact 4 input row shapes**

Re-read Task 1's final `EnrichmentBatch`, `PublishJob`, `PipelineRunSummary`, `ExportAttempt` types (all now include `createdAt`) — this task's input types must match them exactly, not the pre-Task-1 shapes.

- [ ] **Step 2: Write the failing tests**

Create `apps/web/lib/jobs-ledger.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildJobsLedger } from "./jobs-ledger.js";

describe("buildJobsLedger", () => {
  it("normalizes each source's status and merges/sorts by createdAt descending", () => {
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "Batch 1",
            budgetUsd: 5,
            waveSize: 3,
            status: "open",
            createdBy: "u1",
            createdAt: new Date("2026-08-31T10:00:00Z"),
          },
          {
            id: "b2",
            label: "Batch 2",
            budgetUsd: 5,
            waveSize: 3,
            status: "budget_exhausted",
            createdBy: "u1",
            createdAt: new Date("2026-08-31T08:00:00Z"),
          },
        ],
        publishJobs: [
          {
            id: "p1",
            listingId: "l1",
            versionId: "v1",
            connectionId: "c1",
            status: "published",
            idempotencyKey: "k1",
            payloadDigest: null,
            remoteProductId: "r1",
            error: null,
            leaseToken: null,
            leaseExpiresAt: null,
            attemptCount: 1,
            createdAt: new Date("2026-08-31T09:00:00Z"),
          },
        ],
        pipelineRuns: [
          {
            id: "pr1",
            listingId: "l2",
            versionId: null,
            status: "started",
            errorCode: null,
            createdAt: new Date("2026-08-31T11:00:00Z"),
          },
        ],
        exports: [
          {
            id: "e1",
            requestedBy: "u1",
            manifest: [
              { listingId: "l3", versionId: "v3", outcome: "included" },
            ],
            rowCount: 1,
            specVersion: "opak-2026-05",
            createdAt: new Date("2026-08-31T07:00:00Z"),
          },
        ],
      },
      10,
    );

    expect(entries.map((e) => e.id)).toEqual(["pr1", "b1", "p1", "b2", "e1"]);
    expect(entries[0]).toMatchObject({
      kind: "pipeline_run",
      normalizedStatus: "running",
      rawStatus: "started",
      listingId: "l2",
    });
    expect(entries[1]).toMatchObject({
      kind: "batch",
      normalizedStatus: "pending",
      rawStatus: "open",
      listingId: null,
    });
    expect(entries[2]).toMatchObject({
      kind: "publish_job",
      normalizedStatus: "succeeded",
      rawStatus: "published",
      listingId: "l1",
    });
    expect(entries[3]).toMatchObject({
      kind: "batch",
      normalizedStatus: "cancelled",
      rawStatus: "budget_exhausted",
      listingId: null,
    });
    expect(entries[4]).toMatchObject({
      kind: "export",
      normalizedStatus: "succeeded",
      rawStatus: "export_attempts",
      listingId: null,
    });
  });

  it("truncates to limit after merging, not per-source", () => {
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "A",
            budgetUsd: 1,
            waveSize: 1,
            status: "open",
            createdBy: "u",
            createdAt: new Date("2026-08-31T12:00:00Z"),
          },
          {
            id: "b2",
            label: "B",
            budgetUsd: 1,
            waveSize: 1,
            status: "open",
            createdBy: "u",
            createdAt: new Date("2026-08-31T11:00:00Z"),
          },
        ],
        publishJobs: [],
        pipelineRuns: [],
        exports: [],
      },
      1,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("b1");
  });

  it("produces the correct summary and null listingId for each kind", () => {
    const entries = buildJobsLedger(
      {
        batches: [
          {
            id: "b1",
            label: "My batch",
            budgetUsd: 5,
            waveSize: 3,
            status: "completed",
            createdBy: "u",
            createdAt: new Date(),
          },
        ],
        publishJobs: [],
        pipelineRuns: [],
        exports: [
          {
            id: "e1",
            requestedBy: "u",
            manifest: [
              { listingId: "l1", versionId: "v1", outcome: "included" },
              {
                listingId: "l2",
                versionId: null,
                outcome: "listing_not_found",
              },
            ],
            rowCount: 1,
            specVersion: "opak-2026-05",
            createdAt: new Date(),
          },
        ],
      },
      10,
    );
    const batch = entries.find((e) => e.kind === "batch");
    const exportEntry = entries.find((e) => e.kind === "export");
    expect(batch?.listingId).toBeNull();
    expect(batch?.summary).toContain("My batch");
    expect(exportEntry?.listingId).toBeNull();
    expect(exportEntry?.summary).toMatch(/1.*row/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- jobs-ledger.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/lib/jobs-ledger.ts`:

```ts
import type { EnrichmentBatch } from "@wukong/db";
import type { PublishJob } from "@wukong/db";
import type { PipelineRunSummary } from "@wukong/db";
import type { ExportAttempt } from "@wukong/db";

export type LedgerKind = "batch" | "publish_job" | "pipeline_run" | "export";
export type NormalizedStatus =
  "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type LedgerEntry = {
  kind: LedgerKind;
  id: string;
  listingId: string | null;
  normalizedStatus: NormalizedStatus;
  rawStatus: string;
  createdAt: Date;
  summary: string;
};

export type JobsLedgerSources = {
  batches: readonly EnrichmentBatch[];
  publishJobs: readonly PublishJob[];
  pipelineRuns: readonly PipelineRunSummary[];
  exports: readonly ExportAttempt[];
};

const BATCH_STATUS: Record<EnrichmentBatch["status"], NormalizedStatus> = {
  open: "pending",
  running: "running",
  completed: "succeeded",
  budget_exhausted: "cancelled",
  cancelled: "cancelled",
};

const PUBLISH_JOB_STATUS: Record<PublishJob["status"], NormalizedStatus> = {
  pending_enqueue: "pending",
  queued: "pending",
  running: "running",
  published: "succeeded",
  failed: "failed",
};

const PIPELINE_RUN_STATUS: Record<
  PipelineRunSummary["status"],
  NormalizedStatus
> = {
  started: "running",
  succeeded: "succeeded",
  failed: "failed",
};

export function buildJobsLedger(
  sources: JobsLedgerSources,
  limit: number,
): LedgerEntry[] {
  const entries: LedgerEntry[] = [
    ...sources.batches.map((batch) => ({
      kind: "batch" as const,
      id: batch.id,
      listingId: null,
      normalizedStatus: BATCH_STATUS[batch.status],
      rawStatus: batch.status,
      createdAt: batch.createdAt,
      summary: `${batch.label} (wave ${batch.waveSize}, $${batch.budgetUsd.toFixed(2)})`,
    })),
    ...sources.publishJobs.map((job) => ({
      kind: "publish_job" as const,
      id: job.id,
      listingId: job.listingId,
      normalizedStatus: PUBLISH_JOB_STATUS[job.status],
      rawStatus: job.status,
      createdAt: job.createdAt,
      summary: job.remoteProductId
        ? `Published as ${job.remoteProductId}`
        : job.error
          ? `Error: ${job.error}`
          : "Publishing",
    })),
    ...sources.pipelineRuns.map((run) => ({
      kind: "pipeline_run" as const,
      id: run.id,
      listingId: run.listingId,
      normalizedStatus: PIPELINE_RUN_STATUS[run.status],
      rawStatus: run.status,
      createdAt: run.createdAt,
      summary: run.errorCode ? `Error: ${run.errorCode}` : "AI pipeline run",
    })),
    ...sources.exports.map((attempt) => {
      const included = attempt.manifest.filter(
        (entry) => entry.outcome === "included",
      ).length;
      const excluded = attempt.manifest.length - included;
      return {
        kind: "export" as const,
        id: attempt.id,
        listingId: null,
        normalizedStatus: "succeeded" as const,
        rawStatus: "export_attempts",
        createdAt: attempt.createdAt,
        summary:
          excluded > 0
            ? `Export: ${included} row(s), ${excluded} excluded`
            : `Export: ${included} row(s)`,
      };
    }),
  ];

  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return entries.slice(0, limit);
}
```

Adjust the exact `@wukong/db` import paths/type names to match what Task 1 actually exported (some of these types may not currently be re-exported from `packages/db/src/index.ts` — check and add the missing exports there rather than reaching into a repository file's internal path from `apps/web`).

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- jobs-ledger.test.ts
```

Expected: PASS, all 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/jobs-ledger.ts apps/web/lib/jobs-ledger.test.ts
git commit -m "feat: add buildJobsLedger, the pure ledger-merge function"
```

---

### Task 3: `GET /api/jobs` route

**Files:**

- Create: `apps/web/app/api/jobs/route.ts`
- Create: `apps/web/app/api/jobs/route.test.ts`

- [ ] **Step 1: Read the closest existing read-route precedent**

Read `apps/web/app/api/catalog/route.ts` in full (a `GET`-only route, no `[id]` param, `requireSessionContext` with no `requireWorkspaceRole` call — viewer+ access, `db.forWorkspace(...)` calling two repository reads and combining them in the route). This new route mirrors its shape closely: no role gate beyond authentication, no query params (per this session's own research — neither `/api/catalog` nor `GET /api/listings` exposes a user-configurable `limit`; this route follows the same convention with a fixed internal fetch size, not a `?limit=` query parameter).

- [ ] **Step 2: Write the failing test**

Create `apps/web/app/api/jobs/route.test.ts`, mirroring `catalog/route.test.ts`'s fixture style (fake `db.forWorkspace`). Cover:

- Any authenticated member (viewer included) gets `200 { entries: [...] }` with entries from all 4 fake repositories merged.
- An unauthenticated request gets `401` (matching `requireSessionContext`'s standard behavior — check the exact status/shape against the catalog route's own test for this case).
- Each of the 4 repositories' `listForWorkspace` is called exactly once per request.

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- "apps/web/app/api/jobs/route.test.ts"
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/app/api/jobs/route.ts`. The handler:

1. `requireSessionContext(deps.sessionContext)` — no role gate (viewer+, matching the catalog route).
2. Inside `db.forWorkspace(session.workspaceId, async (repositories) => { ... })`, calls all 4 `listForWorkspace(100)` methods (fetch generously from each source — 100 each — since the final truncation to the page's actual display limit happens after the merge in `buildJobsLedger`, not per-source; fetching fewer than the display limit from any one source could wrongly under-represent a source that happens to have more recent activity than the others).
3. Calls `buildJobsLedger({batches, publishJobs, pipelineRuns, exports}, 50)` (50 is the fixed display limit — matches the design's stated default).
4. Returns `jsonResponse(200, { entries })`.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- "apps/web/app/api/jobs/route.test.ts"
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/jobs/route.ts" "apps/web/app/api/jobs/route.test.ts"
git commit -m "feat: add GET /api/jobs"
```

---

### Task 4: `/jobs` page, client component, and nav link

**Files:**

- Create: `apps/web/app/(app)/jobs/page.tsx`
- Create: `apps/web/components/jobs-ledger-client.tsx`
- Create: `apps/web/components/jobs-ledger-client.test.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

- [ ] **Step 1: Read the closest existing page + client-component pattern**

Read `apps/web/app/(app)/catalog/page.tsx` (the page-level pattern: server component, no role gate, renders a client component) and `apps/web/components/catalog-control-center.tsx` (the `useEffect` + `fetch` + `useState` pattern: loading/error/data states). This new page and component mirror both closely.

- [ ] **Step 2: Write the failing test**

Create `apps/web/components/jobs-ledger-client.test.tsx`. Cover: renders a list of entries from a fake fetch response (one row per entry, showing `kind`, `summary`, `rawStatus`); a listing link (`/listings/[id]`) renders only when `listingId` is non-null; the kind-filter toggle buttons narrow the visible rows to the selected kind (or "All"); a fetch error renders a visible error state (mirroring whatever error-handling convention `catalog-control-center.tsx` already established — this session found real bugs in prior packages from missing fetch-error handling, so this must not be skipped).

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- jobs-ledger-client.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/components/jobs-ledger-client.tsx`: `"use client"`, `useState` for `entries`/`loading`/`error`/`kindFilter`, `useEffect` fetching `/api/jobs` on mount with the same try/catch + `response.ok` check pattern `catalog-control-center.tsx` uses, renders a filter toggle row and the (possibly kind-filtered) entry list — each row shows a status-colored indicator (reuse or extend existing CSS conventions; check `globals.css` for any existing status-pill class from this branch's own work — e.g. Package G's compliance-flags styling — before inventing a new one), `kind` label, `summary`, `rawStatus` as a muted sub-label, a relative or ISO timestamp, and a `Link` to `/listings/{listingId}` when present.

Create `apps/web/app/(app)/jobs/page.tsx`: server component, no role gate (matches `/catalog`), renders `<JobsLedgerClient />` inside the page's heading/layout wrapper (mirror `catalog/page.tsx`'s exact wrapper markup).

In `apps/web/app/(app)/layout.tsx`, add a nav link between the existing `/listings/import` link and the `isAdmin` conditional block, matching the exact bilingual pattern already used by every other link:

```tsx
<Link href="/jobs">
  內部作業 <span>Jobs</span>
</Link>
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- jobs-ledger-client.test.tsx
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/jobs/page.tsx" apps/web/components/jobs-ledger-client.tsx apps/web/components/jobs-ledger-client.test.tsx "apps/web/app/(app)/layout.tsx"
git commit -m "feat: add the /jobs ledger page and nav link"
```

---

### Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run:

```powershell
corepack pnpm typecheck
```

Expected: PASS across every package.

- [ ] **Step 2: Format check**

Run:

```powershell
corepack pnpm format:runtime:check
```

Expected: PASS, or fix flagged files with `corepack pnpm exec prettier --write <files>` and re-check.

- [ ] **Step 3: Full unit suite**

Run:

```powershell
corepack pnpm test
```

Expected: PASS, all packages.

- [ ] **Step 4: Integration suite (requires live Postgres)**

Run:

```powershell
docker compose up -d postgres
corepack pnpm test:integration
```

Expected: PASS, all packages, including the new/extended integration tests from Task 1. If Postgres is unreachable, state that explicitly rather than reporting this step as passed.

- [ ] **Step 5: `pnpm runtime:forbidden:check`**

Run:

```powershell
corepack pnpm runtime:forbidden:check
```

Expected: PASS.

---

## Self-Review

**Spec coverage:** §3 (repository changes) → Task 1. §4 (ledger merge) → Task 2. §5 (API) → Task 3. §6 (UI) → Task 4. §7 (testing) → each task's own test file, aggregated in Task 5.

**Placeholder scan:** Task 1's Step 4 explicitly flags two points needing the implementer's own verification against real code rather than a guess (whether `toPublishJob`'s existing `.select()` calls already expose `createdAt`, and whether `PipelineRunRepository`'s types are currently re-exported from `index.ts` at all) — deliberate "read and confirm" instructions, not placeholders.

**Type consistency:** `LedgerEntry`/`JobsLedgerSources` (Task 2) consume exactly the types Task 1 produces (`EnrichmentBatch`, `PublishJob`, `PipelineRunSummary`, `ExportAttempt`, all now carrying `createdAt`). The route (Task 3) and client component (Task 4) both consume `LedgerEntry` as Task 2 defines it, with no intermediate reshaping.

**Scope check:** four small, homogeneous repository methods, one pure merge function, one read endpoint, one page + one client component + one nav-link edit — smaller than Package H, comparable to Package F's original UI scope.
