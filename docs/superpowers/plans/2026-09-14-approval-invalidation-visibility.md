# Approval Invalidation Visibility (W7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every approval invalidation visible as a named audit event: a confirmation change that reopens a listing, and a re-import that breaks an approval's source binding. Surface it in the activity panel, /jobs metrics, the import panel, and the review page and queue.

**Architecture:** One new audit action, `listing.approval_invalidated`, with a `cause` in its metadata.
- The listings repository writes it where it already reopens on a confirmation change.
- The bulk-form importer writes it for each affected listing, without changing status.
- /jobs counts it by `cause` with the existing `countByActionAndMetadataKeySince`.
- UI components render labels from copy maps, and the review page stops masking `reopened` as `in_review`.
- No migration.

**Tech Stack:** pnpm 11.7 (via `corepack pnpm`), Next.js 16 App Router, React 19, Drizzle ORM + Postgres, Vitest (happy-dom for components), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-approval-invalidation-visibility-design.md`

---

## Ground rules for every task

- **Working directory:** run commands from the worktree root, `C:\Users\laich\Documents\WukongEommerce\.claude\worktrees\wukong-ecommerce-implementation-ff6145`.
- **pnpm and turbo:** `pnpm` is not on PATH; use `corepack pnpm`. Turbo needs `export PATH="$PATH:/c/Users/laich/AppData/Local/Temp/claude/pnpm-shim"` in Git Bash.
- **Typechecking:** Vitest does not typecheck. `corepack pnpm lint` runs `tsc --noEmit` and must pass before each commit.
- **Package builds:** after changing `packages/core` or `packages/db`, run `corepack pnpm --filter @wukong/core build` / `--filter @wukong/db build` before testing `apps/web`, which consumes their built output.
- **Audit metadata:** identifiers and counts only. Never content, digests or prompts.
- **Commits:** lowercase conventional (`feat:`, `test:`, `docs:`), ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Staging:** never `git add -A`; add the exact files listed.
- **Out of bounds:** do not change `transitionListing`, the eligibility checks, approval receipts, `REQUIRED_AUDIT_SEQUENCE` or the schema.

**Integration env** (for `corepack pnpm test:integration`, which uses the root `vitest.integration.config.ts`):
- `TEST_DATABASE_ADMIN_URL=postgres://wukong:wukong@localhost:54329/wukong`
- `TEST_DATABASE_URL=postgres://wukong_app:wukong-app-local@localhost:54329/wukong`
- `DATABASE_ADMIN_URL` and `DATABASE_URL` take the same two values.
- `S3_BUCKET=wukong-local`
- `S3_ENDPOINT=http://127.0.0.1:9010`

Services: `docker compose up -d postgres minio minio-tls mailpit`.

## File map

| File | Responsibility | Task |
|---|---|---|
| `docs/superpowers/specs/2026-09-14-approval-invalidation-visibility-design.md` | Corrections found while planning | 1 |
| `packages/core/src/approval-invalidation.ts` (new) + test | The action name and cause union, shared by db and web | 2 |
| `packages/core/src/index.ts` | Export it | 2 |
| `packages/db/src/repositories/listings.ts` | `approvalStatesByIds`; event on the reopen branch | 3 |
| `packages/db/src/repositories/listings-edit-review.integration.test.ts` | Postgres coverage | 3 |
| `apps/web/lib/bulk-form-import.ts` + test | Re-import events, `invalidatedApprovals` | 4 |
| `apps/web/app/api/listings/import/route.ts` + test | Echo the count | 5 |
| `apps/web/components/bulk-import-panel.tsx` + tests | Show the count and guidance | 5 |
| `apps/web/app/api/jobs/route.ts` + test | `metrics.approvalInvalidations` | 6 |
| `apps/web/components/jobs-ledger-client.tsx` + test | Two tiles | 6 |
| `apps/web/components/activity-panel.tsx` + test | Label and cause | 7 |
| `apps/web/components/listing-view-models.ts` | Widen review status; `QueueItem.reopened` | 8, 9 |
| `apps/web/components/listing-review-client.tsx` + test | Stop masking `reopened` | 8 |
| `apps/web/components/listing-fields-form.tsx` + test | Keep reopened listings approvable | 8 |
| `apps/web/app/globals.css` | Badge colour for `status-reopened`, `.status-tag` | 8, 9 |
| `apps/web/lib/dashboard-queue-shared.ts`, `apps/web/components/listing-queue.tsx` + tests | Reopened tag | 9 |
| `tests/e2e/bulk-update-pilot.spec.ts` | Acceptance journey | 10 |
| `docs/superpowers/plans/2026-09-11-release-gate-closure.md` | Close W7 | 11 |

---

### Task 1: Record the spec corrections found while planning

Three facts found while planning change the spec:
- **Read name.** `ListingRepository` already has `statusesByIds` (`listings.ts:66`), so the new read is named `approvalStatesByIds`.
- **Approval button.** `listing-fields-form.tsx:135` disables approval unless `model.status === "in_review"`. Unmasking `reopened` would silently make reopened listings unapprovable. The approve path accepts `reopened` (`listings.ts:653`), so the form must accept it too.
- **Test coverage.** No integration harness exists for the bulk-form importer. The "status stays `approved` and eligibility refuses it" check therefore moves to the real-stack E2E (Task 10).

**Files:**
- Modify: `docs/superpowers/specs/2026-09-14-approval-invalidation-visibility-design.md`

- [ ] **Step 1: Rename the read in the spec**

In section "2. Write sites", replace:

```
**Re-import.** Before the row loop, the importer calls a new narrow read,
`listings.getStatusesByIds(ids)`, which returns `{ id, status, activeVersionId }[]` and is
workspace-scoped. `getByIds` is not reused because it loads version content.
```

with:

```
**Re-import.** Before the row loop, the importer calls a new narrow read,
`listings.approvalStatesByIds(ids)`, which returns `Record<id, { status, activeVersionId }>` and
is workspace-scoped. It sits beside the existing `statusesByIds`, which omits `activeVersionId`
(needed for the event's `versionId`). `getByIds` is not reused because it loads version content.
```

In "Testing → Integration", replace `` `getStatusesByIds` `` with `` `approvalStatesByIds` ``, and replace the line beginning "Re-importing an approved listing records the event" with:

```
- Re-importing an approved listing records the event, keeps `approved`, and the catalog shows it
  as not exportable: covered by the real-stack Playwright journey, as no importer integration
  harness exists.
```

- [ ] **Step 2: Append a corrections section at the end of the spec**

```markdown
## Corrections found while planning

1. **Read name.** `statusesByIds` already exists on `ListingRepository`, so the new read is
   `approvalStatesByIds`, not `getStatusesByIds`.
2. **Approval must accept `reopened`.** `listing-fields-form.tsx` disabled approval unless the
   review status was `in_review`, which worked for reopened listings only because they were
   masked. Unmasking therefore also changes that condition to accept `reopened`. The approve path
   already handles it (`listings.ts:653`). Without this, unmasking would lock every reopened
   listing.
3. **Re-import against the real gate.** No integration harness exists for the bulk-form importer,
   so that check is part of the real-stack Playwright journey.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-14-approval-invalidation-visibility-design.md
git commit -m "docs: record the W7 corrections found while planning

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared action name and cause union

**Files:**
- Create: `packages/core/src/approval-invalidation.ts`
- Create: `packages/core/src/approval-invalidation.test.ts`
- Modify: `packages/core/src/index.ts` (named exports, next to `export { transitionListing } from "./workflow.js";` at `:35`)

- [ ] **Step 1: Write the failing test**

`packages/core/src/approval-invalidation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  APPROVAL_INVALIDATED_ACTION,
  APPROVAL_INVALIDATION_CAUSES,
  isApprovalInvalidationCause,
} from "./approval-invalidation.js";

describe("approval invalidation vocabulary", () => {
  it("names the audit action", () => {
    expect(APPROVAL_INVALIDATED_ACTION).toBe("listing.approval_invalidated");
  });

  it("lists exactly the three causes", () => {
    expect([...APPROVAL_INVALIDATION_CAUSES]).toEqual([
      "confirmation_changed",
      "source_reimported_changed",
      "source_reimported_unchanged",
    ]);
  });

  it("recognises only known causes", () => {
    expect(isApprovalInvalidationCause("confirmation_changed")).toBe(true);
    expect(isApprovalInvalidationCause("something_else")).toBe(false);
    expect(isApprovalInvalidationCause(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm failure**

Run: `corepack pnpm --filter @wukong/core exec vitest run src/approval-invalidation.test.ts`
Expected: FAIL, because `./approval-invalidation.js` cannot be resolved.

- [ ] **Step 3: Implement**

`packages/core/src/approval-invalidation.ts`:

```ts
/**
 * An approval stops holding when its confirmations change or when a re-import
 * replaces the source import its receipt was bound to. Both are recorded under
 * one action so /jobs can count them together and split them by cause.
 */
export const APPROVAL_INVALIDATED_ACTION = "listing.approval_invalidated";

export const APPROVAL_INVALIDATION_CAUSES = [
  "confirmation_changed",
  "source_reimported_changed",
  "source_reimported_unchanged",
] as const;

export type ApprovalInvalidationCause =
  (typeof APPROVAL_INVALIDATION_CAUSES)[number];

export function isApprovalInvalidationCause(
  value: unknown,
): value is ApprovalInvalidationCause {
  return (
    typeof value === "string" &&
    (APPROVAL_INVALIDATION_CAUSES as readonly string[]).includes(value)
  );
}
```

In `packages/core/src/index.ts`, directly after line 36 (`export type { ListingAction, ListingStatus } from "./workflow.js";`), add:

```ts

export {
  APPROVAL_INVALIDATED_ACTION,
  APPROVAL_INVALIDATION_CAUSES,
  isApprovalInvalidationCause,
} from "./approval-invalidation.js";
export type { ApprovalInvalidationCause } from "./approval-invalidation.js";
```

- [ ] **Step 4: Test, build, lint**

Run: `corepack pnpm --filter @wukong/core exec vitest run src/approval-invalidation.test.ts`. Expected: PASS (3 tests).
Run: `corepack pnpm --filter @wukong/core build`. Expected: exit 0.
Run: `corepack pnpm lint`. Expected: all tasks successful.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/approval-invalidation.ts packages/core/src/approval-invalidation.test.ts packages/core/src/index.ts
git commit -m "feat: name the approval invalidation action and its causes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Repository read and the confirmation-change event

**Files:**
- Modify: `packages/db/src/repositories/listings.ts` (import `:14`; interface after `:66`; implementation after `statusesByIds` ending `:361`; `invalidateApprovalForConfirmationChange` `:788-790`)
- Modify: `packages/db/src/repositories/listings-edit-review.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

In `listings-edit-review.integration.test.ts`, add inside the `describe`, directly after the `contextFor` definition:

```ts
  const invalidationEvents = async (listingId: string) =>
    (
      await admin<{ action: string; metadata: Record<string, unknown> }[]>`
        select action, metadata from audit_events
        where workspace_id = ${workspaceId} and entity_id = ${listingId}
        order by created_at, id`
    ).map((row) => ({ action: row.action, metadata: row.metadata }));
```

Replace the whole `it.each(["approved", "published", "publish_failed"])(…)` block ("reopens %s when its current confirmation ledger changes") with:

```ts
  it.each(["approved", "published", "publish_failed"])(
    "reopens %s when its current confirmation ledger changes, and records why",
    async (status) => {
      const { listingId, versionId } = await seedListing(status);
      const result = await forWorkspace(database, workspaceId, (repos) =>
        repos.listings.invalidateApprovalForConfirmationChange(
          listingId,
          versionId,
          contextFor(listingId),
          repos.audit,
        ),
      );
      const after = await forWorkspace(database, workspaceId, (repos) =>
        repos.listings.getById(listingId),
      );
      expect(result).toBe("reopened");
      expect(after?.status).toBe("reopened");
      expect(after?.activeVersionId).toBe(versionId);
      const events = await invalidationEvents(listingId);
      const transitionAt = events.findIndex(
        (row) => row.action === "listing.transition",
      );
      const invalidationAt = events.findIndex(
        (row) => row.action === "listing.approval_invalidated",
      );
      expect(transitionAt).toBeGreaterThanOrEqual(0);
      expect(invalidationAt).toBeGreaterThan(transitionAt);
      expect(events[invalidationAt]!.metadata).toEqual({
        cause: "confirmation_changed",
        fromStatus: status,
        versionId,
      });
    },
  );
```

In "fails closed while publishing and keeps the in-flight status", add after `expect(after?.status).toBe("publishing");`:

```ts
    expect(
      (await invalidationEvents(listingId)).filter(
        (row) => row.action === "listing.approval_invalidated",
      ),
    ).toEqual([]);
```

Add a new test at the end of the `describe`:

```ts
  it("reads approval states for exactly the requested listings in this workspace", async () => {
    const approved = await seedListing("approved");
    const inReview = await seedListing("in_review");

    const states = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.approvalStatesByIds([
        approved.listingId,
        inReview.listingId,
      ]),
    );
    expect(states).toEqual({
      [approved.listingId]: {
        status: "approved",
        activeVersionId: approved.versionId,
      },
      [inReview.listingId]: {
        status: "in_review",
        activeVersionId: inReview.versionId,
      },
    });
    expect(
      await forWorkspace(database, workspaceId, (repos) =>
        repos.listings.approvalStatesByIds([]),
      ),
    ).toEqual({});
    expect(
      await forWorkspace(database, "ws_edit_review_foreign", (repos) =>
        repos.listings.approvalStatesByIds([approved.listingId]),
      ),
    ).toEqual({});
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `corepack pnpm test:integration -- packages/db/src/repositories/listings-edit-review.integration.test.ts`
Expected: FAIL. The reopen tests find no `listing.approval_invalidated` (`invalidationAt` is -1), and `approvalStatesByIds is not a function`.

If `forWorkspace` rejects an unknown workspace id for the foreign check, look at how `packages/db/src/repositories/enrichment-batches.integration.test.ts:180` builds `otherWorkspaceId` and create the foreign workspace the same way.

- [ ] **Step 3: Implement the read**

In `ListingRepository`, directly after the `statusesByIds(...)` signature (`:66`):

```ts
  /**
   * Status and active version for each of the given drafts, keyed by draft ID.
   * The importer needs the version to say which approval a re-import
   * invalidated; `statusesByIds` omits it and `getByIds` loads content.
   */
  approvalStatesByIds(
    ids: readonly string[],
  ): Promise<
    Record<string, { status: ListingStatus; activeVersionId: string | null }>
  >;
```

In the implementation, directly after the `async statusesByIds(ids) { … },` method:

```ts
    async approvalStatesByIds(ids) {
      scope.assertOpen();
      if (ids.length === 0) return {};
      const rows = await transaction
        .select({
          id: listingDrafts.id,
          status: listingDrafts.status,
          activeVersionId: listingDrafts.activeVersionId,
        })
        .from(listingDrafts)
        .where(
          and(
            eq(listingDrafts.workspaceId, workspaceId),
            inArray(listingDrafts.id, [...ids]),
          ),
        );
      return Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            status: row.status as ListingStatus,
            activeVersionId: row.activeVersionId,
          },
        ]),
      );
    },
```

- [ ] **Step 4: Write the event on the reopen branch**

Replace `import { transitionListing } from "@wukong/core";` (`:14`) with:

```ts
import { APPROVAL_INVALIDATED_ACTION, transitionListing } from "@wukong/core";
```

In `invalidateApprovalForConfirmationChange`, replace:

```ts
      if (updated.length !== 1)
        throw new Error("listing changed while updating confirmations");
      return "reopened";
```

with:

```ts
      if (updated.length !== 1)
        throw new Error("listing changed while updating confirmations");
      // The transition record says the status moved; this says why the
      // approval stopped holding, which is what an operator needs to see.
      await audit.write({
        ...context,
        action: APPROVAL_INVALIDATED_ACTION,
        metadata: {
          cause: "confirmation_changed",
          fromStatus: listing.status,
          versionId,
        },
      });
      return "reopened";
```

- [ ] **Step 5: Build, run, lint**

Run: `corepack pnpm --filter @wukong/db build`.
Run the Step 2 command. Expected: PASS for the whole file.
Run: `corepack pnpm lint`. Expected: all tasks successful.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/listings.ts packages/db/src/repositories/listings-edit-review.integration.test.ts
git commit -m "feat: record why a confirmation change invalidated an approval

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Re-import events in the bulk-form importer

**Files:**
- Modify: `apps/web/lib/bulk-form-import.ts` (`BulkFormImportResult` `:34-40`; transaction body `:138-264`)
- Modify: `apps/web/lib/bulk-form-import.test.ts`
- Modify: `apps/web/app/api/listings/import/route.test.ts:5-11` (fixture type only)

- [ ] **Step 1: Extend the test fake**

In `bulk-form-import.test.ts`:

1. Change the `audits` member of `Recorded` to:

```ts
  audits: {
    workspaceId?: string;
    actorId?: string;
    action: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  }[];
```

2. Add `statusWrites: string[];` to `Recorded`, and `statusWrites: [],` to the object literal in `importerWith`.

3. Replace the `importerWith` signature line with:

```ts
type Existing = {
  listingId: string;
  contentDigest: string;
  sourceImportId?: string | null;
  /** Absent means the linked draft no longer exists. */
  status?: string;
  activeVersionId?: string | null;
};

function importerWith(existing: Record<string, Existing> = {}) {
```

4. In the `listings` fake object, add after `updateNote`:

```ts
              async approvalStatesByIds(ids: readonly string[]) {
                return Object.fromEntries(
                  Object.values(existing)
                    .filter(
                      (entry) =>
                        ids.includes(entry.listingId) &&
                        entry.status !== undefined,
                    )
                    .map((entry) => [
                      entry.listingId,
                      {
                        status: entry.status,
                        activeVersionId: entry.activeVersionId ?? null,
                      },
                    ]),
                );
              },
              // Not a real repository method: a trap that fails loudly if the
              // importer ever starts writing status.
              async updateStatus(id: string) {
                recorded.statusWrites.push(id);
              },
```

Existing tests that pass `{ listingId, contentDigest }` without `status` keep behaving as today: no approval state, so no event.

- [ ] **Step 2: Write the failing tests**

Add at the end of `describe("bulk form importer", ...)`:

```ts
  const reimportInput = {
    workspaceId: "ws_opak",
    actorId: "user_1",
    rawBytes: RAW_BYTES,
    merchantAttestedExportAt: MERCHANT_ATTESTED_EXPORT_AT,
    filename: FILENAME,
    sheetName: SHEET_NAME,
  };

  async function digestOfDefaultRow() {
    const first = importerWith();
    await first.importBulkForm({ ...reimportInput, sheet: sheetOf(rowFor()) });
    return first.recorded.upserts[0]!.contentDigest;
  }

  const invalidationsIn = (recorded: Recorded) =>
    recorded.audits.filter(
      (event) => event.action === "listing.approval_invalidated",
    );

  it.each(["approved", "published", "publish_failed", "publishing"])(
    "records an invalidated approval when a re-import touches a %s listing",
    async (status) => {
      const { importBulkForm, recorded } = importerWith({
        remote_1: {
          listingId: "draft_existing",
          contentDigest: await digestOfDefaultRow(),
          sourceImportId: "source_import_prior",
          status,
          activeVersionId: "version_1",
        },
      });

      const result = await importBulkForm({
        ...reimportInput,
        sheet: sheetOf(rowFor()),
      });

      expect(invalidationsIn(recorded)).toEqual([
        {
          workspaceId: "ws_opak",
          actorId: "user_1",
          entityId: "draft_existing",
          action: "listing.approval_invalidated",
          metadata: {
            cause: "source_reimported_unchanged",
            fromStatus: status,
            versionId: "version_1",
            sourceImportId: "source_import_1",
            priorSourceImportId: "source_import_prior",
          },
        },
      ]);
      expect(result.invalidatedApprovals).toBe(1);
      expect(recorded.statusWrites).toEqual([]);
    },
  );

  it("names a changed row as the cause when the re-imported row differs", async () => {
    const { importBulkForm, recorded } = importerWith({
      remote_1: {
        listingId: "draft_existing",
        contentDigest: "stale",
        sourceImportId: "source_import_prior",
        status: "approved",
        activeVersionId: "version_1",
      },
    });

    await importBulkForm({ ...reimportInput, sheet: sheetOf(rowFor()) });

    expect(invalidationsIn(recorded)).toHaveLength(1);
    expect(invalidationsIn(recorded)[0]?.metadata).toMatchObject({
      cause: "source_reimported_changed",
    });
  });

  it.each(["in_review", "reopened", "needs_info", "received"])(
    "records nothing for a %s listing, which holds no approval",
    async (status) => {
      const { importBulkForm, recorded } = importerWith({
        remote_1: {
          listingId: "draft_existing",
          contentDigest: "stale",
          status,
          activeVersionId: "version_1",
        },
      });

      const result = await importBulkForm({
        ...reimportInput,
        sheet: sheetOf(rowFor()),
      });

      expect(invalidationsIn(recorded)).toEqual([]);
      expect(result.invalidatedApprovals).toBe(0);
    },
  );

  it("records nothing for a new draft or a linked draft that no longer exists", async () => {
    const { importBulkForm, recorded } = importerWith({
      // Linked, but the draft is gone: no status comes back for it.
      remote_2: { listingId: "draft_deleted", contentDigest: "stale" },
    });

    const result = await importBulkForm({
      ...reimportInput,
      sheet: sheetOf(rowFor(), rowFor({ productId: "remote_2", sku: "0002" })),
    });

    expect(invalidationsIn(recorded)).toEqual([]);
    expect(result.invalidatedApprovals).toBe(0);
  });

  it("counts invalidated approvals on the aggregate import event", async () => {
    const { importBulkForm, recorded } = importerWith({
      remote_1: {
        listingId: "draft_a",
        contentDigest: "stale",
        status: "approved",
        activeVersionId: "version_a",
      },
      remote_2: {
        listingId: "draft_b",
        contentDigest: "stale",
        status: "published",
        activeVersionId: "version_b",
      },
    });

    const result = await importBulkForm({
      ...reimportInput,
      sheet: sheetOf(rowFor(), rowFor({ productId: "remote_2", sku: "0002" })),
    });

    expect(result.invalidatedApprovals).toBe(2);
    expect(
      recorded.audits.find(
        (event) => event.action === "listing.bulk_form_import_completed",
      )?.metadata,
    ).toMatchObject({ invalidatedApprovals: 2 });
  });
```

In the existing test "writes one aggregate listing.bulk_form_import_completed audit event per import, entityId'd to the source import", add `invalidatedApprovals: result.invalidatedApprovals,` to the `metadata` object after `refreshedProducts`.

- [ ] **Step 3: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts`
Expected: FAIL. No `listing.approval_invalidated` events are written, `invalidatedApprovals` is `undefined`, and the aggregate metadata does not match.

- [ ] **Step 4: Implement**

In `bulk-form-import.ts`, add (or merge into an existing `@wukong/core` import):

```ts
import {
  APPROVAL_INVALIDATED_ACTION,
  type ApprovalInvalidationCause,
  type ListingStatus,
} from "@wukong/core";
```

Below the imports, add:

```ts
// Statuses whose approval a re-import breaks. `publishing` is included even
// though a confirmation change refuses it: nothing is transitioned here, and a
// publish running under a stale approval is exactly what must not go unseen.
const APPROVAL_HOLDING_STATUSES: ReadonlySet<ListingStatus> = new Set([
  "approved",
  "published",
  "publish_failed",
  "publishing",
]);
```

Replace `BulkFormImportResult` with:

```ts
export type BulkFormImportResult = {
  specVersion: string;
  parsedRows: number;
  createdDrafts: number;
  refreshedProducts: number;
  /** Approved, published, publish-failed or publishing listings this import re-bound. */
  invalidatedApprovals: number;
  issues: BulkFormIssue[];
};
```

After the `knownByRemoteId` map is built, add:

```ts
        // One read for every linked listing, not one per row. It sees this
        // transaction's snapshot: a listing approved concurrently after it is
        // missed here, and since its receipt still names an older import, the
        // next re-import records it.
        const approvalStates = await repositories.listings.approvalStatesByIds(
          known
            .map((product) => product.listingId)
            .filter((id): id is string => id !== null),
        );
        let invalidatedApprovals = 0;
```

Inside the row loop, directly after the closing brace of the existing `if (isNewDraft || isRefresh) { … }` audit block, add:

```ts
          const approvalState = isNewDraft
            ? undefined
            : approvalStates[listingId];
          if (
            approvalState &&
            APPROVAL_HOLDING_STATUSES.has(approvalState.status)
          ) {
            invalidatedApprovals += 1;
            const cause: ApprovalInvalidationCause = isRefresh
              ? "source_reimported_changed"
              : "source_reimported_unchanged";
            // Identifiers only. Status is deliberately left alone: the event,
            // not a transition, is what makes the lost approval visible.
            await repositories.audit.write({
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              entityId: listingId,
              action: APPROVAL_INVALIDATED_ACTION,
              metadata: {
                cause,
                fromStatus: approvalState.status,
                versionId: approvalState.activeVersionId,
                sourceImportId: sourceImport.id,
                priorSourceImportId: prior?.sourceImportId ?? null,
              },
            });
          }
```

In the aggregate `listing.bulk_form_import_completed` metadata, add `invalidatedApprovals,` after `refreshedProducts,`. In the returned object, add `invalidatedApprovals,` after `refreshedProducts,`.

In `apps/web/app/api/listings/import/route.test.ts`, add `invalidatedApprovals: 0,` to `okResult` after `refreshedProducts: 0,`. Otherwise it no longer satisfies the importer's return type; Task 5 changes this value.

- [ ] **Step 5: Run, lint**

Run: `corepack pnpm --filter @wukong/web exec vitest run lib/bulk-form-import.test.ts app/api/listings/import/route.test.ts`. Expected: PASS.
Run: `corepack pnpm lint`. Expected: all tasks successful. `prior?.sourceImportId` typechecks because `PlatformProduct.sourceImportId` is `string | null` (`platform-products.ts:31`). If it doesn't, rebuild `@wukong/db`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-form-import.ts apps/web/lib/bulk-form-import.test.ts apps/web/app/api/listings/import/route.test.ts
git commit -m "feat: record approvals a re-import invalidates without changing status

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Import route and import panel

**Files:**
- Modify: `apps/web/app/api/listings/import/route.ts:160-180`
- Modify: `apps/web/app/api/listings/import/route.test.ts`
- Modify: `apps/web/components/bulk-import-panel.tsx` (success type `:25-31`, parse `:203-208`, render `:313-328`)
- Modify: `apps/web/components/bulk-import-panel.test.ts`
- Modify (fixtures): `apps/web/components/bulk-import-panel.contract.test.tsx:68`, `apps/web/components/import-store-setup-panel.test.tsx:72`

- [ ] **Step 1: Write the failing tests**

`route.test.ts`:
- Change `okResult.invalidatedApprovals` to `1`.
- In "imports for an operator and returns the counts", add `invalidatedApprovals: 1,` to the `toMatchObject`.

`bulk-import-panel.test.ts`, "returns a success outcome with the real response fields": add `invalidatedApprovals: 2,` after `refreshedProducts: 0,` in both the mocked response body and the expected `toEqual` object. Then add after that test:

```ts
  it("treats a response without invalidatedApprovals as zero", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          specVersion: "opak-2026-05",
          parsedRows: 1,
          createdDrafts: 1,
          refreshedProducts: 0,
          issues: [],
        },
        { status: 201 },
      ),
    );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      { fetcher },
    );
    expect(result).toMatchObject({ kind: "success", invalidatedApprovals: 0 });
  });
```

In `describe("BulkImportPanel", ...)`, "renders the real parsed/created/refreshed counts after a successful import":
1. Read the test to its end and find the assertion(s) on the rendered counts.
2. Directly after them, add `expect(container.textContent).not.toMatch(/已失效批准|Approvals invalidated/);`.
3. Duplicate the whole test as "shows how many approvals the import invalidated", with two changes:
   - the mocked import body carries `invalidatedApprovals: 2`
   - its final assertions are replaced with:

```ts
    expect(container.textContent).toMatch(
      /已失效批准 2 筆|Approvals invalidated: 2/,
    );
    expect(container.textContent).toMatch(
      /須重新批准才能匯出|need renewed approval before export/,
    );
```

In `bulk-import-panel.contract.test.tsx:68` and `import-store-setup-panel.test.tsx:72`, add `invalidatedApprovals: 0,` after `refreshedProducts: 0,`.

- [ ] **Step 2: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run app/api/listings/import/route.test.ts components/bulk-import-panel.test.ts`
Expected: FAIL. The route omits `invalidatedApprovals`, the parsed outcome lacks it, and the text is absent.

- [ ] **Step 3: Implement**

`route.ts`: add `invalidatedApprovals: result.invalidatedApprovals,` after `refreshedProducts: result.refreshedProducts,` in both the log object (`:169`) and the `jsonResponse(201, {...})` body (`:178`).

`bulk-import-panel.tsx`:
- Success type: add `invalidatedApprovals: number;` after `refreshedProducts: number;`.
- Success parse: after `refreshedProducts: body.refreshedProducts as number,` add:

```ts
    // Older servers omit it; absent means nothing was invalidated.
    invalidatedApprovals:
      typeof body.invalidatedApprovals === "number"
        ? body.invalidatedApprovals
        : 0,
```

- Render: directly after the counts `<li>…</li>` (ending `:322`), add:

```tsx
            {outcome.invalidatedApprovals > 0 ? (
              <li>
                {t(
                  `已失效批准 ${outcome.invalidatedApprovals} 筆 · 這些商品須重新批准才能匯出`,
                  `Approvals invalidated: ${outcome.invalidatedApprovals} · These listings need renewed approval before export`,
                )}
              </li>
            ) : null}
```

- [ ] **Step 4: Run, lint**

Run: `corepack pnpm --filter @wukong/web exec vitest run app/api/listings/import/route.test.ts components/bulk-import-panel.test.ts components/bulk-import-panel.contract.test.tsx components/import-store-setup-panel.test.tsx lib/ui-vocabulary.test.ts`
Expected: PASS.
Run: `corepack pnpm lint`. Expected: all tasks successful.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/listings/import/route.ts apps/web/app/api/listings/import/route.test.ts apps/web/components/bulk-import-panel.tsx apps/web/components/bulk-import-panel.test.ts apps/web/components/bulk-import-panel.contract.test.tsx apps/web/components/import-store-setup-panel.test.tsx
git commit -m "feat: show how many approvals an import invalidated

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: /jobs metrics and tiles

**Files:**
- Modify: `apps/web/app/api/jobs/route.ts` (imports; `Promise.all` `:67-92`; after the bucketing loop `:109`; `metrics` `:131-136`)
- Modify: `apps/web/app/api/jobs/route.test.ts`
- Modify: `apps/web/components/jobs-ledger-client.tsx` (`JobsMetrics` `:43-48`; metric strip `:251-288`)
- Modify: `apps/web/components/jobs-ledger-client.test.tsx` (`SAMPLE_METRICS` `:48-53`)

- [ ] **Step 1: Write the failing route tests**

In `route.test.ts`, "includes a metrics summary alongside the ledger entries", replace the `countByActionAndMetadataKeySince` fake with:

```ts
                async countByActionAndMetadataKeySince(action: string) {
                  if (action === "listing.approval_invalidated")
                    return [
                      { value: "confirmation_changed", count: 4 },
                      { value: "source_reimported_changed", count: 2 },
                      { value: "source_reimported_unchanged", count: 7 },
                    ];
                  return [
                    { value: "version_conflict", count: 1 },
                    { value: "source_import_mismatch", count: 2 },
                  ];
                },
```

and its `expect(body.metrics).toEqual({...})` with:

```ts
    expect(body.metrics).toEqual({
      publishRetries: 3,
      versionConflicts: 1,
      staleSourceRejections: 2,
      importedRows: 120,
      approvalInvalidations: {
        confirmationChanged: 4,
        reimportChanged: 2,
        reimportUnchanged: 7,
      },
    });
```

Add after that test (inside the same `describe`):

```ts
  it("counts an unknown invalidation cause in no tile and logs only its value", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const noRows = {
      async getByIds() {
        return [];
      },
    };
    try {
      const handler = createJobsHandler({
        sessionContext: {
          async resolve() {
            return {
              workspaceId: "ws_opak",
              actorId: "user_1",
              role: "viewer",
            };
          },
        },
        getDatabase: () =>
          ({
            async forWorkspace<T>(
              _workspaceId: string,
              work: (repositories: any) => Promise<T>,
            ) {
              return work({
                reads: {
                  async jobsPage() {
                    return {
                      items: [],
                      totalMatching: 0,
                      total: 0,
                      counts: {},
                    };
                  },
                },
                enrichmentBatches: noRows,
                publishJobs: noRows,
                pipelineRuns: noRows,
                exportAttempts: noRows,
                importResults: {
                  ...noRows,
                  async listForExportAttempts() {
                    return [];
                  },
                },
                audit: {
                  async countByActionSince() {
                    return 0;
                  },
                  async countByActionAndMetadataKeySince(action: string) {
                    return action === "listing.approval_invalidated"
                      ? [
                          { value: "confirmation_changed", count: 1 },
                          { value: "some_future_cause", count: 9 },
                        ]
                      : [];
                  },
                  async sumImportMetricsSince() {
                    return {
                      parsedRows: 0,
                      createdDrafts: 0,
                      refreshedProducts: 0,
                      issueCount: 0,
                    };
                  },
                },
              });
            },
          }) as never,
      });

      const body = await (await handler()).json();

      expect(body.metrics.approvalInvalidations).toEqual({
        confirmationChanged: 1,
        reimportChanged: 0,
        reimportUnchanged: 0,
      });
      const logged = info.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(String(line));
          } catch {
            return null;
          }
        })
        .filter((entry) => entry?.event === "jobs.unknown_invalidation_cause");
      expect(logged).toEqual([
        { event: "jobs.unknown_invalidation_cause", cause: "some_future_cause" },
      ]);
    } finally {
      info.mockRestore();
    }
  });
```

Add `vi` to the file's `vitest` import if absent.

- [ ] **Step 2: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run app/api/jobs/route.test.ts`
Expected: FAIL. `approvalInvalidations` is missing and nothing is logged.

- [ ] **Step 3: Implement the route**

Add to `route.ts` imports:

```ts
import {
  APPROVAL_INVALIDATED_ACTION,
  isApprovalInvalidationCause,
} from "@wukong/core";
```

Add `invalidationsByCause,` as the last name in the destructuring list (after `importSums,`) and, as the last element of `Promise.all([...])`:

```ts
            repositories.audit.countByActionAndMetadataKeySince(
              APPROVAL_INVALIDATED_ACTION,
              "cause",
              since,
            ),
```

After the `for (const row of reviewConflictsByReason) { … }` loop, add:

```ts
          const approvalInvalidations = {
            confirmationChanged: 0,
            reimportChanged: 0,
            reimportUnchanged: 0,
          };
          for (const row of invalidationsByCause) {
            if (!isApprovalInvalidationCause(row.value)) {
              // A cause this build does not know must not be folded into a
              // tile that claims to mean something else.
              console.info(
                JSON.stringify({
                  event: "jobs.unknown_invalidation_cause",
                  cause: row.value,
                }),
              );
              continue;
            }
            if (row.value === "confirmation_changed")
              approvalInvalidations.confirmationChanged += row.count;
            else if (row.value === "source_reimported_changed")
              approvalInvalidations.reimportChanged += row.count;
            else approvalInvalidations.reimportUnchanged += row.count;
          }
```

In `metrics: { … }`, add `approvalInvalidations,` after `importedRows: importSums.parsedRows,`.

- [ ] **Step 4: Run the route tests**

Run: `corepack pnpm --filter @wukong/web exec vitest run app/api/jobs/route.test.ts`. Expected: PASS.

- [ ] **Step 5: Write the failing client test**

In `jobs-ledger-client.test.tsx`, replace `SAMPLE_METRICS` with:

```ts
const SAMPLE_METRICS = {
  publishRetries: 3,
  versionConflicts: 1,
  staleSourceRejections: 2,
  importedRows: 120,
  approvalInvalidations: {
    confirmationChanged: 4,
    reimportChanged: 2,
    reimportUnchanged: 7,
  },
};
```

Add inside the first `describe`:

```ts
  it("shows approval invalidations by confirmation and by re-import", async () => {
    stubFetch({ entries: [], metrics: SAMPLE_METRICS });

    const { container } = await mountLedger();

    const tiles = Array.from(
      container.querySelectorAll(".jobs-metric-strip > div"),
    ).map((tile) => ({
      value: tile.querySelector(".metric-value")?.textContent,
      label: tile.querySelector(".metric-label")?.textContent,
    }));
    expect(tiles).toContainEqual({
      value: "4",
      label: expect.stringMatching(
        /由確認變更導致的批准失效|Approvals invalidated by confirmation/,
      ),
    });
    // Changed plus unchanged rows: 2 + 7.
    expect(tiles).toContainEqual({
      value: "9",
      label: expect.stringMatching(
        /由重新匯入導致的批准失效|Approvals invalidated by re-import/,
      ),
    });
  });
```

- [ ] **Step 6: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/jobs-ledger-client.test.tsx`
Expected: the new test FAILS; the others pass.

- [ ] **Step 7: Implement the tiles**

`jobs-ledger-client.tsx`, replace `JobsMetrics`:

```ts
type JobsMetrics = {
  publishRetries: number;
  versionConflicts: number;
  staleSourceRejections: number;
  importedRows: number;
  approvalInvalidations: {
    confirmationChanged: number;
    reimportChanged: number;
    reimportUnchanged: number;
  };
};
```

After the "Recent imported rows" tile's closing `</div>` (`:287`), before the strip's closing `</div>`:

```tsx
        <div>
          <span className="metric-value">
            {formatNumber(
              response.metrics.approvalInvalidations.confirmationChanged,
              locale,
            )}
          </span>
          <span className="metric-label">
            {localized(
              locale,
              "由確認變更導致的批准失效",
              "Approvals invalidated by confirmation",
            )}
          </span>
        </div>
        <div>
          <span className="metric-value">
            {formatNumber(
              response.metrics.approvalInvalidations.reimportChanged +
                response.metrics.approvalInvalidations.reimportUnchanged,
              locale,
            )}
          </span>
          <span className="metric-label">
            {localized(
              locale,
              "由重新匯入導致的批准失效",
              "Approvals invalidated by re-import",
            )}
          </span>
        </div>
```

- [ ] **Step 8: Run, find other metrics fixtures, lint**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/jobs-ledger-client.test.tsx app/api/jobs/route.test.ts`. Expected: PASS.
Search `apps/web` and `tests` for `staleSourceRejections:`. Any other fixture feeding `JobsLedgerClient` (for example a locale test) needs the same `approvalInvalidations` object. Otherwise the component throws reading `.confirmationChanged` of `undefined`. Add it and run those test files.
Run: `corepack pnpm lint`. Expected: all tasks successful.

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/api/jobs/route.ts apps/web/app/api/jobs/route.test.ts apps/web/components/jobs-ledger-client.tsx apps/web/components/jobs-ledger-client.test.tsx
git commit -m "feat: count approval invalidations by cause on /jobs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(Add any other fixture files changed in Step 8.)

---

### Task 7: Activity panel label and cause

**Files:**
- Modify: `apps/web/components/activity-panel.tsx:31-52`
- Modify: `apps/web/components/activity-panel.test.tsx`

- [ ] **Step 1: Write the failing tests**

The file mocks the locale to `zh-Hant`. Add inside `describe("ActivityPanel", ...)`:

```ts
  it.each([
    ["confirmation_changed", "確認內容已變更"],
    ["source_reimported_changed", "重新匯入，來源資料已變更"],
    ["source_reimported_unchanged", "重新匯入，來源資料未變"],
  ])("names an approval invalidated by %s and its cause", async (cause, text) => {
    const { container, root } = await mount([
      {
        kind: "audit",
        id: "audit_inv",
        action: "listing.approval_invalidated",
        metadata: { cause, fromStatus: "approved", versionId: "v1" },
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    ]);

    expect(container.textContent).toContain("批准已失效");
    expect(container.textContent).toContain(text);
    expect(container.textContent).not.toContain(cause);

    await unmount(root);
  });

  it("names an invalidation with an unknown cause without printing the raw value", async () => {
    const { container, root } = await mount([
      {
        kind: "audit",
        id: "audit_inv",
        action: "listing.approval_invalidated",
        metadata: { cause: "some_future_cause" },
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    ]);

    expect(container.textContent).toContain("批准已失效");
    expect(container.textContent).not.toContain("some_future_cause");

    await unmount(root);
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/activity-panel.test.tsx`
Expected: FAIL. The entry renders "其他活動記錄".

- [ ] **Step 3: Implement**

In `auditActions`, add after `"listing.review_conflict"`:

```ts
  "listing.approval_invalidated": ["批准已失效", "Approval invalidated"],
```

Below `auditActions`:

```ts
const invalidationCauses: Record<string, readonly [string, string]> = {
  confirmation_changed: ["確認內容已變更", "Confirmations changed"],
  source_reimported_changed: [
    "重新匯入，來源資料已變更",
    "Re-imported with changed source row",
  ],
  source_reimported_unchanged: [
    "重新匯入，來源資料未變",
    "Re-imported, row unchanged",
  ],
};

function causeOf(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const cause = (metadata as { cause?: unknown }).cause;
  return typeof cause === "string" ? cause : undefined;
}
```

In `summarize`, replace the audit branch:

```ts
  if (entry.kind === "audit") {
    const action = auditActions[entry.action];
    if (!action) return t("其他活動記錄", "Other activity");
    const label = localized(locale, ...action);
    const cause =
      entry.action === "listing.approval_invalidated"
        ? invalidationCauses[causeOf(entry.metadata) ?? ""]
        : undefined;
    // An unknown cause shows the label alone rather than a raw enum value.
    return cause ? label + " (" + localized(locale, ...cause) + ")" : label;
  }
```

- [ ] **Step 4: Run, lint**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/activity-panel.test.tsx lib/ui-vocabulary.test.ts components/listing-detail-locale.test.tsx`
Expected: PASS. `ui-vocabulary.test.ts` is the localisation ratchet. Leave `listing-detail-locale.test.tsx` out of the command if it does not exist.
Run: `corepack pnpm lint`. Expected: all tasks successful.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/activity-panel.tsx apps/web/components/activity-panel.test.tsx
git commit -m "feat: name approval invalidations and their cause in listing activity

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Stop masking `reopened` on the review page

**Files:**
- Modify: `apps/web/components/listing-view-models.ts:51-58`
- Modify: `apps/web/components/listing-review-client.tsx:212-217`
- Modify: `apps/web/components/listing-fields-form.tsx:130-135`
- Modify: `apps/web/app/globals.css:911-912`
- Modify: `apps/web/components/listing-review-client.test.ts`
- Modify: `apps/web/components/listing-fields-form.test.tsx`

- [ ] **Step 1: Write the failing tests**

`listing-review-client.test.ts`, inside `describe("listing review client mapping", ...)`:

```ts
  it("keeps a reopened listing visibly reopened instead of calling it in review", () => {
    const mapped = mapListingView({ ...response, status: "reopened" });

    expect(mapped.model.status).toBe("reopened");
    expect(mapped.delivery.status).toBe("reopened");
  });
```

`listing-fields-form.test.tsx`, inside `describe("ListingFieldsForm", ...)` after "enables approval once every field and negative confirmation is checked and no flags block it":

```ts
  it("keeps approval available for a reopened listing, which the approve path resubmits", () => {
    const reopenedModel: ListingReviewModel = {
      ...model,
      status: "reopened",
      blockingFlags: [],
    };

    const markup = renderToStaticMarkup(
      <ListingFieldsForm
        model={reopenedModel}
        fieldConfirmations={completeFieldConfirmations}
        negativeConfirmations={completeNegativeConfirmations}
      />,
    );

    expect(markup).not.toContain('disabled=""');
  });

  it("still disables approval for an already approved listing", () => {
    const approvedModel: ListingReviewModel = {
      ...model,
      status: "approved",
      blockingFlags: [],
    };

    const markup = renderToStaticMarkup(
      <ListingFieldsForm
        model={approvedModel}
        fieldConfirmations={completeFieldConfirmations}
        negativeConfirmations={completeNegativeConfirmations}
      />,
    );

    expect(markup).toContain('disabled=""');
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/listing-review-client.test.ts components/listing-fields-form.test.tsx`
Expected: FAIL. The mapping returns `in_review`, and the reopened form renders `disabled=""`. At runtime Vitest does not typecheck, so `status: "reopened"` still reaches the component. The "approved" test passes already; it guards the change.

- [ ] **Step 3: Implement**

`listing-view-models.ts`: in `ListingReviewModel["status"]`, add `| "reopened"` directly after `| "in_review"`.

`listing-review-client.tsx`: replace `reviewStatus` with:

```ts
function reviewStatus(status: ListingStatus): ListingReviewModel["status"] {
  // `reopened` is shown as itself: an approval that stopped holding must not
  // look like a listing that was never approved.
  if (status === "publishing") return "approved";
  if (status === "publish_failed") return "failed";
  return status;
}
```

`listing-fields-form.tsx`: replace the last line of `approvalDisabled`

```ts
    model.status !== "in_review";
```

with

```ts
    // Reopened listings are approvable: the approve path submits them for
    // review first (packages/db/src/repositories/listings.ts, approve).
    (model.status !== "in_review" && model.status !== "reopened");
```

`globals.css`: change the selector at `:911-912` from

```css
.status-in_review,
.status-needs_info {
```

to

```css
.status-in_review,
.status-reopened,
.status-needs_info {
```

The review header (`listing-review-client.tsx:868-870`) already renders `stateLabel(model.status, locale)`, and `ui-copy.ts:99` maps `reopened` to "重新開啟 / Reopened". No change is needed there.

- [ ] **Step 4: Run, lint**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/listing-review-client.test.ts components/listing-fields-form.test.tsx components/delivery-panel.test.tsx`
Expected: PASS.
Run: `corepack pnpm lint`. Expected: all tasks successful. Any exhaustive `Record` over `ListingReviewModel["status"]` now needs a `reopened` key; `tsc` names the file. Add the entry using `stateLabel("reopened", …)` copy.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/listing-view-models.ts apps/web/components/listing-review-client.tsx apps/web/components/listing-review-client.test.ts apps/web/components/listing-fields-form.tsx apps/web/components/listing-fields-form.test.tsx apps/web/app/globals.css
git commit -m "feat: show a reopened listing as reopened on the review page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Reopened tag in the queue

**Files:**
- Modify: `apps/web/components/listing-view-models.ts:11-20`
- Modify: `apps/web/lib/dashboard-queue-shared.ts:50-70`
- Modify: `apps/web/components/listing-queue.tsx:142`
- Modify: `apps/web/app/globals.css` (add `.status-tag`)
- Modify: `apps/web/components/dashboard-listings-client.test.ts`
- Modify: `apps/web/components/listing-queue.test.tsx`

- [ ] **Step 1: Write the failing tests**

`dashboard-listings-client.test.ts`, inside `describe("mapDashboardItems", ...)`:

```ts
  it("keeps a reopened listing in review but marks it reopened", () => {
    const [reopened, inReview] = mapDashboardItems([
      { ...baseItem, id: "listing_r", status: "reopened" },
      baseItem,
    ]);
    expect(reopened).toMatchObject({ status: "in_review", reopened: true });
    expect(inReview).toMatchObject({ status: "in_review", reopened: false });
  });
```

`listing-queue.test.tsx`, append:

```ts
describe("reopened listings", () => {
  it("stay in the review group and carry a Reopened tag", async () => {
    const { container, root } = await mount([
      buildQueueItem({
        id: "listing_r",
        title: "Reopened Riesling",
        reopened: true,
      }),
      buildQueueItem({ id: "listing_i", title: "Fresh Riesling" }),
    ]);
    try {
      const group = container.querySelector(
        'section[aria-labelledby="queue-in_review"]',
      )!;
      const items = Array.from(group.querySelectorAll("li.queue-item"));
      expect(items).toHaveLength(2);
      const reopened = items.find((item) =>
        item.textContent?.includes("Reopened Riesling"),
      )!;
      const fresh = items.find((item) =>
        item.textContent?.includes("Fresh Riesling"),
      )!;
      expect(reopened.querySelector(".status-tag")?.textContent).toBe(
        stateLabel("reopened", "zh-Hant"),
      );
      expect(fresh.querySelector(".status-tag")).toBeNull();
    } finally {
      await unmount(root);
    }
  });
});
```

`listing-queue.test.tsx` has no locale mock. `useLocale` falls back to its default, which is `zh-Hant` as the existing heading test's `stateLabel(…, "zh-Hant")` shows.

- [ ] **Step 2: Run and confirm failure**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/dashboard-listings-client.test.ts components/listing-queue.test.tsx`
Expected: FAIL. `reopened` is `undefined` on mapped items, and there is no `.status-tag`.

- [ ] **Step 3: Implement**

`listing-view-models.ts`, in `QueueItem` after `openBlockingFlagCount: number;`:

```ts
  /**
   * The listing held an approval that stopped holding. It is grouped with
   * in-review work because the work is the same, but it is marked so it does
   * not look like a listing that was never approved. Optional so fixtures and
   * fallbacks need not state it; absent means false.
   */
  reopened?: boolean;
```

`dashboard-queue-shared.ts`, in the object returned by `mapDashboardItems`, after `openBlockingFlagCount: item.openBlockingFlagCount,`:

```ts
      reopened: item.status === "reopened",
```

`listing-queue.tsx`, replace `<p>{item.subtitle}</p>` with:

```tsx
                          <p>
                            {item.subtitle}
                            {item.reopened ? (
                              <>
                                {" · "}
                                <span className="status-tag">
                                  {stateLabel("reopened", locale)}
                                </span>
                              </>
                            ) : null}
                          </p>
```

`globals.css`, directly after the `.status-in_review, .status-reopened, .status-needs_info { … }` rule:

```css
.status-tag {
  color: var(--amber-dark);
  font-weight: 600;
}
```

- [ ] **Step 4: Run, lint**

Run: `corepack pnpm --filter @wukong/web exec vitest run components/dashboard-listings-client.test.ts components/listing-queue.test.tsx lib/listing-queue-runtime.test.ts`
Expected: PASS.
Run: `corepack pnpm lint`. Expected: all tasks successful.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/listing-view-models.ts apps/web/lib/dashboard-queue-shared.ts apps/web/components/listing-queue.tsx apps/web/components/dashboard-listings-client.test.ts apps/web/components/listing-queue.test.tsx apps/web/app/globals.css
git commit -m "feat: tag reopened listings in the review queue

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Acceptance journey in the real-stack E2E

The attended Bulk Update journey (`tests/e2e/bulk-update-pilot.spec.ts:198`, "reviewer completes attended Bulk Update and reconciles mixed operator reports") already imports two rows, enriches them, approves both, exports and reconciles. The new steps go at its very end:
- after `await captureDeliveryLocaleMatrix(page, testInfo, listingIds[0]!, attemptId);` (`:1083`)
- before `expect(pageErrors).toEqual([]);` (`:1084`)

So everything earlier in the test still sees the original statuses. `input`, `listingIds`, `operator`, `ADMIN_URL`, `postgres` and `stateLabel` are already in scope.

**Files:**
- Modify: `tests/e2e/bulk-update-pilot.spec.ts:1083-1084`

- [ ] **Step 1: Add the journey steps**

Insert between `:1083` and `:1084`:

```ts

  // W7: re-importing the same workbook re-binds both approvals to a new source
  // import. That must be visible when it happens, and the status must stay.
  await page.goto("/listings/import");
  await page.locator("#connected-shopline-update > summary").click();
  await page.locator("#bulk-import-file").setInputFiles({
    name: "synthetic-task5-reimport.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: input,
  });
  await page
    .locator("#merchant-attested-export-at")
    .fill(
      new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16),
    );
  const reimported = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/listings/import" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start import" }).click();
  const reimportResponse = await reimported;
  expect(reimportResponse.status()).toBe(201);
  expect(await reimportResponse.json()).toMatchObject({
    createdDrafts: 0,
    invalidatedApprovals: 2,
  });
  await expect(page.getByText(/Approvals invalidated: 2/)).toBeVisible();

  const statusCheck = postgres(ADMIN_URL, { max: 1, prepare: false });
  try {
    const statuses =
      await statusCheck`SELECT status FROM listing_drafts WHERE workspace_id=${operator.workspaceId}`;
    // Recorded, not reopened: neither listing went back to review.
    expect(statuses.map((row) => row.status)).not.toContain("reopened");
  } finally {
    await statusCheck.end();
  }

  const afterReimport = await (await page.request.get("/api/jobs")).json();
  expect(afterReimport.metrics.approvalInvalidations).toEqual({
    confirmationChanged: 0,
    reimportChanged: 0,
    reimportUnchanged: 2,
  });
  await page.goto("/jobs");
  const reimportTile = page
    .locator(".jobs-metric-strip > div")
    .filter({ hasText: "Approvals invalidated by re-import" });
  await expect(reimportTile.locator(".metric-value")).toHaveText("2");

  // The listing's own trail names what happened and why.
  await page.goto("/listings/" + listingIds[0]);
  await expect(
    page.getByText("Approval invalidated (Re-imported, row unchanged)"),
  ).toBeVisible();

  // A confirmation change reopens the listing, and the reopen is shown as itself.
  const confirmationSaved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/" + listingIds[0] + "/review-confirmations") &&
      r.request().method() === "PATCH",
  );
  await page.locator("#confirmation-field-nameZh").click();
  expect((await confirmationSaved).status()).toBe(200);
  await page.reload();
  await expect(page.locator(".review-status")).toHaveText(
    stateLabel("reopened", "en"),
  );
  await expect(
    page.getByText("Approval invalidated (Confirmations changed)"),
  ).toBeVisible();
  await page.goto("/queue");
  const reopenedRow = page.locator("li.queue-item", {
    has: page.locator('a[href="/listings/' + listingIds[0] + '"]'),
  });
  await expect(reopenedRow.locator(".status-tag")).toHaveText(
    stateLabel("reopened", "en"),
  );
  const afterReopen = await (await page.request.get("/api/jobs")).json();
  expect(afterReopen.metrics.approvalInvalidations.confirmationChanged).toBe(1);
```

- [ ] **Step 2: Run the journey**

Services must be up (see ground rules).
Run: `PLAYWRIGHT_E2E=1 corepack pnpm test:e2e -- tests/e2e/bulk-update-pilot.spec.ts -g "reviewer completes attended Bulk Update"`
Expected: PASS.

If a step fails, diagnose from the Playwright trace before changing an assertion:
- **Re-import is refused (409/422).** Read the response body. The attested-export-time field may reject a time later than now, in which case subtract a minute instead.
- **`invalidatedApprovals` is not 2.** Query `SELECT status FROM listing_drafts` at that point. Recording operator results can move a listing to another status; only statuses outside approved, published, publish_failed and publishing legitimately give fewer.
- **The confirmation checkbox is disabled.** Confirmations are editable only with `permissions.canEdit` (`listing-review-client.tsx:924`). Check the operator fixture's role before changing anything.

`bulk-update-pilot.spec.ts:1087` ("admin sets up a store inline…") fails only on Windows and passes in CI. It is unrelated; leave it alone. If the local run cannot complete for environment reasons, record the exact failure. CI's `verify` job runs this suite and is the deciding run.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/bulk-update-pilot.spec.ts
git commit -m "test: prove approval invalidations are visible in the attended journey

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Close W7 in the release-gate plan

**Files:**
- Modify: `docs/superpowers/plans/2026-09-11-release-gate-closure.md` (W7 section, after `:319`)

- [ ] **Step 1: Append the closure note**

Insert after the paragraph ending "by finding the listing un-approved." (`:319`):

```markdown

**Done (2026-09-14).** Design:
`docs/superpowers/specs/2026-09-14-approval-invalidation-visibility-design.md`. Both paths now write
`listing.approval_invalidated` with a `cause`:

- A confirmation change writes it beside its existing reopen transition.
- A re-import writes it for every approved, published, publish-failed or publishing listing it
  re-binds, and leaves their status unchanged.

Two corrections to the paragraph above:

- **Re-imports were the larger gap.** The confirmation path was already audited, as a generic
  `listing.transition`. A re-import recorded nothing, yet every re-import invalidates, even of an
  unchanged row: the approval receipt binds the source import id (`bulk-update-eligibility.ts:210`).
- **/quality is deliberately unchanged.** It measures content quality. Invalidation is operational,
  so it appears on /jobs as two 30-day tiles, split by cause in `metrics.approvalInvalidations`.

The events are also visible in:

- the listing activity panel, with label and cause
- the import panel ("Approvals invalidated: N")
- the review page and queue, which now show `reopened` as itself instead of `in_review`

The approve button stays enabled for reopened listings, as the approve path already allowed. No
migration.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-09-11-release-gate-closure.md
git commit -m "docs: close W7 in the release-gate plan

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification

- [ ] **Step 1: Run the local gate on the final commit**

```bash
export PATH="$PATH:/c/Users/laich/AppData/Local/Temp/claude/pnpm-shim"
docker compose up -d postgres minio minio-tls mailpit
corepack pnpm --filter @wukong/db db:migrate
corepack pnpm lint
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
```

(With the integration env from the ground rules exported.)

Expected:
- **Migrate:** exits 0; there are no new migrations.
- **Lint:** all tasks successful.
- **Test:** all tasks successful.
- **Integration:** every file passes.
- **Build:** all tasks successful.

- [ ] **Step 2: Run the audit and format gates after the last commit**

```bash
corepack pnpm --filter @wukong/db audit:verify
RELEASE_BASE_SHA=9f72a37ebeb6549f1041bae673bcee841bf72402 corepack pnpm format:runtime:check
```

Expected:
- **`audit:verify`:** 0 missing actions and 0 accessible foreign records.
- **Format check:** `runtime files checked: N` with no failures. It reads the committed diff, so run it only after committing.

- [ ] **Step 3: Report**

Report the exact numbers from each command. If any command fails, stop and report its output; do not describe the work as complete.
