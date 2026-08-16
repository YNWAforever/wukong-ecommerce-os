# Bulk Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer select several flag-free `in_review` listings from the queue and approve them all in one action.

**Architecture:** Extract the existing single-listing approval logic into a shared function, add one new route that loops it sequentially with per-item results, extend the queue's read query with one batched flag-count join, and add the queue's first checkbox UI. No new domain state, no change to single-listing approval behavior.

**Tech Stack:** TypeScript 7 (5.9 in `apps/web`), Drizzle ORM, Postgres, Next.js App Router route handlers + client components, Vitest, zod v4.

---

## Prerequisites

Read `docs/superpowers/specs/2026-08-16-bulk-review-design.md` before starting. In particular:

- **`approveOne`'s extraction must be behavior-preserving.** Task 1's own existing test file (`approve/route.test.ts`) is the proof — it must pass unchanged against the refactored code.
- **Each listing approves in its own transaction, sequentially, not one transaction for the whole batch.** A stale flag on one listing must not roll back others.
- **No new audit action.** Each approval already writes its own `listing.approved` event through the reused logic.

### Local services

Postgres on port 54329 is needed for nothing in this plan — every task here is unit-tested against fakes, no integration test touches Postgres. Confirm `pnpm test` alone (no `test:integration`) is sufficient before starting.

## Hard constraints

- **Do not change `/listings/[id]`'s review screen, save/approve/flag-resolution logic, or which fields it shows.** Out of scope per the spec.
- **Do not add field-level or partial-within-a-listing approval state.** This plan is whole-listing batch approval only.
- **`approveOne`'s behavior for a single ID must be identical to today's `POST /api/listings/[id]/approve`.** Task 1 is a refactor, not a rewrite — every check, every error mapping, stays exactly as it is.

## File Structure

| File                                                        | Change     | Responsibility                                               |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `apps/web/lib/listing-approval.ts`                          | Create     | `approveOne`, extracted and shared by both routes            |
| `apps/web/app/api/listings/[id]/approve/route.ts`           | Modify     | Call the extracted `approveOne` instead of inline logic      |
| `apps/web/app/api/listings/[id]/approve/route.test.ts`      | Unmodified | Proves the extraction is behavior-preserving                 |
| `apps/web/app/api/listings/bulk-approve/route.ts`           | Create     | The new bulk endpoint                                        |
| `apps/web/app/api/listings/bulk-approve/route.test.ts`      | Create     | Unit tests against fakes                                     |
| `packages/db/src/repositories/listings.ts`                  | Modify     | `listRecent` gains `openBlockingFlagCount`                   |
| `packages/db/src/repositories/listings.integration.test.ts` | Modify     | Prove the flag-count join against real Postgres              |
| `apps/web/app/api/listings/route.ts`                        | Modify     | Surface `openBlockingFlagCount` in the GET response          |
| `apps/web/app/api/listings/route.list.test.ts`              | Modify     | Prove the new field is present                               |
| `apps/web/components/listing-view-models.ts`                | Modify     | `QueueItem` gains `openBlockingFlagCount`/`id` selectability |
| `apps/web/components/dashboard-listings-client.tsx`         | Modify     | Map the new field; own selection state; call bulk-approve    |
| `apps/web/components/dashboard-listings-client.test.ts`     | Create     | Unit test the mapping and selection logic                    |
| `apps/web/components/listing-queue.tsx`                     | Modify     | Checkboxes, select-all-eligible, bulk action bar             |
| `docs/runbooks/shopline-pilot-onboarding.md`                | Modify     | Document the flow and the 50-item cap                        |
| `CONTEXT.md`                                                | Modify     | Record the "bulk approve" domain term                        |

---

### Task 1: Extract `approveOne`

**Files:**

- Create: `apps/web/lib/listing-approval.ts`
- Modify: `apps/web/app/api/listings/[id]/approve/route.ts`
- Test: `apps/web/app/api/listings/[id]/approve/route.test.ts` (must pass unchanged — do not edit it in this task)

- [ ] **Step 1: Read both files in full**

Read `apps/web/app/api/listings/[id]/approve/route.ts` and `apps/web/app/api/listings/[id]/approve/route.test.ts` completely before editing. Confirm the current file matches what's quoted below — if a prior change on this branch has shifted it, adapt to the real current text.

- [ ] **Step 2: Create the shared module**

Create `apps/web/lib/listing-approval.ts`:

```ts
import {
  approveListing as domainApprove,
  type AuditContext,
} from "@wukong/core";

import { ApiError } from "./route-support";

export type ApproveOneDeps = {
  approve?: typeof domainApprove;
};

export type ApproveOneResult = {
  listingId: string;
  versionId: string;
  status: "approved";
};

/**
 * Approves one listing's active version. Extracted from the single-listing
 * approve route so the bulk-approve route can reuse the exact same checks —
 * `requireForPublish`, the target/activeVersion gate, the domain approval
 * call, the repository write, and the blocking-flags error mapping — without
 * duplicating them. Behavior for a single ID must stay identical to what
 * `POST /api/listings/[id]/approve` did before this extraction; that route's
 * own existing test file is the proof.
 */
export async function approveOne(
  id: string,
  auditContext: AuditContext,
  repositories: any,
  deps: ApproveOneDeps = {},
): Promise<ApproveOneResult> {
  let listing: any;
  try {
    listing = await repositories.listings.requireForPublish(id);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      throw new ApiError(404, "listing_not_found", "Listing not found.");
    }
    throw error;
  }
  if (listing.target !== "shopline" || !listing.activeVersion) {
    throw new ApiError(409, "approval_required", "可批准的版本不存在。");
  }
  try {
    const approved = await (deps.approve ?? domainApprove)(
      listing.activeVersion.id,
      listing.flags,
      auditContext,
      repositories.audit,
    );
    if (typeof repositories.listings.approve !== "function")
      throw new Error("listing approval repository is unavailable");
    await repositories.listings.approve(
      id,
      approved.versionId,
      auditContext,
      repositories.audit,
    );
    return {
      listingId: id,
      versionId: approved.versionId,
      status: approved.status as "approved",
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /blocking compliance flags/i.test(error.message)
    ) {
      throw new ApiError(
        422,
        "blocking_flags",
        "仍有未解決的合規標記，請先處理。",
      );
    }
    throw error;
  }
}
```

This is the exact body of the `try`/`catch` from `createApproveListingHandler`'s inner logic today, with `id`, `auditContext`, `repositories`, and `deps.approve` parameterized instead of closed over.

- [ ] **Step 3: Rewrite the single-listing route to call it**

Replace `apps/web/app/api/listings/[id]/approve/route.ts` in full:

```ts
import type { AuditContext } from "@wukong/core";
import { approveListing as domainApprove } from "@wukong/core";
import { z } from "zod";

import { approveOne } from "../../../../../lib/listing-approval";
import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ApprovalRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  approve?: typeof domainApprove;
};

const bodySchema = z.object({}).strip();

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

export function createApproveListingHandler(deps: ApprovalRouteDeps) {
  return async function approveListingHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      await bodySchema.parseAsync(await request.json().catch(() => ({})));
      const auditContext: AuditContext = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: id,
      };
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          approveOne(id, auditContext, repositories, { approve: deps.approve }),
        );
      return jsonResponse(200, result);
    });
  };
}

export const POST = createApproveListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

The only behavioral surface is `createApproveListingHandler`'s exported shape (unchanged: same `ApprovalRouteDeps`, same `approve?` override for tests) — everything the route did inline now happens inside `approveOne`.

- [ ] **Step 4: Run the existing test file unchanged**

```bash
cd apps/web && npx vitest run "app/api/listings/[id]/approve/route.test.ts"
```

Expected: PASS, all 3 pre-existing tests, with zero edits to the test file. This is the proof the extraction preserved behavior — if any test fails, the refactor introduced a real behavior change and must be fixed before continuing, not worked around by editing the test.

- [ ] **Step 5: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write apps/web/lib/listing-approval.ts "apps/web/app/api/listings/[id]/approve/route.ts"
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/listing-approval.ts "apps/web/app/api/listings/[id]/approve/route.ts"
git commit -m "refactor(web): extract single-listing approval for reuse"
```

---

### Task 2: The bulk-approve route

**Files:**

- Create: `apps/web/app/api/listings/bulk-approve/route.ts`
- Test: `apps/web/app/api/listings/bulk-approve/route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/app/api/listings/bulk-approve/route.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createBulkApproveHandler } from "./route.js";

const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

function request(listingIds: string[]) {
  return new Request("http://localhost/api/listings/bulk-approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ listingIds }),
  });
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin";
    flaggedIds?: string[];
  } = {},
) {
  const approved: string[] = [];
  const flagged = new Set(options.flaggedIds ?? []);
  const handler = createBulkApproveHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "reviewer" };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: any) => Promise<T>,
        ) {
          return work({
            listings: {
              async requireForPublish(id: string) {
                return {
                  id,
                  target: "shopline",
                  status: "in_review",
                  activeVersion: {
                    id: `${id}-v1`,
                    sequence: 1,
                    content: { sku: "OPAK-001" },
                  },
                  flags: flagged.has(id)
                    ? [
                        {
                          id: "flag_1",
                          field: "description",
                          rule: "health_claim",
                          severity: "blocking",
                          status: "open",
                          resolutionReason: null,
                        },
                      ]
                    : [],
                };
              },
              async approve(id: string) {
                approved.push(id);
              },
            },
            audit: { async write() {} },
          });
        },
      }) as never,
    approve: async (versionId: string, flags: any[]) => {
      const open = flags.some(
        (flag) => flag.severity === "blocking" && flag.status === "open",
      );
      if (open)
        throw new Error(
          "Blocking compliance flags must be resolved before approval",
        );
      return { versionId, status: "approved" as const };
    },
  });
  return { handler, approved };
}

const id1 = "00000000-0000-4000-8000-000000000101";
const id2 = "00000000-0000-4000-8000-000000000102";
const id3 = "00000000-0000-4000-8000-000000000103";

describe("POST /api/listings/bulk-approve", () => {
  it("rejects a viewer", async () => {
    const { handler } = makeHandler({ role: "viewer" });
    const response = await handler(request([id1]));
    expect(response.status).toBe(403);
  });

  it("rejects an empty list", async () => {
    const { handler } = makeHandler();
    const response = await handler(request([]));
    expect(response.status).toBe(400);
  });

  it("rejects more than 50 ids", async () => {
    const { handler } = makeHandler();
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const response = await handler(request(ids));
    expect(response.status).toBe(400);
  });

  it("approves every eligible listing and reports each flagged one as failed, in one 200", async () => {
    const { handler, approved } = makeHandler({ flaggedIds: [id2] });
    const response = await handler(request([id1, id2, id3]));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.approved).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results).toEqual([
      { listingId: id1, ok: true, versionId: `${id1}-v1` },
      {
        listingId: id2,
        ok: false,
        code: "blocking_flags",
        message: expect.any(String),
      },
      { listingId: id3, ok: true, versionId: `${id3}-v1` },
    ]);
    expect(approved).toEqual([id1, id3]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run "app/api/listings/bulk-approve/route.test.ts"
```

Expected: FAIL — the route module doesn't exist yet.

- [ ] **Step 3: Implement the route**

Create `apps/web/app/api/listings/bulk-approve/route.ts`:

```ts
import type { approveListing as domainApprove } from "@wukong/core";
import { z } from "zod";

import { approveOne } from "../../../../lib/listing-approval";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

/**
 * 50 is a starting bound, not a load-bearing one — see the design spec's
 * open questions. Chosen to keep a worst-case sequential loop comfortably
 * sub-second; a client selecting more than this chunks into multiple
 * requests rather than the server accepting an unbounded list.
 */
const MAX_BULK_APPROVE_IDS = 50;

const bodySchema = z.object({
  listingIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_APPROVE_IDS),
});

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

export type BulkApproveItemResult =
  | { listingId: string; ok: true; versionId: string }
  | { listingId: string; ok: false; code: string; message: string };

export type BulkApproveRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  approve?: typeof domainApprove;
};

export function createBulkApproveHandler(deps: BulkApproveRouteDeps) {
  return async function bulkApproveHandler(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const body = bodySchema.parse(await request.json());

      // Sequential, one transaction per listing — not one transaction for the
      // whole batch. A stale flag on one listing must approve the rest, not
      // roll them back; see the design spec's "Chosen design" section.
      const results: BulkApproveItemResult[] = [];
      for (const id of body.listingIds) {
        const auditContext = {
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          entityId: id,
        };
        try {
          const approved = await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, (repositories) =>
              approveOne(id, auditContext, repositories, {
                approve: deps.approve,
              }),
            );
          results.push({
            listingId: id,
            ok: true,
            versionId: approved.versionId,
          });
        } catch (error) {
          if (error instanceof ApiError) {
            results.push({
              listingId: id,
              ok: false,
              code: error.code,
              message: error.message,
            });
          } else {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            results.push({
              listingId: id,
              ok: false,
              code: "unknown_error",
              message,
            });
          }
        }
      }

      const approved = results.filter((result) => result.ok).length;
      return jsonResponse(200, {
        results,
        approved,
        failed: results.length - approved,
      });
    });
  };
}

export const POST = createBulkApproveHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

Before pasting, check `ApiError`'s exact shape in `apps/web/lib/route-support.ts` — the plan assumes it exposes `.code` and `.message` as readable properties (matching `new ApiError(status, code, message)`'s constructor per `CLAUDE.md`'s convention). If the property names differ, adjust `results.push({ ..., code: error.code, ... })` to match the real property names.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run "app/api/listings/bulk-approve/route.test.ts"
```

Expected: PASS, all 4 tests.

- [ ] **Step 5: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write apps/web/app/api/listings/bulk-approve/route.ts apps/web/app/api/listings/bulk-approve/route.test.ts
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/listings/bulk-approve/
git commit -m "feat(web): add a bulk-approve route"
```

---

### Task 3: Surface open blocking flag counts in the queue read path

**Files:**

- Modify: `packages/db/src/repositories/listings.ts`
- Test: `packages/db/src/repositories/listings.integration.test.ts`
- Modify: `apps/web/app/api/listings/route.ts`
- Test: `apps/web/app/api/listings/route.list.test.ts`

- [ ] **Step 1: Write the failing integration test**

Read `packages/db/src/repositories/listings.integration.test.ts` first to find its `describe` block and how it creates a workspace/listing/version/flags, so the new test reuses that setup rather than inventing a new one. Append:

```ts
it("counts only open blocking flags on the active version, per listing", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const clean = await repositories.listings.create({ target: "shopline" });
    const flagged = await repositories.listings.create({ target: "shopline" });

    const cleanVersion = await repositories.listings.appendVersion(
      clean.id,
      content,
      auditContext(clean.id),
      repositories.audit,
    );
    const flaggedVersion = await repositories.listings.appendVersion(
      flagged.id,
      content,
      auditContext(flagged.id),
      repositories.audit,
    );
    await repositories.listings.replaceFlags(flaggedVersion.id, [
      {
        id: "flag_1",
        field: "description",
        rule: "health_claim",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      },
      // A resolved blocking flag and an open warning must not count.
      {
        id: "flag_2",
        field: "description",
        rule: "guarantee",
        severity: "blocking",
        status: "resolved",
        resolutionReason: "checked with legal",
      },
    ]);

    const items = await repositories.listings.listRecent(100);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(clean.id)?.openBlockingFlagCount).toBe(0);
    expect(byId.get(flagged.id)?.openBlockingFlagCount).toBe(1);
  });
});
```

Check the file's actual `content`/`auditContext` helper names before pasting — if it already has fixtures with different names, reuse those instead of introducing new ones.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/listings.integration.test.ts
```

Expected: FAIL — TypeScript reports `openBlockingFlagCount` does not exist on the type `listRecent` returns.

- [ ] **Step 3: Add the field to `ListingSummary` and the query**

In `packages/db/src/repositories/listings.ts`, add `sql` to the existing drizzle import:

```ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
```

Find:

```ts
export type ListingSummary = Listing & {
  activeVersion: { id: string; content: CanonicalListing } | null;
};
```

Replace with:

```ts
export type ListingSummary = Listing & {
  activeVersion: { id: string; content: CanonicalListing } | null;
  /**
   * Open, blocking-severity compliance flags on the active version. A listing
   * is bulk-approvable exactly when this is 0 and status is `in_review` — the
   * same condition `approveListing` already enforces one listing at a time.
   * 0 for a listing with no active version.
   */
  openBlockingFlagCount: number;
};
```

Find `listRecent`'s implementation and replace it in full:

```ts
    async listRecent(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("listing limit must be between 1 and 100");
      }
      const rows = await transaction
        .select({
          listing: listingDrafts,
          activeVersion: {
            id: listingVersions.id,
            content: listingVersions.content,
          },
        })
        .from(listingDrafts)
        .leftJoin(
          listingVersions,
          and(
            eq(listingVersions.workspaceId, workspaceId),
            eq(listingVersions.id, listingDrafts.activeVersionId),
          ),
        )
        .where(eq(listingDrafts.workspaceId, workspaceId))
        .orderBy(desc(listingDrafts.updatedAt))
        .limit(limit);

      const activeVersionIds = rows
        .map((row) => row.activeVersion?.id)
        .filter((id): id is string => id !== undefined);
      // One batched query for every returned listing's flag count, not one
      // query per listing — listRecent already bounds the result to at most
      // 100 rows, so this is at most one extra round trip regardless of how
      // many of them have an active version.
      const flagCounts =
        activeVersionIds.length > 0
          ? await transaction
              .select({
                versionId: complianceFlags.listingVersionId,
                count: sql<number>`count(*)::int`,
              })
              .from(complianceFlags)
              .where(
                and(
                  eq(complianceFlags.workspaceId, workspaceId),
                  inArray(complianceFlags.listingVersionId, activeVersionIds),
                  eq(complianceFlags.status, "open"),
                  eq(complianceFlags.severity, "blocking"),
                ),
              )
              .groupBy(complianceFlags.listingVersionId)
          : [];
      const flagCountByVersionId = new Map(
        flagCounts.map((row) => [row.versionId, row.count]),
      );

      return rows.map(({ listing, activeVersion }) => {
        const parsed = activeVersion?.id
          ? canonicalListingSchema.safeParse(activeVersion.content)
          : null;
        return {
          ...listing,
          activeVersion: parsed?.success
            ? { id: activeVersion!.id, content: parsed.data }
            : null,
          openBlockingFlagCount: activeVersion?.id
            ? (flagCountByVersionId.get(activeVersion.id) ?? 0)
            : 0,
        };
      });
    },
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong" npx vitest run src/repositories/listings.integration.test.ts
```

Expected: PASS, every test in the file.

- [ ] **Step 5: Surface the field in the GET route**

Read `apps/web/app/api/listings/route.ts`'s `createListListingsHandler` first (the item-mapping code inside `items.map((item) => {...})`). Add `openBlockingFlagCount: item.openBlockingFlagCount,` to the returned object literal, alongside the existing `id`, `status`, `target`, `title`, `sku`, `updatedAt` fields.

- [ ] **Step 6: Write the failing test for the route, then make it pass**

Read `apps/web/app/api/listings/route.list.test.ts` first to find its existing fake-repository shape. Add `openBlockingFlagCount` to whatever fake `listRecent` response it already constructs, and add one assertion that the GET response includes it:

```ts
it("includes the open blocking flag count for each listing", async () => {
  // Reuse this file's existing handler-construction helper, adding
  // openBlockingFlagCount: 2 to its fake listRecent() item.
  // ... (match this file's actual existing test-setup pattern)
  const response = await handler();
  const body = await response.json();
  expect(body.items[0]).toMatchObject({ openBlockingFlagCount: 2 });
});
```

Run:

```bash
cd apps/web && npx vitest run "app/api/listings/route.list.test.ts"
```

Expected: PASS after Step 5's edit.

- [ ] **Step 7: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write packages/db/src/repositories/listings.ts packages/db/src/repositories/listings.integration.test.ts apps/web/app/api/listings/route.ts apps/web/app/api/listings/route.list.test.ts
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/repositories/listings.ts packages/db/src/repositories/listings.integration.test.ts apps/web/app/api/listings/route.ts apps/web/app/api/listings/route.list.test.ts
git commit -m "feat(db): surface open blocking flag counts in the listing queue"
```

---

### Task 4: Multi-select UI

**Files:**

- Modify: `apps/web/components/listing-view-models.ts`
- Modify: `apps/web/components/dashboard-listings-client.tsx`
- Test: `apps/web/components/dashboard-listings-client.test.ts` (create)
- Modify: `apps/web/components/listing-queue.tsx`

- [ ] **Step 1: Add the field to `QueueItem` and `ListingCollectionItem`**

In `apps/web/components/listing-view-models.ts`, find:

```ts
export type QueueItem = {
  id: string;
  title: string;
  subtitle: string;
  status: QueueStatus;
  updatedAt: string;
  nextAction: string;
};
```

Replace with:

```ts
export type QueueItem = {
  id: string;
  title: string;
  subtitle: string;
  status: QueueStatus;
  updatedAt: string;
  nextAction: string;
  /** 0 means eligible for bulk approval when status is "in_review". */
  openBlockingFlagCount: number;
};
```

In `apps/web/components/dashboard-listings-client.tsx`, find:

```ts
export type ListingCollectionItem = {
  id: string;
  status: ListingStatus;
  target: "shopline";
  title: string;
  sku: string | null;
  updatedAt: string;
};
```

Replace with:

```ts
export type ListingCollectionItem = {
  id: string;
  status: ListingStatus;
  target: "shopline";
  title: string;
  sku: string | null;
  updatedAt: string;
  openBlockingFlagCount: number;
};
```

Find `mapDashboardItems` and add `openBlockingFlagCount: item.openBlockingFlagCount,` to the object literal it returns.

- [ ] **Step 2: Write the failing test for selection + bulk-approve wiring**

Create `apps/web/components/dashboard-listings-client.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { mapDashboardItems } from "./dashboard-listings-client";

const baseItem = {
  id: "listing_1",
  status: "in_review" as const,
  target: "shopline" as const,
  title: "Demo Wine",
  sku: "OPAK-001",
  updatedAt: "2026-08-16T00:00:00.000Z",
  openBlockingFlagCount: 0,
};

describe("mapDashboardItems", () => {
  it("carries openBlockingFlagCount through to the queue item", () => {
    const [item] = mapDashboardItems([
      { ...baseItem, openBlockingFlagCount: 2 },
    ]);
    expect(item?.openBlockingFlagCount).toBe(2);
  });

  it("carries a zero count through unchanged", () => {
    const [item] = mapDashboardItems([baseItem]);
    expect(item?.openBlockingFlagCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/web && npx vitest run components/dashboard-listings-client.test.ts
```

Expected: FAIL — `openBlockingFlagCount` is `undefined` since `mapDashboardItems` doesn't map it yet (Step 1 of this task should already have added it — if you did Step 1 first, this will actually pass immediately; if so, that's fine, it's still the correct regression test going forward, just run it to confirm PASS rather than expecting a FAIL).

- [ ] **Step 4: Add selection state and bulk-approve wiring to `DashboardListingsClient`**

In `apps/web/components/dashboard-listings-client.tsx`, replace the whole `DashboardListingsClient` function:

```ts
export function DashboardListingsClient() {
  const [items, setItems] = useState<ListingCollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<{
    results: Array<
      | { listingId: string; ok: true; versionId: string }
      | { listingId: string; ok: false; code: string; message: string }
    >;
    approved: number;
    failed: number;
  } | null>(null);
  const [bulkPending, setBulkPending] = useState(false);

  const load = () => {
    const controller = new AbortController();
    fetch("/api/listings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Unable to load listings (${response.status})`);
        const body = (await response.json()) as {
          items: ListingCollectionItem[];
        };
        setItems(body.items);
      })
      .catch((loadError: unknown) => {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        )
          return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load listings",
        );
      });
    return controller;
  };

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllEligible = (eligibleIds: string[]) => {
    setSelected(new Set(eligibleIds.slice(0, 50)));
  };

  const clearSelection = () => setSelected(new Set());

  const runBulkApprove = async () => {
    setBulkPending(true);
    setBulkResult(null);
    try {
      const response = await fetch("/api/listings/bulk-approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingIds: [...selected] }),
      });
      const body = await response.json();
      setBulkResult(body);
      setSelected(new Set());
      load();
    } finally {
      setBulkPending(false);
    }
  };

  if (error)
    return (
      <p className="inline-warning" role="alert">
        {error}
      </p>
    );
  if (!items)
    return (
      <p className="helper-copy" role="status">
        正在載入工作佇列… Loading work queue…
      </p>
    );

  const metrics = dashboardMetrics(items);
  const queueItems = mapDashboardItems(items);
  const eligibleIds = items
    .filter((item) => item.status === "in_review" && item.openBlockingFlagCount === 0)
    .map((item) => item.id);

  return (
    <>
      <div className="metric-strip" aria-label="工作台摘要">
        <div>
          <span className="metric-value">{metrics.active}</span>
          <span className="metric-label">
            進行中 <small>Active</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.inReview}</span>
          <span className="metric-label">
            待你審核 <small>Needs review</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.blocked}</span>
          <span className="metric-label">
            阻塞上架 <small>Blocked delivery</small>
          </span>
        </div>
      </div>
      {selected.size > 0 ? (
        <div className="bulk-action-bar" role="region" aria-label="批量操作">
          <span>{selected.size} 個項目已選取 · {selected.size} selected</span>
          <button type="button" onClick={runBulkApprove} disabled={bulkPending}>
            {bulkPending ? "批准中… Approving…" : `批准 ${selected.size} 個上架項目`}
          </button>
          <button type="button" className="secondary-button" onClick={clearSelection}>
            清除選取 Clear selection
          </button>
        </div>
      ) : null}
      {bulkResult ? (
        <ul className="bulk-result-list" aria-live="polite">
          {bulkResult.results.map((result) =>
            result.ok ? (
              <li key={result.listingId}>✓ {result.listingId}</li>
            ) : (
              <li key={result.listingId}>✗ {result.listingId}: {result.message}</li>
            ),
          )}
        </ul>
      ) : null}
      <ListingQueue
        items={queueItems}
        selected={selected}
        eligibleIds={eligibleIds}
        onToggle={toggleSelected}
        onSelectAllEligible={() => selectAllEligible(eligibleIds)}
      />
    </>
  );
}
```

- [ ] **Step 5: Add checkboxes to `ListingQueue`**

Replace `apps/web/components/listing-queue.tsx` in full:

```tsx
import Link from "next/link";

import { queueGroups, type QueueItem } from "./listing-view-models";

type ListingQueueProps = {
  items: QueueItem[];
  selected: Set<string>;
  eligibleIds: string[];
  onToggle: (id: string) => void;
  onSelectAllEligible: () => void;
};

export function ListingQueue({
  items,
  selected,
  eligibleIds,
  onToggle,
  onSelectAllEligible,
}: ListingQueueProps) {
  const eligibleSet = new Set(eligibleIds);
  return (
    <section className="queue" aria-labelledby="queue-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            工作佇列 <span>WORK QUEUE</span>
          </p>
          <h2 id="queue-heading">下一步工作</h2>
        </div>
        <Link className="text-link" href="/listings/new">
          建立上架草稿<span aria-hidden="true"> →</span>
        </Link>
      </div>
      <div className="queue-groups">
        {queueGroups.map((group) => {
          const groupItems = items.filter(
            (item) => item.status === group.status,
          );
          const groupEligibleCount = groupItems.filter((item) =>
            eligibleSet.has(item.id),
          ).length;
          return (
            <section
              className="queue-group"
              key={group.status}
              aria-labelledby={`queue-${group.status}`}
            >
              <div className="queue-group-heading">
                <div>
                  <h3 id={`queue-${group.status}`}>{group.label}</h3>
                  <p>{group.englishLabel}</p>
                </div>
                {group.status === "in_review" && groupEligibleCount > 0 ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={onSelectAllEligible}
                  >
                    全選可批准項目 Select all eligible
                  </button>
                ) : null}
                <span
                  className="count-badge"
                  aria-label={`${groupItems.length} items`}
                >
                  {groupItems.length}
                </span>
              </div>
              {groupItems.length > 0 ? (
                <ul className="queue-list">
                  {groupItems.map((item) => {
                    const eligible = eligibleSet.has(item.id);
                    return (
                      <li key={item.id} className="queue-item">
                        {item.status === "in_review" ? (
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            disabled={!eligible}
                            aria-label={
                              eligible
                                ? `選取 ${item.title}`
                                : `${item.openBlockingFlagCount} 個未解決的合規標記`
                            }
                            title={
                              eligible
                                ? undefined
                                : `${item.openBlockingFlagCount} 個未解決的合規標記 · ${item.openBlockingFlagCount} unresolved compliance flags`
                            }
                            onChange={() => onToggle(item.id)}
                          />
                        ) : null}
                        <div>
                          <Link
                            className="queue-item-title"
                            href={`/listings/${item.id}`}
                          >
                            {item.title}
                          </Link>
                          <p>{item.subtitle}</p>
                          <time dateTime={item.updatedAt}>
                            {item.updatedAt}
                          </time>
                        </div>
                        <Link
                          className="secondary-button queue-action"
                          href={`/listings/${item.id}`}
                        >
                          {item.nextAction}
                          <span aria-hidden="true"> →</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty-state">
                  目前沒有項目 <span>No items</span>
                </p>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Run the full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: PASS, every test file, including the new one and every pre-existing one — this is the first point any existing `ListingQueue` consumer (if any test renders it directly) sees the widened prop signature.

- [ ] **Step 7: Typecheck and format**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
npx prettier --write apps/web/components/listing-view-models.ts apps/web/components/dashboard-listings-client.tsx apps/web/components/dashboard-listings-client.test.ts apps/web/components/listing-queue.tsx
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/listing-view-models.ts apps/web/components/dashboard-listings-client.tsx apps/web/components/dashboard-listings-client.test.ts apps/web/components/listing-queue.tsx
git commit -m "feat(web): add multi-select bulk approval to the listing queue"
```

---

### Task 5: Runbook, domain context, and full verification

**Files:**

- Modify: `docs/runbooks/shopline-pilot-onboarding.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Document the flow**

Read `docs/runbooks/shopline-pilot-onboarding.md` in full, find its last numbered section (§6, added by the bulk-form-export plan), and append a new §7:

```markdown
## 7. Approving many listings at once

From the dashboard's work queue, an `in_review` listing with no open blocking
compliance flags can be selected via its checkbox. "Select all eligible"
selects every flag-free `in_review` listing currently loaded, up to 50 at a
time — the API refuses more than 50 IDs in one request. Selecting more than
50 requires approving in batches.

Approving a selection calls the same single-listing approval logic once per
listing, sequentially, each in its own transaction. A listing whose flags
changed since the queue last loaded (for example, a compliance re-scan
opened a new flag between page load and clicking approve) fails on its own
without blocking the rest of the batch — the result list shows exactly which
listings succeeded and which didn't, and why.

Nothing about single-listing review changes: this is a faster way to approve
many already-eligible listings, not a new kind of approval.
```

- [ ] **Step 2: Record the domain term**

In `CONTEXT.md`, add a new section after the existing ones:

```markdown
## Bulk approve

Bulk approve lets a reviewer select several `in_review` listings with no open
blocking compliance flags and approve them in one action. It is not a new
kind of approval — each selected listing goes through the exact same
single-listing approval logic, once per listing, in its own transaction, so
one listing's stale flag cannot roll back another's legitimate approval.
There is no field-level or partial-within-a-listing approval anywhere in the
system; approval is still whole-listing, all-or-nothing.
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md CONTEXT.md
git commit -m "docs: describe bulk approve and its per-item failure semantics"
```

- [ ] **Step 4: Run the full gate**

```bash
pnpm lint
```

Expected: 14/14 tasks successful.

```bash
pnpm test
```

Expected: 14/14 tasks successful.

```bash
pnpm test:integration
```

Expected: PASS, including Task 3's new integration test. Needs the Postgres container from Prerequisites.

```bash
pnpm format:runtime:check
```

Expected: exit 0, `hash-pinned format debt waived: 0`.

---

## Out of scope

Named so a reviewer does not read their absence as an oversight:

- **Field-level or partial-within-a-listing approval.** The roadmap note's literal reading. A separate, much larger spec — see the design spec's follow-ups.
- **Bulk delivery** (CSV export or SHOPLINE publish for many listings at once). Named as a plausible follow-on in the design spec, not attempted here.
- **New compliance-flag severity tiers or detection rules.** Eligibility uses exactly the `open`/`blocking` data that exists today.
- **Changing which fields the single-listing review screen shows or edits.** SEO/tags fields remain absent from that screen; unrelated to this feature.
- **A batch-level audit event.** Each approval already writes its own `listing.approved` event; no new domain mutation is introduced.
