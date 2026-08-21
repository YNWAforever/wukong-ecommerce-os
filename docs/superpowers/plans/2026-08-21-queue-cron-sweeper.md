# Queue Cron Sweeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cron-triggered "sweeper" on the Cloudflare Worker that periodically finds listings whose enqueue-to-queue HTTP push failed (or whose pipeline run stalled with nothing in flight) and re-enqueues them internally through the Worker's own `LISTING_QUEUE` producer binding — removing the `*.workers.dev` HTTP hop from the correctness path.

**Architecture:** Three pieces. (1) A `SECURITY DEFINER` SQL function (the established RLS-escape mechanism, precedent: `packages/db/drizzle/0002_auth_access_rls.sql`) that finds stuck jobs across all workspaces, exposed as a new unscoped method on the `Database` interface (precedent: `ping()`). (2) A `scheduled` handler on the Worker (`apps/worker/src/sweeper.ts`) that calls it and `env.LISTING_QUEUE.send()`s each result — no HTTP involved, the Worker talks to its queue natively. (3) A `triggers.crons` entry added to the generated wrangler config. Re-enqueueing something already processed or in flight is safe by design: the pipeline's existing idempotency (succeeded-run short-circuit, lease-keyed steps) drops duplicates.

**Tech Stack:** raw SQL migration (Drizzle-adjacent, `packages/db/drizzle/0007_*.sql`), `postgres` driver, Cloudflare Workers `scheduled` handler, Vitest + `node --test` (for `tests/cloudflare-config.test.mjs`).

---

## Why this shape (context for implementers)

The web app enqueues `ListingJob`s by HTTP POST to the Worker's `*.workers.dev` ingress. That shared domain intermittently hard-times-out under bursty traffic from Vercel's shared egress IPs (measured: requests spaced 5s apart always succeed, tight bursts fail at the TCP level). A one-retry mitigation already shipped (PR #38) but a 503 still occurred on 2026-08-21. `docs/reviews/2026-07-26-pipeline-publish-runtime-review.md:57-67` already prescribed this exact fix: "There is no reaper... no `scheduled` handler".

**The two stuck shapes the sweeper must find** (verified against current code):

- **Shape A — push failed at creation.** `POST /api/listings` creates the draft (status `received`, DB default), then enqueues AFTER the transaction commits; on failure the draft is kept, the response is still 201, and the only record is a `listing.enqueue_failed` log line. No `listing_pipeline_runs` row exists (the worker's `ensureRun` is the only writer). Stuck signature: status `received` + has ≥1 attached source asset + no run row for the current sequence + older than a grace window.
- **Shape B — push failed after `reopenFailed`.** `POST /api/listings/[id]/process` calls `pipelineRuns.reopenFailed(key)` (resets a `failed` run to `started`, deletes its `running` steps) INSIDE the DB transaction, then enqueues after it. If the push then fails, the run sits at `started` with nothing in flight — and the route itself now 409s on retry (`processing_already_started`), so the listing is permanently wedged. Same signature also covers a worker that crashed mid-run after the queue message exhausted its retries. Stuck signature: run `started` + stale `updated_at` + no step in `running` state within the 300s lease window + the draft's current sequence still matches the run's.

**Why duplicates are safe:** `runListingPipeline` short-circuits on a `succeeded` run (`getCompleted`) → consumer acks; an in-flight run with a live lease → `PipelineStepBusyError` → `message.retry` with a delay. The only real cost is retry-budget burn on a live run, which the staleness conditions above avoid by construction.

**Facts implementers must not re-derive wrong** (all verified):

- `listing_drafts` has NO `active_version_sequence` column. It is derived: the `sequence` of the `listing_versions` row pointed at by `active_version_id`, else `0` (see `requireById`, `packages/db/src/repositories/listings.ts:298`).
- The idempotency key format is `listing:<workspaceId>:<draftId>:<activeVersionSequence>`, duplicated verbatim in `apps/web/lib/listing-queue-runtime.ts:9-11` and `apps/worker/src/listing-pipeline.ts:26-28`.
- RLS: every tenant table has FORCE RLS with a `TO wukong_app` policy keyed on the `app.workspace_id` GUC; with no GUC set, `wukong_app` sees zero rows in every table including `workspaces`. The migration/admin role (superuser locally, BYPASSRLS on Neon) is what a `SECURITY DEFINER` function executes as — that's the escape hatch, and `0002_auth_access_rls.sql:1-21` is the pattern to copy exactly (`SET search_path = public`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO wukong_app`).
- The Worker's DB pool is capped at 5 connections (`createWorkerDatabase`, `apps/worker/src/cloudflare-runtime.ts:46-52`); Hyperdrive fronts the `wukong_app` runtime role, never the admin URL.
- `tests/cloudflare-config.test.mjs` deep-equals the ENTIRE rendered wrangler object AND the parsed `cloudflare-runtime.config.json` — both must be updated in the same commit as the render script or CI fails.
- None of the files this plan touches are on the format-debt waiver list — everything must be Prettier-clean. `packages/db/src/client.ts` is not waived either.
- The package-level `pnpm --filter @wukong/db test:integration` script is hardcoded to ONE file (`listings.integration.test.ts`); to run a new integration test file use `pnpm --filter @wukong/db exec vitest run src/<file>` directly.

---

### Task 1: `sweeper_find_stuck_listing_jobs` SQL function + `Database.findStuckListingJobs`

**Files:**

- Create: `packages/db/drizzle/0007_stuck_listing_sweeper.sql`
- Modify: `packages/db/src/client.ts`
- Test: `packages/db/src/sweeper.integration.test.ts` (new file)

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0007_stuck_listing_sweeper.sql`:

```sql
-- Cross-workspace read for the Worker's cron sweeper. wukong_app cannot
-- enumerate tenants (FORCE RLS keyed on the app.workspace_id GUC), so this
-- follows the 0002_auth_access_rls.sql precedent: a SECURITY DEFINER function
-- owned by the migration role, EXECUTE granted to wukong_app only.
--
-- Two stuck shapes:
--   A) a draft whose creation-time enqueue push failed: status 'received',
--      has at least one attached source asset, and no pipeline run row exists
--      for its current active version sequence.
--   B) a pipeline run reopened (or crashed) with nothing in flight: run
--      'started' and stale, no step actively leased within the 300s lease
--      window, and the draft's current sequence still matches the run's.
CREATE OR REPLACE FUNCTION sweeper_find_stuck_listing_jobs(
  older_than_seconds integer,
  max_rows integer
)
RETURNS TABLE (
  workspace_id text,
  draft_id uuid,
  active_version_sequence integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH draft_sequences AS (
    SELECT
      d.workspace_id,
      d.id AS draft_id,
      d.status,
      d.created_at,
      COALESCE(v.sequence, 0) AS active_version_sequence
    FROM listing_drafts d
    LEFT JOIN listing_versions v
      ON v.workspace_id = d.workspace_id
     AND v.id = d.active_version_id
  ),
  never_started AS (
    SELECT s.workspace_id, s.draft_id, s.active_version_sequence
    FROM draft_sequences s
    WHERE s.status = 'received'
      AND s.created_at < now() - make_interval(secs => older_than_seconds)
      AND EXISTS (
        SELECT 1 FROM source_assets a
        WHERE a.workspace_id = s.workspace_id
          AND a.listing_id = s.draft_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM listing_pipeline_runs r
        WHERE r.workspace_id = s.workspace_id
          AND r.listing_id = s.draft_id
          AND r.active_version_sequence = s.active_version_sequence
      )
  ),
  stalled_runs AS (
    SELECT s.workspace_id, s.draft_id, s.active_version_sequence
    FROM draft_sequences s
    JOIN listing_pipeline_runs r
      ON r.workspace_id = s.workspace_id
     AND r.listing_id = s.draft_id
     AND r.active_version_sequence = s.active_version_sequence
    WHERE r.status = 'started'
      AND r.updated_at < now() - make_interval(secs => older_than_seconds)
      AND s.status IN ('received', 'processing', 'needs_info', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM listing_pipeline_steps p
        WHERE p.workspace_id = r.workspace_id
          AND p.pipeline_run_id = r.id
          AND p.state = 'running'
          AND p.updated_at >= now() - interval '300 seconds'
      )
  )
  SELECT * FROM never_started
  UNION
  SELECT * FROM stalled_runs
  ORDER BY workspace_id, draft_id
  LIMIT max_rows;
$$;

REVOKE ALL ON FUNCTION sweeper_find_stuck_listing_jobs(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweeper_find_stuck_listing_jobs(integer, integer) TO wukong_app;
```

- [ ] **Step 2: Write the failing integration test**

Create `packages/db/src/sweeper.integration.test.ts`. Read `packages/db/src/repositories/listings-promote-approve.integration.test.ts` first and copy its exact setup conventions (`admin`/`database` construction, `beforeAll` role bootstrap + `database.migrate()`, `afterAll` teardown, env-var URLs with the same localhost:54329 defaults). Use `workspaceId = "ws_sweeper"`. The tests seed via `forWorkspace` where possible and use raw `admin` SQL only to backdate timestamps and force run/step states (RLS does not bind the admin connection):

```ts
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "./index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const workspaceId = "ws_sweeper";

describe("findStuckListingJobs", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  beforeAll(async () => {
    await admin.unsafe(
      "DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;",
    );
    await database.migrate();
    await admin.unsafe(`DELETE FROM workspaces WHERE id = '${workspaceId}'`);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  async function seedDraftWithAsset(): Promise<string> {
    return forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const upload = await repos.sourceAssets.create({
        storageKey: `ws/${workspaceId}/sources/${listing.id}/label.jpg`,
        kind: "image/jpeg",
        metadata: {},
      });
      await repos.sourceAssets.attachToListing(listing.id, [upload.id]);
      return listing.id;
    });
  }

  function backdateDraft(listingId: string, seconds: number) {
    return admin`update listing_drafts set created_at = now() - make_interval(secs => ${seconds}) where workspace_id = ${workspaceId} and id = ${listingId}`;
  }

  it("finds a received draft with assets, past the grace window, and no run row (shape A)", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });

    expect(jobs).toContainEqual({
      workspaceId,
      draftId: listingId,
      activeVersionSequence: 0,
    });
  });

  it("skips a draft still inside the grace window", async () => {
    const listingId = await seedDraftWithAsset();
    // created_at = now(); no backdate.
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("skips a received draft with no attached assets", async () => {
    const listingId = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.create({ target: "shopline" }).then((l) => l.id),
    );
    await backdateDraft(listingId, 600);
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("skips a draft whose run row already exists at the current sequence", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);
    await admin`insert into listing_pipeline_runs (workspace_id, listing_id, active_version_sequence, idempotency_key, status) values (${workspaceId}, ${listingId}, 0, ${"listing:" + workspaceId + ":" + listingId + ":0"}, 'succeeded')`;
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("finds a stale started run with no live step lease (shape B)", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);
    await admin`insert into listing_pipeline_runs (workspace_id, listing_id, active_version_sequence, idempotency_key, status, updated_at) values (${workspaceId}, ${listingId}, 0, ${"listing:" + workspaceId + ":" + listingId + ":0"}, 'started', now() - interval '600 seconds')`;

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });

    expect(jobs).toContainEqual({
      workspaceId,
      draftId: listingId,
      activeVersionSequence: 0,
    });
  });

  it("skips a started run whose step lease is still live", async () => {
    const listingId = await seedDraftWithAsset();
    await backdateDraft(listingId, 600);
    const [run] =
      await admin`insert into listing_pipeline_runs (workspace_id, listing_id, active_version_sequence, idempotency_key, status, updated_at) values (${workspaceId}, ${listingId}, 0, ${"listing:" + workspaceId + ":" + listingId + ":0"}, 'started', now() - interval '600 seconds') returning id`;
    await admin`insert into listing_pipeline_steps (workspace_id, pipeline_run_id, step, state, updated_at) values (${workspaceId}, ${run!.id}, 'started', 'running', now())`;

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 20,
    });

    expect(jobs.map((job) => job.draftId)).not.toContain(listingId);
  });

  it("caps results at maxRows", async () => {
    const first = await seedDraftWithAsset();
    const second = await seedDraftWithAsset();
    await backdateDraft(first, 600);
    await backdateDraft(second, 600);

    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: 300,
      maxRows: 1,
    });

    expect(jobs.length).toBeLessThanOrEqual(1);
  });
});
```

Adapt seeding helpers to the real repository method signatures — read `packages/db/src/repositories/source-assets.ts` (`create`, `attachToListing`) before writing; if `create` requires different fields (e.g. a size or file name), match the real signature. If a column named above differs from the real schema (check `packages/db/src/schema.ts`), the schema is the source of truth.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @wukong/db exec vitest run src/sweeper.integration.test.ts`
Expected: FAIL — `database.findStuckListingJobs is not a function` (the migration will apply during `beforeAll`, so failures should be about the missing method, not missing SQL).

- [ ] **Step 4: Add `findStuckListingJobs` to the `Database` interface and implementation**

In `packages/db/src/client.ts`, add to the `Database` type (near `ping()`):

```ts
  /**
   * Cross-workspace read used only by the Worker's cron sweeper. Deliberately
   * not forWorkspace: wukong_app cannot enumerate tenants, so this calls a
   * SECURITY DEFINER function (0007_stuck_listing_sweeper.sql) instead.
   */
  findStuckListingJobs(input: {
    olderThanSeconds: number;
    maxRows: number;
  }): Promise<
    Array<{
      workspaceId: string;
      draftId: string;
      activeVersionSequence: number;
    }>
  >;
```

And in the object returned by `createDatabase` (next to `ping`):

```ts
    async findStuckListingJobs({ olderThanSeconds, maxRows }) {
      const rows = await client`
        select workspace_id, draft_id, active_version_sequence
        from sweeper_find_stuck_listing_jobs(${olderThanSeconds}, ${maxRows})
      `;
      return rows.map((row) => ({
        workspaceId: String(row.workspace_id),
        draftId: String(row.draft_id),
        activeVersionSequence: Number(row.active_version_sequence),
      }));
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wukong/db exec vitest run src/sweeper.integration.test.ts`
Expected: PASS, all 7 tests. The critical one is the first: it proves `wukong_app` (the app URL connection) can read across RLS through the function.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/db test && pnpm --filter @wukong/db lint && pnpm test:integration`
Expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/0007_stuck_listing_sweeper.sql packages/db/src/client.ts packages/db/src/sweeper.integration.test.ts
git commit -m "feat(db): add cross-workspace stuck-listing lookup for the queue sweeper"
```

---

### Task 2: Worker `scheduled` handler

**Files:**

- Create: `apps/worker/src/sweeper.ts`
- Modify: `apps/worker/src/cloudflare.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/src/sweeper.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/sweeper.test.ts`. Follow `ingress.test.ts`'s env-factory style (fakes cast `as never` where the real Cloudflare types are irrelevant):

```ts
import { describe, expect, it, vi } from "vitest";

import { handleScheduled } from "./sweeper.js";
import type { WorkerEnv } from "./worker-env.js";

function env(send = vi.fn(async () => undefined)): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "opaque-connection-string" } as never,
    LISTING_QUEUE: { send } as never,
    SHOPLINE_QUEUE: { send: vi.fn() } as never,
  } as WorkerEnv;
}

const job = {
  workspaceId: "ws_opak",
  draftId: "00000000-0000-4000-8000-000000000001",
  activeVersionSequence: 0,
};

function makeDatabase(jobs: unknown[]) {
  return {
    findStuckListingJobs: vi.fn(async () => jobs),
    close: vi.fn(async () => undefined),
  };
}

describe("handleScheduled", () => {
  it("re-enqueues every stuck job through the listing queue binding", async () => {
    const send = vi.fn(async () => undefined);
    const database = makeDatabase([job]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(database.findStuckListingJobs).toHaveBeenCalledWith({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(job);
    expect(database.close).toHaveBeenCalled();
  });

  it("skips a row that does not parse as a ListingJob", async () => {
    const send = vi.fn(async () => undefined);
    const database = makeDatabase([
      {
        workspaceId: "ws:bad",
        draftId: "not-a-uuid",
        activeVersionSequence: -1,
      },
      job,
    ]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(job);
  });

  it("closes the database even when a send throws", async () => {
    const send = vi.fn(async () => {
      throw new Error("queue send failed");
    });
    const database = makeDatabase([job]);

    await expect(
      handleScheduled(undefined as never, env(send), undefined as never, {
        createDatabase: () => database as never,
      }),
    ).rejects.toThrow("queue send failed");

    expect(database.close).toHaveBeenCalled();
  });

  it("does nothing when no jobs are stuck", async () => {
    const send = vi.fn(async () => undefined);
    const database = makeDatabase([]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wukong/worker test -- sweeper.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the sweeper**

Create `apps/worker/src/sweeper.ts`:

```ts
import { listingJobSchema } from "@wukong/jobs";

import { createWorkerDatabase } from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

// Older than the pipeline step lease (300s) so nothing legitimately in flight
// is ever swept; small batch per tick keeps the 5-connection pool and the
// consumer's retry budget safe.
const SWEEP_OLDER_THAN_SECONDS = 300;
const SWEEP_MAX_ROWS = 20;

type SweeperDatabase = {
  findStuckListingJobs(input: {
    olderThanSeconds: number;
    maxRows: number;
  }): Promise<
    Array<{
      workspaceId: string;
      draftId: string;
      activeVersionSequence: number;
    }>
  >;
  close(): Promise<void>;
};

type SweeperDependencies = {
  createDatabase?: (env: WorkerEnv) => SweeperDatabase;
};

export async function handleScheduled(
  _controller: ScheduledController,
  env: WorkerEnv,
  _context: ExecutionContext,
  dependencies: SweeperDependencies = {},
): Promise<void> {
  const database = (dependencies.createDatabase ?? createWorkerDatabase)(env);
  try {
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: SWEEP_OLDER_THAN_SECONDS,
      maxRows: SWEEP_MAX_ROWS,
    });
    let requeued = 0;
    for (const job of jobs) {
      const parsed = listingJobSchema.safeParse(job);
      if (!parsed.success) continue;
      await env.LISTING_QUEUE.send(parsed.data);
      requeued += 1;
      console.info(
        JSON.stringify({
          event: "sweeper.requeued",
          workspaceId: parsed.data.workspaceId,
          listingId: parsed.data.draftId,
          activeVersionSequence: parsed.data.activeVersionSequence,
        }),
      );
    }
    console.info(JSON.stringify({ event: "sweeper.completed", requeued }));
  } finally {
    await database.close();
  }
}
```

Check that `createWorkerDatabase`'s return type (`Database` from `@wukong/db`) structurally satisfies `SweeperDatabase` — it will once Task 1 is merged, since `Database` gains `findStuckListingJobs` there. If TypeScript complains about `ScheduledController`/`ExecutionContext` not being in scope, they come from `@cloudflare/workers-types` the same way the other handler files get their ambient types — check how `worker-env.ts`/`ingress.ts` reference `Hyperdrive`/`ExecutionContext` and match that convention.

- [ ] **Step 4: Wire the handler and export**

In `apps/worker/src/cloudflare.ts` (whole file, currently 10 lines):

```ts
import type { QueueMessage } from "@wukong/jobs";

import { handleIngress } from "./ingress.js";
import { handleQueue } from "./queue-consumer.js";
import { handleScheduled } from "./sweeper.js";
import type { WorkerEnv } from "./worker-env.js";

export default {
  fetch: (request, env, context) => handleIngress(request, env, context),
  queue: (batch, env, context) => handleQueue(batch, env, context),
  scheduled: (controller, env, context) =>
    handleScheduled(controller, env, context),
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
```

In `apps/worker/src/index.ts`, add `export { handleScheduled } from "./sweeper.js";` alongside the existing handler exports (read the file to match its ordering/style).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wukong/worker test -- sweeper.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/worker test && pnpm --filter @wukong/worker lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/sweeper.ts apps/worker/src/sweeper.test.ts apps/worker/src/cloudflare.ts apps/worker/src/index.ts
git commit -m "feat(worker): add a cron sweeper that re-enqueues stuck listing jobs"
```

---

### Task 3: Cron trigger in the generated wrangler config + runbook

**Files:**

- Modify: `cloudflare-runtime.config.json`
- Modify: `scripts/render-cloudflare-config.mjs`
- Modify: `tests/cloudflare-config.test.mjs`
- Modify: `docs/runbooks/production-ai-runtime.md`

- [ ] **Step 1: Add the cron to the runtime config**

In `cloudflare-runtime.config.json`, add a top-level key after `"consumer"`:

```json
  "sweeper": {
    "cron": "*/5 * * * *"
  }
```

- [ ] **Step 2: Render it into the wrangler config**

In `scripts/render-cloudflare-config.mjs`, add to the `wrangler` object literal (after `queues`):

```js
  triggers: { crons: [source.sweeper.cron] },
```

- [ ] **Step 3: Update the config tests (they deep-equal both files' full shapes)**

In `tests/cloudflare-config.test.mjs`: (1) the assertion that deep-equals the parsed `cloudflare-runtime.config.json` must gain the `sweeper` key; (2) the assertion that deep-equals the entire rendered wrangler object must gain `triggers: { crons: ["*/5 * * * *"] }`. Read the file first — it pins the exact object at multiple points (~lines 60-79, 90-139) and any drift fails CI.

- [ ] **Step 4: Run the config tests**

Run: `node --test tests/cloudflare-config.test.mjs`
Expected: PASS. Also run `node --test tests/ci-workflow.test.mjs` — it must still pass untouched (nothing in this task changes deploy-script ordering or waivers).

- [ ] **Step 5: Render locally to prove the generated file is valid**

Run (from repo root):

```bash
CLOUDFLARE_ENV=production CLOUDFLARE_HYPERDRIVE_ID=placeholder0000000000000000000000 BUILD_SHA=local-check AI_PROVIDER=fake OPENAI_LISTING_MODEL=gpt-5 S3_BUCKET=wukong-opak-prod-assets S3_ENDPOINT=https://00000000000000000000000000000000.r2.cloudflarestorage.com S3_REGION=auto S3_FORCE_PATH_STYLE=false node scripts/render-cloudflare-config.mjs
```

Expected: exit 0; `.wrangler/wrangler.generated.jsonc` contains `"triggers": { "crons": ["*/5 * * * *"] }`.

- [ ] **Step 6: Document in the runbook**

In `docs/runbooks/production-ai-runtime.md`, add a short subsection (near the queue/consumer configuration docs) stating: the Worker runs a cron sweeper every 5 minutes (`triggers.crons` in the generated config) that re-enqueues stuck listing jobs found by `sweeper_find_stuck_listing_jobs` (migration `0007`); it needs no new secrets; the next `deploy:preview`/`deploy:production` automatically registers the cron trigger; and migration `0007` must be applied (`pnpm --filter @wukong/db db:migrate`) BEFORE deploying the Worker, or every sweep tick will error against the missing function. Match the runbook's existing tone and formatting.

- [ ] **Step 7: Full verification**

Run: `pnpm test && pnpm lint && node --test tests/cloudflare-config.test.mjs tests/ci-workflow.test.mjs && node scripts/check-runtime-format.mjs`
Expected: all pass, 0 format debt.

- [ ] **Step 8: Commit**

```bash
git add cloudflare-runtime.config.json scripts/render-cloudflare-config.mjs tests/cloudflare-config.test.mjs docs/runbooks/production-ai-runtime.md
git commit -m "ops: register the queue sweeper cron in the generated wrangler config"
```

---

## Verification

After all three tasks:

```bash
pnpm test
pnpm test:integration
pnpm lint
node --test tests/cloudflare-config.test.mjs tests/ci-workflow.test.mjs
node scripts/check-runtime-format.mjs
```

Expected: all green. Deployment sequence for the operator (documented in Task 3's runbook step): apply migration `0007` to production Neon first, then `pnpm --filter @wukong/worker deploy:production`. After deploy, a stuck listing (e.g. one showing `processing.state: "retry_required"`) should be picked up within ~10 minutes (one grace window + one cron tick) with a `sweeper.requeued` line in the Worker's observability logs.
