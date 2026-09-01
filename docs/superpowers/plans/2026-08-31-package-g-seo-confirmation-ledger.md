# Package G — SEO Review Fields, Confirmation Ledger, Freshness-Bound Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 5 unreviewed SEO fields to the review UI, build a `review_confirmations` ledger recording which of the 8 AI-writable fields and 7 negative conditions a reviewer confirmed, and make `POST /api/listings/[id]/approve` an atomic action bound to the same identity/content checks `assertExportFreshness` (Package E, already on `main`) uses for export.

**Architecture:** A shared freshness-check core is extracted from `assertExportFreshness` in `packages/core`; a new `assertApprovalFreshness` calls just that core (no attestation/header-contract check). A new `review_confirmations` table (one row per listing version) backs a new `PATCH` route and a new `ConfirmationChecklist` component. The approve route grows a required body and calls `assertApprovalFreshness` for import-origin listings before doing anything else.

**Tech Stack:** Drizzle ORM, Zod, Next.js App Router, React 19, Vitest.

---

## Environment note for every `Run:` step

`pnpm` is not on a normal PATH in this environment. Prefix every command with:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
```

Integration tests need live Postgres (`docker compose up -d postgres`). Docker/Postgres was unreachable for most of this session's earlier work — if still unreachable, say so explicitly and move on rather than silently skipping a step.

---

### Task 1: Extract a shared freshness-check core and add `assertApprovalFreshness`

**Files:**

- Modify: `packages/core/src/assert-export-freshness.ts`
- Modify: `packages/core/src/assert-export-freshness.test.ts`
- Create: `packages/core/src/assert-approval-freshness.ts`
- Create: `packages/core/src/assert-approval-freshness.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Read the current file first**

Read `packages/core/src/assert-export-freshness.ts` in full (it's on `main` as of PR #53 — do not assume the version quoted in the design doc's summary is byte-perfect; it includes a doc-comment on `workspaceId` and `expectedRowDigest` added in a follow-up commit). Confirm the exact current check order and types before writing anything.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/src/assert-approval-freshness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  assertApprovalFreshness,
  type AssertApprovalFreshnessDeps,
  type AssertApprovalFreshnessInput,
} from "./assert-approval-freshness.js";

const BASE_INPUT: AssertApprovalFreshnessInput = {
  workspaceId: "ws_opak",
  listingId: "listing_1",
  expectedSourceImportId: "source_import_1",
  expectedRowDigest: "digest_1",
  expectedVersionId: "version_1",
};

function depsWith(
  overrides: Partial<AssertApprovalFreshnessDeps> = {},
): AssertApprovalFreshnessDeps {
  return {
    async getPlatformProductLink() {
      return { sourceImportId: "source_import_1", contentDigest: "digest_1" };
    },
    async getActiveVersionId() {
      return "version_1";
    },
    ...overrides,
  };
}

describe("assertApprovalFreshness", () => {
  it("succeeds when every check agrees", async () => {
    const result = await assertApprovalFreshness(BASE_INPUT, depsWith());
    expect(result).toEqual({ ok: true });
  });

  it("rejects when the listing has no remote product link", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return null;
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "no_remote_link" });
  });

  it("rejects when the link's source import id does not match", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return {
            sourceImportId: "source_import_other",
            contentDigest: "digest_1",
          };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "source_import_mismatch" });
  });

  it("rejects when the link's content digest does not match", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getPlatformProductLink() {
          return {
            sourceImportId: "source_import_1",
            contentDigest: "stale_digest",
          };
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "row_digest_mismatch" });
  });

  it("rejects when the listing's active version has moved on", async () => {
    const result = await assertApprovalFreshness(
      BASE_INPUT,
      depsWith({
        async getActiveVersionId() {
          return "version_other";
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "version_mismatch" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/core test -- assert-approval-freshness.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 4: Extract the shared core and implement**

In `packages/core/src/assert-export-freshness.ts`, extract the middle four checks (remote-link, source-import-id, content-digest, active-version — everything between the `freshnessAttested` check and the `headerContractSha256` check) into a new exported function:

```ts
export type ContentFreshnessInput = {
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
};

export type ContentFreshnessDeps = {
  getPlatformProductLink(
    listingId: string,
  ): Promise<PlatformProductLink | null>;
  getActiveVersionId(listingId: string): Promise<string | null>;
};

export type ContentFreshnessFailureReason =
  | "no_remote_link"
  | "source_import_mismatch"
  | "row_digest_mismatch"
  | "version_mismatch";

export type ContentFreshnessResult =
  { ok: true } | { ok: false; reason: ContentFreshnessFailureReason };

/**
 * The four checks shared by `assertExportFreshness` (which adds an
 * attestation gate and a header-contract check on top, for the export
 * moment) and `assertApprovalFreshness` (which uses only this core, for the
 * approval moment) — kept in one place so the two gates can never silently
 * drift on what "the content still matches" means.
 */
export async function assertContentFreshness(
  input: ContentFreshnessInput,
  deps: ContentFreshnessDeps,
): Promise<ContentFreshnessResult> {
  const link = await deps.getPlatformProductLink(input.listingId);
  if (link === null) {
    return { ok: false, reason: "no_remote_link" };
  }
  if (link.sourceImportId !== input.expectedSourceImportId) {
    return { ok: false, reason: "source_import_mismatch" };
  }
  if (link.contentDigest !== input.expectedRowDigest) {
    return { ok: false, reason: "row_digest_mismatch" };
  }

  const activeVersionId = await deps.getActiveVersionId(input.listingId);
  if (activeVersionId !== input.expectedVersionId) {
    return { ok: false, reason: "version_mismatch" };
  }

  return { ok: true };
}
```

Then rewrite `assertExportFreshness`'s body to call `assertContentFreshness` after its own `freshnessAttested` check, mapping its result through (an `{ok:false}` result's `reason` is already one of `FreshnessFailureReason`'s members, since that union already includes all four of `ContentFreshnessFailureReason`'s values — confirm this by reading the current `FreshnessFailureReason` union before writing the mapping), before proceeding to its own `headerContractSha256` check. **Do not change `assertExportFreshness`'s exported types or its own test file's expectations** — its existing 7 tests (6 failure-reason + 1 success) must keep passing unmodified after this refactor; if any of them fail after the refactor, the refactor is wrong, not the test.

Create `packages/core/src/assert-approval-freshness.ts`:

```ts
import {
  assertContentFreshness,
  type ContentFreshnessDeps,
  type ContentFreshnessFailureReason,
} from "./assert-export-freshness.js";

export type AssertApprovalFreshnessDeps = ContentFreshnessDeps;

export type AssertApprovalFreshnessInput = {
  workspaceId: string;
  listingId: string;
  expectedSourceImportId: string;
  expectedRowDigest: string;
  expectedVersionId: string;
};

export type ApprovalFreshnessFailureReason = ContentFreshnessFailureReason;

export type ApprovalFreshnessResult =
  { ok: true } | { ok: false; reason: ApprovalFreshnessFailureReason };

/**
 * Gate an approval against the listing's source content having drifted
 * since review started — the same identity/content checks
 * `assertExportFreshness` performs, without that function's attestation
 * gate (which means "a human confirmed this export specifically", not
 * relevant at approval time) or its header-contract check (an export-time
 * system-integrity check).
 */
export async function assertApprovalFreshness(
  input: AssertApprovalFreshnessInput,
  deps: AssertApprovalFreshnessDeps,
): Promise<ApprovalFreshnessResult> {
  return assertContentFreshness(input, deps);
}
```

- [ ] **Step 5: Export the new symbols and run tests to verify they pass**

In `packages/core/src/index.ts`, add:

```ts
export { assertApprovalFreshness } from "./assert-approval-freshness.js";
export type {
  ApprovalFreshnessFailureReason,
  ApprovalFreshnessResult,
  AssertApprovalFreshnessDeps,
  AssertApprovalFreshnessInput,
} from "./assert-approval-freshness.js";
export { assertContentFreshness } from "./assert-export-freshness.js";
export type {
  ContentFreshnessDeps,
  ContentFreshnessFailureReason,
  ContentFreshnessInput,
  ContentFreshnessResult,
} from "./assert-export-freshness.js";
```

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/core test
```

Expected: PASS — all `assert-export-freshness.test.ts` tests (unchanged) plus all new `assert-approval-freshness.test.ts` tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/assert-export-freshness.ts packages/core/src/assert-export-freshness.test.ts packages/core/src/assert-approval-freshness.ts packages/core/src/assert-approval-freshness.test.ts packages/core/src/index.ts
git commit -m "refactor: share a content-freshness core between export and approval gates"
```

---

### Task 2: `review_confirmations` schema and repository

**Files:**

- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0012_review_confirmations.sql`
- Create: `packages/db/src/repositories/review-confirmations.ts`
- Create: `packages/db/src/repositories/review-confirmations.integration.test.ts`
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Read `listingDrafts`'s current schema definition first**

Read the `listingDrafts` table in `packages/db/src/schema.ts` to confirm its exact column names (`id`, `workspaceId`) for the new foreign key, and read `packages/db/drizzle/0011_source_imports_connection_index.sql` (the most recent migration) to confirm the exact idempotent-SQL conventions to match (this repo re-runs every migration file on every `migrate()` call, per `packages/db/src/migrations.ts` — every statement must be `IF NOT EXISTS`/DO-block-guarded).

- [ ] **Step 2: Write the failing integration test**

Create `packages/db/src/repositories/review-confirmations.integration.test.ts`, mirroring `source-imports.integration.test.ts`'s exact fixture/lifecycle style:

```ts
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

const workspaceId = "ws_review_confirmations";
const otherWorkspaceId = "ws_review_confirmations_other";

describe("review confirmations repository", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: ignoreNotice,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

  beforeAll(async () => {
    await admin.unsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
          CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await database.migrate();
    await admin.unsafe("TRUNCATE TABLE workspaces, users CASCADE");
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${workspaceId}', '${workspaceId}', '{}'::jsonb),
        ('${otherWorkspaceId}', '${otherWorkspaceId}', '{}'::jsonb);
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const upsertInputFor = (versionId: string) => ({
    listingId: "11111111-1111-4111-8111-111111111111",
    versionId,
    fieldConfirmations: { nameZh: true, seoTitleEn: false },
    negativeConfirmations: { priceUnchanged: true, noImageChange: false },
    sourceImportId: null,
    rowDigest: null,
  });

  it("creates a confirmation, reads it back, and increments revision on upsert", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.reviewConfirmations.upsert(
        upsertInputFor("22222222-2222-4222-8222-222222222222"),
      );
      expect(created.revision).toBe(0);
      expect(created.fieldConfirmations).toEqual({
        nameZh: true,
        seoTitleEn: false,
      });

      const updated = await repositories.reviewConfirmations.upsert({
        ...upsertInputFor("22222222-2222-4222-8222-222222222222"),
        fieldConfirmations: { nameZh: true, seoTitleEn: true },
      });
      expect(updated.revision).toBe(1);
      expect(updated.fieldConfirmations).toEqual({
        nameZh: true,
        seoTitleEn: true,
      });

      const found = await repositories.reviewConfirmations.getByVersionId(
        "22222222-2222-4222-8222-222222222222",
      );
      expect(found?.revision).toBe(1);
    });
  });

  it("never exposes a confirmation to another workspace", async () => {
    await database.forWorkspace(workspaceId, (repositories) =>
      repositories.reviewConfirmations.upsert(
        upsertInputFor("33333333-3333-4333-8333-333333333333"),
      ),
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      expect(
        await repositories.reviewConfirmations.getByVersionId(
          "33333333-3333-4333-8333-333333333333",
        ),
      ).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
docker compose up -d postgres
pnpm test:integration -- review-confirmations.integration.test.ts
```

Expected: FAIL — `repositories.reviewConfirmations` is undefined.

- [ ] **Step 4: Implement schema, migration, and repository**

In `packages/db/src/schema.ts`, add (after `sourceImports`, following that table's exact style):

```ts
export const reviewConfirmations = pgTable(
  "review_confirmations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    listingId: uuid("listing_id").notNull(),
    versionId: uuid("version_id").notNull(),
    fieldConfirmations: jsonb("field_confirmations")
      .$type<Record<string, boolean>>()
      .notNull(),
    negativeConfirmations: jsonb("negative_confirmations")
      .$type<Record<string, boolean>>()
      .notNull(),
    revision: integer("revision").notNull().default(0),
    sourceImportId: uuid("source_import_id"),
    rowDigest: text("row_digest"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("review_confirmations_workspace_version_uq").on(
      table.workspaceId,
      table.versionId,
    ),
    foreignKey({
      name: "review_confirmations_workspace_listing_fkey",
      columns: [table.workspaceId, table.listingId],
      foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
    }).onDelete("cascade"),
  ],
);
```

Create `packages/db/drizzle/0012_review_confirmations.sql` matching `0010_source_imports.sql`'s exact idempotency conventions (`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, the standard RLS enable/force/policy/grant block, and a DO-block-guarded FK to `listing_drafts`):

```sql
CREATE TABLE IF NOT EXISTS review_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  version_id uuid NOT NULL,
  field_confirmations jsonb NOT NULL,
  negative_confirmations jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  source_import_id uuid,
  row_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_confirmations_workspace_version_uq
  ON review_confirmations (workspace_id, version_id);

ALTER TABLE review_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_confirmations_workspace_policy ON review_confirmations;
CREATE POLICY review_confirmations_workspace_policy ON review_confirmations
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_confirmations TO wukong_app;

DO $review_confirmations_workspace_listing_fkey$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_confirmations_workspace_listing_fkey'
  ) THEN
    ALTER TABLE review_confirmations
      ADD CONSTRAINT review_confirmations_workspace_listing_fkey
      FOREIGN KEY (workspace_id, listing_id)
      REFERENCES listing_drafts (workspace_id, id)
      ON DELETE CASCADE;
  END IF;
END
$review_confirmations_workspace_listing_fkey$;
```

Read `packages/db/src/repositories/listings.ts`'s FK reference to `listing_drafts` (it must already have a composite `(workspace_id, id)` unique index on `listing_drafts` for this pattern to work, matching `platform_products`'s existing FK to it — confirm this exists before assuming the migration above is correct).

Create `packages/db/src/repositories/review-confirmations.ts`, modeling `source-imports.ts`'s `create`/`getById` shape but with `upsert` (insert-or-update-with-incremented-revision) instead of a plain `create`:

```ts
import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { reviewConfirmations } from "../schema.js";

export type UpsertReviewConfirmationInput = {
  listingId: string;
  versionId: string;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  sourceImportId: string | null;
  rowDigest: string | null;
};

export type ReviewConfirmation = {
  id: string;
  listingId: string;
  versionId: string;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  revision: number;
  sourceImportId: string | null;
  rowDigest: string | null;
};

export type ReviewConfirmationRepository = {
  upsert(input: UpsertReviewConfirmationInput): Promise<ReviewConfirmation>;
  getByVersionId(versionId: string): Promise<ReviewConfirmation | null>;
};

const COLUMNS = {
  id: reviewConfirmations.id,
  listingId: reviewConfirmations.listingId,
  versionId: reviewConfirmations.versionId,
  fieldConfirmations: reviewConfirmations.fieldConfirmations,
  negativeConfirmations: reviewConfirmations.negativeConfirmations,
  revision: reviewConfirmations.revision,
  sourceImportId: reviewConfirmations.sourceImportId,
  rowDigest: reviewConfirmations.rowDigest,
};

export function createReviewConfirmationRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ReviewConfirmationRepository {
  return {
    async upsert(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(reviewConfirmations)
        .values({ ...input, workspaceId, revision: 0 })
        .onConflictDoUpdate({
          target: [
            reviewConfirmations.workspaceId,
            reviewConfirmations.versionId,
          ],
          set: {
            fieldConfirmations: input.fieldConfirmations,
            negativeConfirmations: input.negativeConfirmations,
            sourceImportId: input.sourceImportId,
            rowDigest: input.rowDigest,
            revision: sql`${reviewConfirmations.revision} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning(COLUMNS);
      if (!row)
        throw new Error("review confirmation upsert did not return a row");
      return row;
    },

    async getByVersionId(versionId) {
      scope.assertOpen();
      const [row] = await transaction
        .select(COLUMNS)
        .from(reviewConfirmations)
        .where(
          and(
            eq(reviewConfirmations.workspaceId, workspaceId),
            eq(reviewConfirmations.versionId, versionId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}
```

- [ ] **Step 5: Register the repository and run tests to verify they pass**

In `packages/db/src/client.ts`, add the import, add `reviewConfirmations: ReviewConfirmationRepository;` to `WorkspaceRepositories`, and construct it inside `runForWorkspace` alongside the other repositories — read the file first to place these correctly (same three-part pattern as every other repository registration).

In `packages/db/src/index.ts`, add:

```ts
export type {
  ReviewConfirmation,
  ReviewConfirmationRepository,
  UpsertReviewConfirmationInput,
} from "./repositories/review-confirmations.js";
```

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm test:integration -- review-confirmations.integration.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 6: Add this new table to the tenant-table and composite-FK release gates**

Per the pattern already established in this session's `9579912` commit: add `"review_confirmations"` to `TENANT_TABLES` in `packages/db/src/cli/audit-verify.ts`, and add the new `review_confirmations` → `listing_drafts` composite FK to the expected-FK list in `packages/db/src/repositories/listings.integration.test.ts`'s "uses workspace-consistent composite foreign keys for every tenant relationship" test. Run `pnpm test:integration -- audit-verify.integration.test.ts listings.integration.test.ts` to confirm both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0012_review_confirmations.sql packages/db/src/repositories/review-confirmations.ts packages/db/src/repositories/review-confirmations.integration.test.ts packages/db/src/client.ts packages/db/src/index.ts packages/db/src/cli/audit-verify.ts packages/db/src/repositories/listings.integration.test.ts
git commit -m "feat: add the review_confirmations ledger table and repository"
```

---

### Task 3: `PATCH /api/listings/[id]/review-confirmations` route

**Files:**

- Create: `apps/web/app/api/listings/[id]/review-confirmations/route.ts`
- Create: `apps/web/app/api/listings/[id]/review-confirmations/route.test.ts`

- [ ] **Step 1: Read the flags/resolve route first**

Read `apps/web/app/api/listings/[id]/flags/resolve/route.ts` and its test in full — it's the closest sibling (a `POST`-with-`[id]`-param route on a review-adjacent sub-resource, reviewer-role-gated) and this new route should mirror its exact structure (deps shape, role gate, `RouteContext`, error mapping).

- [ ] **Step 2: Write the failing test**

Create `apps/web/app/api/listings/[id]/review-confirmations/route.test.ts`, mirroring the structure read in Step 1. Cover: a reviewer can upsert a confirmation and gets back the new `revision`; a viewer gets 403; the request body's `fieldConfirmations`/`negativeConfirmations` are validated as `Record<string, boolean>` (reject a non-boolean value with 400).

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/review-confirmations/route.test.ts"
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/app/api/listings/[id]/review-confirmations/route.ts` mirroring the flags/resolve route's structure exactly (same imports, same `assertReviewer`-equivalent role gate — reuse the actual helper from that file if it's exported, or copy its inline check if it's private). The handler:

1. Requires a reviewer role.
2. Awaits `context.params` for `id` (the listing id).
3. Parses the body with a Zod schema: `{ versionId: z.string().min(1), fieldConfirmations: z.record(z.string(), z.boolean()), negativeConfirmations: z.record(z.string(), z.boolean()) }`.
4. Looks up the listing's `platform_products` link via `repositories.platformProducts.getByListingId(id)` (already exists, confirmed in an earlier package this session) to populate `sourceImportId`/`rowDigest` — `null`/`null` for a create-origin listing with no link.
5. Calls `repositories.reviewConfirmations.upsert({...})` inside `forWorkspace`, writes an audit event (`review_confirmation.updated`, metadata: `{versionId, revision}` — no field content, matching this codebase's audit-metadata-is-identifiers-only convention), and returns `jsonResponse(200, {revision: result.revision, fieldConfirmations: result.fieldConfirmations, negativeConfirmations: result.negativeConfirmations})`.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/review-confirmations/route.test.ts"
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/[id]/review-confirmations/route.ts" "apps/web/app/api/listings/[id]/review-confirmations/route.test.ts"
git commit -m "feat: add PATCH /api/listings/[id]/review-confirmations"
```

---

### Task 4: Extend the listing snapshot route with the confirmation state

**Files:**

- Modify: `apps/web/app/api/listings/[id]/route.ts`
- Modify: `apps/web/app/api/listings/[id]/route.test.ts`
- Modify: `apps/web/components/listing-review-client.tsx` (the `ListingViewResponse` type only, in this task — UI wiring is Task 6)

- [ ] **Step 1: Read the current snapshot route and `getReviewSnapshot` first**

Read `apps/web/app/api/listings/[id]/route.ts` (the `GET` handler) and `packages/db/src/repositories/listings.ts`'s `getReviewSnapshot` method in full to find the exact current response-building code and the exact shape `ReviewableListing`/the snapshot object takes.

- [ ] **Step 2: Write the failing test**

Extend the existing test file with a case proving the response includes a `reviewConfirmation` field: `null` when no confirmation row exists yet for the active version, or `{revision, fieldConfirmations, negativeConfirmations}` when one does. Also add `sourceImportId`/`contentDigest` (nullable) to the response for import-origin listings, read from `platformProducts.getByListingId(id)` — Task 7 needs these on the client to send back at approval time.

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 4: Implement it**

Add a call to `repositories.reviewConfirmations.getByVersionId(activeVersion.id)` (only when `activeVersion` is non-null) and `repositories.platformProducts.getByListingId(id)`, alongside the route's existing reads. Include `reviewConfirmation` (or `null`), `sourceImportId` (or `null`), and `contentDigest` (or `null`) in the JSON response. Extend `ListingViewResponse` in `apps/web/components/listing-review-client.tsx` with:

```ts
  reviewConfirmation: {
    revision: number;
    fieldConfirmations: Record<string, boolean>;
    negativeConfirmations: Record<string, boolean>;
  } | null;
  sourceImportId: string | null;
  contentDigest: string | null;
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/route.test.ts"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/[id]/route.ts" "apps/web/app/api/listings/[id]/route.test.ts" apps/web/components/listing-review-client.tsx
git commit -m "feat: include review confirmation and source-import state in the listing snapshot"
```

---

### Task 5: SEO review fields

**Files:**

- Modify: `apps/web/components/listing-review-client.tsx`
- Modify: `apps/web/components/listing-review-client.test.ts`
- Modify: `apps/web/components/listing-fields-form.tsx`
- Modify: `apps/web/components/listing-fields-form.test.tsx`

- [ ] **Step 1: Read both current test files first**

Read `apps/web/components/listing-review-client.test.ts` and `apps/web/components/listing-fields-form.test.tsx` in full to find the exact fixture shape (`ReviewableListing`/`CanonicalListing` literals) already in use, so the new SEO-field tests use realistic, consistent fixture data rather than inventing a new shape.

- [ ] **Step 2: Write the failing tests**

In `listing-review-client.test.ts`, extend the existing `mapListingView`/`applyListingFields` round-trip test(s) with `seo: {title: {en: "...", "zh-Hant": "..."}, description: {en: "...", "zh-Hant": "..."}}, tags: ["a", "b"]` in the fixture content, asserting the 5 new `ListingField` entries appear with the correct `key`/`value` and that `applyListingFields` reconstructs the same `seo`/`tags` shape from the edited fields (including the comma-split for `tags`).

In `listing-fields-form.test.tsx`, extend with a test asserting the new "SEO 與標籤" field group renders when the 5 new keys are present in `model.fields`.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- listing-review-client.test.ts listing-fields-form.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Implement it**

In `apps/web/components/listing-review-client.tsx`'s `mapListingView`, add 5 new `field(...)` entries after the existing `descriptionEn` entry, mirroring the `titleEn`/`titleZhHant` pattern exactly:

```ts
    field(response.evidence, {
      key: "seoTitleEn",
      label: "SEO 標題（英文）",
      englishLabel: "SEO title (English)",
      value: content.seo.title.en,
      evidenceKey: "seo.title.en",
    }),
    field(response.evidence, {
      key: "seoTitleZh",
      label: "SEO 標題（繁中）",
      englishLabel: "SEO title (Traditional Chinese)",
      value: content.seo.title["zh-Hant"],
      evidenceKey: "seo.title.zh-Hant",
    }),
    field(response.evidence, {
      key: "seoDescriptionEn",
      label: "SEO 描述（英文）",
      englishLabel: "SEO description (English)",
      value: content.seo.description.en,
      evidenceKey: "seo.description.en",
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "seoDescriptionZh",
      label: "SEO 描述（繁中）",
      englishLabel: "SEO description (Traditional Chinese)",
      value: content.seo.description["zh-Hant"],
      evidenceKey: "seo.description.zh-Hant",
      kind: "textarea",
    }),
    field(response.evidence, {
      key: "seoKeywords",
      label: "SEO 關鍵字",
      englishLabel: "SEO keywords",
      value: content.tags.join(", "),
    }),
```

In `applyListingFields`, add after the existing `description` entry:

```ts
    seo: {
      title: {
        en: valueOf(fields, "seoTitleEn"),
        "zh-Hant": valueOf(fields, "seoTitleZh"),
      },
      description: {
        en: valueOf(fields, "seoDescriptionEn"),
        "zh-Hant": valueOf(fields, "seoDescriptionZh"),
      },
    },
    tags: valueOf(fields, "seoKeywords")
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean),
```

In `apps/web/components/listing-fields-form.tsx`, add a 4th entry to the `groups` array:

```ts
  {
    label: "SEO 與標籤",
    englishLabel: "SEO & tags",
    keys: [
      "seoTitleEn",
      "seoTitleZh",
      "seoDescriptionEn",
      "seoDescriptionZh",
      "seoKeywords",
    ],
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- listing-review-client.test.ts listing-fields-form.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/listing-review-client.tsx apps/web/components/listing-review-client.test.ts apps/web/components/listing-fields-form.tsx apps/web/components/listing-fields-form.test.tsx
git commit -m "feat: add the 5 unreviewed SEO fields to the review UI"
```

---

### Task 6: `ConfirmationChecklist` component

**Files:**

- Create: `apps/web/components/confirmation-checklist.tsx`
- Create: `apps/web/components/confirmation-checklist.test.tsx`
- Modify: `apps/web/components/listing-review-client.tsx` (wire it in)
- Modify: `apps/web/components/listing-fields-form.tsx` (extend `approvalDisabled`)

- [ ] **Step 1: Read `compliance-flags.tsx` first**

Read `apps/web/components/compliance-flags.tsx` in full (already partly known: a checklist-with-explicit-action component) to mirror its exact structural conventions (CSS classes, ARIA pattern, busy/pending-state handling).

- [ ] **Step 2: Write the failing test**

Create `apps/web/components/confirmation-checklist.test.tsx`. Cover: all 15 items (8 field + 7 negative) render as checkboxes with their zh/en labels; toggling one calls `onChange` with the updated confirmation maps; an "all confirmed" summary is derivable and exposed (e.g. via a data attribute or a rendered count) so `ListingFieldsForm` can gate on it.

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- confirmation-checklist.test.tsx
```

Expected: FAIL.

- [ ] **Step 4: Implement it**

Create `apps/web/components/confirmation-checklist.tsx` with hardcoded label maps for the 8 field keys and 7 negative-confirmation keys (bilingual, matching `GAP_LABELS`'s style from `create-batch-form.tsx` in the prior package):

```ts
const FIELD_LABELS: Record<string, { zh: string; en: string }> = {
  nameZh: { zh: "商品名稱（繁中）", en: "Name (zh)" },
  summaryEn: { zh: "摘要（英文）", en: "Summary (en)" },
  summaryZh: { zh: "摘要（繁中）", en: "Summary (zh)" },
  seoTitleEn: { zh: "SEO 標題（英文）", en: "SEO title (en)" },
  seoTitleZh: { zh: "SEO 標題（繁中）", en: "SEO title (zh)" },
  seoDescriptionEn: { zh: "SEO 描述（英文）", en: "SEO description (en)" },
  seoDescriptionZh: { zh: "SEO 描述（繁中）", en: "SEO description (zh)" },
  seoKeywords: { zh: "SEO 關鍵字", en: "SEO keywords" },
};

const NEGATIVE_LABELS: Record<string, { zh: string; en: string }> = {
  priceUnchanged: { zh: "售價未變動", en: "Price unchanged" },
  membershipUnchanged: { zh: "會員權益未變動", en: "Membership unchanged" },
  categoryUnchanged: { zh: "分類未變動", en: "Category unchanged" },
  statusUnchanged: { zh: "上下架狀態未變動", en: "Status unchanged" },
  supplierUnchanged: { zh: "供應商未變動", en: "Supplier unchanged" },
  quantityDeltaNeutral: { zh: "數量差額為中性", en: "Quantity delta neutral" },
  noImageChange: { zh: "圖片無變動", en: "No image change" },
};

export const CONFIRMATION_FIELD_KEYS = Object.keys(FIELD_LABELS);
export const CONFIRMATION_NEGATIVE_KEYS = Object.keys(NEGATIVE_LABELS);

export function allConfirmed(
  fieldConfirmations: Record<string, boolean>,
  negativeConfirmations: Record<string, boolean>,
): boolean {
  return (
    CONFIRMATION_FIELD_KEYS.every((key) => fieldConfirmations[key] === true) &&
    CONFIRMATION_NEGATIVE_KEYS.every(
      (key) => negativeConfirmations[key] === true,
    )
  );
}
```

Plus a `ConfirmationChecklist` component taking `{fieldConfirmations, negativeConfirmations, onChange, canConfirm}` and rendering two `<fieldset>` groups of checkboxes (mirroring `compliance-flags.tsx`'s `<section>`/heading/list structure), calling `onChange(nextFieldConfirmations, nextNegativeConfirmations)` on each toggle.

In `apps/web/components/listing-fields-form.tsx`, extend `approvalDisabled` to also require `allConfirmed(...)` — this needs the confirmation state passed in as a new prop, since `ListingFieldsForm` doesn't currently hold it; add `fieldConfirmations`/`negativeConfirmations` props to `ListingFieldsFormProps`.

In `apps/web/components/listing-review-client.tsx`, render `<ConfirmationChecklist>` between `ListingFieldsForm` and `ComplianceFlags`, holding the confirmation state in a new `useState`, initialized from `snapshot.reviewConfirmation` (Task 4), and wire its `onChange` to call `PATCH /api/listings/[id]/review-confirmations` (Task 3) with the updated maps, then reload the snapshot — matching `resolveFlag`'s existing `run(...)`-wrapped pattern.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- confirmation-checklist.test.tsx listing-fields-form.test.tsx listing-review-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/confirmation-checklist.tsx apps/web/components/confirmation-checklist.test.tsx apps/web/components/listing-review-client.tsx apps/web/components/listing-fields-form.tsx
git commit -m "feat: add the confirmation checklist and gate approval on it"
```

---

### Task 7: Bind `POST /api/listings/[id]/approve` to the freshness gate

**Files:**

- Modify: `apps/web/app/api/listings/[id]/approve/route.ts`
- Modify: `apps/web/app/api/listings/[id]/approve/route.test.ts`
- Modify: `apps/web/lib/listing-approval.ts`
- Modify: `apps/web/components/listing-review-client.tsx`

- [ ] **Step 1: Re-read the current approve route and `approveOne` in full**

The route has 3 phases: role+body-parse, optional non-transactional product-shot flatten, then a final `db.forWorkspace(...)` call to `approveOne`. The new checks belong in phase 1 (fail fast, before any I/O), except the actual `assertApprovalFreshness` call, which needs a real `getPlatformProductLink`/`getActiveVersionId` read — these should happen inside a `forWorkspace` call, so add a small new read-only `forWorkspace` call in phase 1 (before the product-shot phase) rather than threading them through `approveOne`'s existing transaction, since a failed freshness check must reject before any product-shot I/O runs, matching the file's own existing "cheap checks before expensive work" ordering (already established for the role check).

- [ ] **Step 2: Write the failing tests**

Extend `apps/web/app/api/listings/[id]/approve/route.test.ts` (read it first to find the exact existing `handlerFor`/fixture conventions) with cases: approving without `expectedVersionId` in the body → 400; `expectedVersionId` not matching the snapshot's active version → 409 `version_conflict`; `confirmationLedgerRevision` not matching the ledger's current revision → 409 `confirmation_ledger_stale`; approving with an incomplete confirmation checklist → 422 `confirmation_incomplete`; an import-origin listing approved without `sourceImportId`/`expectedRowDigest` → 400 `source_freshness_required`; an import-origin listing whose freshness check fails (mismatched digest) → 409 with the failure reason as the error code; a create-origin listing (no `platform_products` link) approved successfully WITHOUT `sourceImportId`/`expectedRowDigest` in the body, since it has nothing to check against.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/approve/route.test.ts"
```

Expected: FAIL.

- [ ] **Step 4: Implement it**

Extend `bodySchema`:

```ts
const bodySchema = z
  .object({
    background: z.enum(["white", "brand"]).optional(),
    expectedVersionId: z.string().min(1),
    confirmationLedgerRevision: z.number().int().nonnegative(),
    sourceImportId: z.string().min(1).optional(),
    expectedRowDigest: z.string().min(1).optional(),
  })
  .strip();
```

Right after parsing the body (before the product-shot phase), add a new read-only `forWorkspace` call:

```ts
await db.forWorkspace(session.workspaceId, async (repositories) => {
  const snapshot = await repositories.listings.getReviewSnapshot(id);
  if (!snapshot?.activeVersion) {
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  }
  if (snapshot.activeVersion.id !== parsedBody.expectedVersionId) {
    throw new ApiError(
      409,
      "version_conflict",
      "This listing has changed since you started reviewing it.",
    );
  }

  const confirmation = await repositories.reviewConfirmations.getByVersionId(
    snapshot.activeVersion.id,
  );
  if (
    (confirmation?.revision ?? -1) !== parsedBody.confirmationLedgerRevision
  ) {
    throw new ApiError(
      409,
      "confirmation_ledger_stale",
      "The confirmation checklist has changed since you loaded it.",
    );
  }
  if (
    !confirmation ||
    !allConfirmed(
      confirmation.fieldConfirmations,
      confirmation.negativeConfirmations,
    )
  ) {
    throw new ApiError(
      422,
      "confirmation_incomplete",
      "Complete the confirmation checklist before approving.",
    );
  }

  const link = await repositories.platformProducts.getByListingId(id);
  if (link !== null) {
    if (!parsedBody.sourceImportId || !parsedBody.expectedRowDigest) {
      throw new ApiError(
        400,
        "source_freshness_required",
        "This listing is linked to an imported product and requires freshness fields.",
      );
    }
    const result = await assertApprovalFreshness(
      {
        workspaceId: session.workspaceId,
        listingId: id,
        expectedSourceImportId: parsedBody.sourceImportId,
        expectedRowDigest: parsedBody.expectedRowDigest,
        expectedVersionId: parsedBody.expectedVersionId,
      },
      {
        async getPlatformProductLink() {
          return link;
        },
        async getActiveVersionId() {
          return snapshot.activeVersion?.id ?? null;
        },
      },
    );
    if (!result.ok) {
      throw new ApiError(
        409,
        result.reason,
        "This listing's source data no longer matches what was reviewed.",
      );
    }
  }
});
```

Adjust field/method names above to match what `getReviewSnapshot`/`platformProducts.getByListingId`/`ApiError` actually look like once you've read them in Step 1 — this sketch is illustrative of the check order and fail-fast placement, not necessarily byte-exact. Import `assertApprovalFreshness` from `@wukong/core` and `allConfirmed` from `../../../../../components/confirmation-checklist` (adjust the relative path to the actual route file depth). If importing a component file into a route file feels wrong once you see the real directory structure, move `allConfirmed`/`CONFIRMATION_FIELD_KEYS`/`CONFIRMATION_NEGATIVE_KEYS` into a small shared module (e.g. `apps/web/lib/review-confirmation-keys.ts`) that both the route and the component import from instead, and update Task 6's component to import from there too — note this deviation explicitly in your report.

In `apps/web/components/listing-review-client.tsx`'s `approve()` function, extend the POST body using the `sourceImportId`/`contentDigest`/`reviewConfirmation` fields Task 4 already added to `ListingViewResponse`:

```ts
        body: JSON.stringify({
          expectedVersionId: model.versionId,
          confirmationLedgerRevision: snapshot.reviewConfirmation?.revision ?? 0,
          ...(snapshot.sourceImportId && snapshot.contentDigest
            ? { sourceImportId: snapshot.sourceImportId, expectedRowDigest: snapshot.contentDigest }
            : {}),
        }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/approve/route.test.ts" listing-review-client.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/[id]/approve/route.ts" "apps/web/app/api/listings/[id]/approve/route.test.ts" apps/web/lib/listing-approval.ts apps/web/components/listing-review-client.tsx
git commit -m "feat: bind listing approval to the confirmation ledger and freshness gate"
```

---

### Task 8: Full-suite verification

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

Expected: PASS, or fix flagged files with `pnpm exec prettier --write` and re-check.

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

Expected: PASS, all packages, including the new `review-confirmations.integration.test.ts`. If Postgres is unreachable, state that explicitly rather than reporting this step as passed.

- [ ] **Step 5: `pnpm runtime:forbidden:check`**

Run:

```powershell
$env:PATH = "C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\bin;" + $env:PATH
pnpm runtime:forbidden:check
```

Expected: PASS.

---

## Self-Review

**Spec coverage:** §2 (SEO fields) → Task 5. §3 (ledger schema + UI) → Tasks 2, 3, 4, 6. §4 (approval binding, shared freshness core, invalidation) → Tasks 1, 7 (invalidation itself needs no new code, per the design's §4 analysis — a new version simply has no confirmation row).

**Placeholder scan:** Task 7's Step 4 explicitly flags two points needing the implementer's judgment once real file contents are in hand (exact `getReviewSnapshot` field names, and the fallback if importing a component into a route file proves awkward) rather than guessing — this is a deliberate "read and adapt" instruction, not a placeholder, since the approve route's full internal structure (read this turn) is complex enough that a byte-exact sketch risks being wrong in ways worth flagging explicitly rather than silently.

**Type consistency:** `ContentFreshnessFailureReason`/`ApprovalFreshnessFailureReason` (Task 1) are the same union, verified explicitly in Task 1's Step 4. `ReviewConfirmation`'s field names match exactly between the repository (Task 2), the route (Task 3), the snapshot response (Task 4), and the checklist component (Task 6). `ListingViewResponse`'s `sourceImportId`/`contentDigest`/`reviewConfirmation` fields (added in Task 4) are exactly what Task 7's client-side `approve()` reads.
