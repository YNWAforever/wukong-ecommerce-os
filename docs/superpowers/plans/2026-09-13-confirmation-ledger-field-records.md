# Confirmation Ledger Per-Field Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, for each of the eight AI-writable confirmation fields, a digest of the confirmed value, of the merchant's imported cell, and of the grounding the AI offered — so a UAT stage can cite what each tick was made against.

**Architecture:** One additive nullable `jsonb` column on `review_confirmations` (migration `0027`). A leaf module binds each confirmation key to its content path and evidence key; a server-only module hashes the snapshot, evidence and imported row into records; the existing `PATCH` confirmation route writes them. Approval, `getByVersionId`'s shape and the request schema are unchanged.

**Tech Stack:** pnpm 11.7 via corepack · TypeScript strict + `noUncheckedIndexedAccess` · Next.js 16 route handlers · Drizzle ORM + raw SQL migrations on Postgres · Vitest (unit + integration) · `node:crypto` sha256.

**Spec:** [confirmation-ledger field records design](../specs/2026-09-13-confirmation-ledger-field-records-design.md). Read its "Corrections to the approved draft" section first.

---

## Before you start

`pnpm` is not on PATH on this machine — always run `corepack pnpm`.

Integration tests need the local stack and the non-superuser app role. From the repository root:

```bash
docker compose up -d postgres minio minio-tls mailpit
docker compose exec -T postgres psql -U wukong -d postgres -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END \$\$;"
export DATABASE_ADMIN_URL=postgres://wukong:wukong@localhost:54329/wukong
export DATABASE_URL=postgres://wukong_app:wukong-app-local@localhost:54329/wukong
export TEST_DATABASE_ADMIN_URL=$DATABASE_ADMIN_URL
export TEST_DATABASE_URL=$DATABASE_URL
corepack pnpm --filter @wukong/db... build
```

Three rules this project has learned the hard way:

- **Every migration must be idempotent.** `migrate()` re-runs every SQL file on every invocation; there is no applied-migrations table.
- **A Postgres `CHECK` is invisible to fake repositories.** Only an integration test against real Postgres proves it.
- **Run `format:runtime:check` after committing.** It derives its file set from the committed diff, so running it on uncommitted work checks the wrong files.

## File structure

| File                                                                           | Responsibility                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Create `packages/db/drizzle/0027_review_confirmation_field_records.sql`        | Additive nullable column + object CHECK, idempotent                  |
| Modify `packages/db/src/schema.ts`                                             | Drizzle definition of `fieldRecords`                                 |
| Modify `packages/db/src/repositories/review-confirmations.ts`                  | Record types, optional write, narrow read                            |
| Modify `packages/db/src/index.ts`                                              | Export the record types                                              |
| Modify `packages/db/src/repositories/review-confirmations.integration.test.ts` | Real-Postgres proof of column, CHECK, write, read, scoping           |
| Create `apps/web/lib/review-field-bindings.ts`                                 | Leaf: confirmation key → content reader + evidence key (client-safe) |
| Create `apps/web/lib/review-field-bindings.test.ts`                            | Keys and paths                                                       |
| Create `apps/web/lib/review-field-records.ts`                                  | Server-only: hash content, cell and evidence into records            |
| Create `apps/web/lib/review-field-records.test.ts`                             | Digest semantics                                                     |
| Modify `apps/web/components/listing-review-client.tsx`                         | Consume the bindings' evidence keys                                  |
| Modify `apps/web/app/api/listings/[id]/review-confirmations/route.ts`          | Build and write records; audit counts                                |
| Modify `apps/web/app/api/listings/[id]/review-confirmations/route.test.ts`     | Route behaviour                                                      |
| Modify `docs/implementation/wukong-remediation-verification.md`                | Deployment constraints for `0026` and `0027`                         |
| Modify `docs/superpowers/plans/2026-09-11-release-gate-closure.md`             | Record W6 as done                                                    |

---

### Task 1: Migration `0027` and the schema column

**Files:**

- Create: `packages/db/drizzle/0027_review_confirmation_field_records.sql`
- Modify: `packages/db/src/schema.ts` (the `reviewConfirmations` table)
- Test: `packages/db/src/repositories/review-confirmations.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

In `packages/db/src/repositories/review-confirmations.integration.test.ts`, insert these two tests immediately before the final `});` that closes `describe("review confirmations repository", ...)`:

```ts
// The dedicated migration-rehearsal harness drops the schema and is skipped
// in CI. This proves 0027 is replay-safe where CI actually runs it:
// beforeAll already migrated once, so this is the second application.
it("adds field_records as a nullable column that survives a repeated migration", async () => {
  await database.migrate();

  const [column] = await admin`
      select is_nullable, data_type
      from information_schema.columns
      where table_name = 'review_confirmations'
        and column_name = 'field_records'`;
  expect(column).toEqual({ is_nullable: "YES", data_type: "jsonb" });

  const constraints = await admin`
      select conname from pg_constraint
      where conrelid = 'review_confirmations'::regclass
        and conname = 'review_confirmations_field_records_is_object'`;
  expect(constraints).toHaveLength(1);
});

// Fake repositories cannot see a CHECK. Only a real write can.
it("refuses a field_records value that is not an object", async () => {
  const { versionId } = await database.forWorkspace(
    workspaceId,
    async (repositories) => {
      const { listingId, versionId } = await createDraftAndVersion(
        repositories,
        workspaceId,
      );
      await repositories.reviewConfirmations.upsert(
        upsertInputFor(listingId, versionId),
      );
      return { versionId };
    },
  );

  await expect(
    admin`update review_confirmations
        set field_records = '[]'::jsonb
        where version_id = ${versionId}`,
  ).rejects.toThrow(/review_confirmations_field_records_is_object/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
corepack pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/review-confirmations.integration.test.ts
```

Expected: FAIL. The first test fails because `column` is `undefined`; the second because the column does not exist yet.

- [ ] **Step 3: Write the migration**

Create `packages/db/drizzle/0027_review_confirmation_field_records.sql`:

```sql
-- What each confirmed field was confirmed against.
--
-- The ledger recorded a field-granular confirmation at row granularity: eight
-- booleans said someone ticked eight boxes, and nothing said what was in front
-- of them for any one. The ingredients already existed -- the immutable
-- version, the imported row, field_evidence -- and this column binds a tick to
-- them as digests, derived server-side.
--
-- Nullable on purpose, and not back-filled: NULL means "confirmed before this
-- existed", which is true of every historical row. Recomputing digests now
-- would fabricate evidence for a review nobody performed at that time.
--
-- Strictly additive. review_confirmations already has row-level security and a
-- workspace policy, which this column inherits, so there are no policy changes
-- here. Re-running the file is a no-op.
ALTER TABLE review_confirmations
  ADD COLUMN IF NOT EXISTS field_records jsonb;

DO $field_records_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'review_confirmations'::regclass
      AND conname = 'review_confirmations_field_records_is_object'
  ) THEN
    ALTER TABLE review_confirmations
      ADD CONSTRAINT review_confirmations_field_records_is_object
      CHECK (
        field_records IS NULL
        OR jsonb_typeof(field_records) = 'object'
      );
  END IF;
END
$field_records_check$;
```

- [ ] **Step 4: Add the column to the Drizzle schema**

In `packages/db/src/schema.ts`, replace:

```ts
    sourceImportId: uuid("source_import_id"),
    rowDigest: text("row_digest"),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("review_confirmations_workspace_version_uq").on(
```

with:

```ts
    sourceImportId: uuid("source_import_id"),
    rowDigest: text("row_digest"),
    // What each confirmed field was confirmed against (0027). NULL for every
    // row written before it existed. Shape documented on ReviewFieldRecord in
    // repositories/review-confirmations.ts.
    fieldRecords: jsonb("field_records").$type<
      Record<
        string,
        {
          afterDigest: string;
          before: { column: string; digest: string } | null;
          evidenceDigest: string | null;
        }
      >
    >(),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex("review_confirmations_workspace_version_uq").on(
```

- [ ] **Step 5: Apply the migration twice, then run the tests**

Run:

```bash
corepack pnpm --filter @wukong/db db:migrate
corepack pnpm --filter @wukong/db db:migrate
corepack pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/review-confirmations.integration.test.ts
```

Expected: both migrations exit 0; the test file reports all tests passed, including the two new ones.

- [ ] **Step 6: Commit**

```bash
corepack pnpm exec prettier --write packages/db/src/schema.ts packages/db/src/repositories/review-confirmations.integration.test.ts
git add packages/db/drizzle/0027_review_confirmation_field_records.sql packages/db/src/schema.ts packages/db/src/repositories/review-confirmations.integration.test.ts
git commit -m "feat: add the ledger column that records what each field was confirmed against" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Repository write and narrow read

**Files:**

- Modify: `packages/db/src/repositories/review-confirmations.ts` (whole file)
- Modify: `packages/db/src/index.ts:66-70`
- Test: `packages/db/src/repositories/review-confirmations.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

In `packages/db/src/repositories/review-confirmations.integration.test.ts`, replace:

```ts
    sourceImportId: null,
    rowDigest: null,
  });
```

with:

```ts
    sourceImportId: null,
    rowDigest: null,
  });

  const fieldRecords = {
    nameZh: {
      afterDigest: "a".repeat(64),
      before: { column: "nameZh", digest: "b".repeat(64) },
      evidenceDigest: "c".repeat(64),
    },
    summaryEn: {
      afterDigest: "d".repeat(64),
      before: null,
      evidenceDigest: null,
    },
  };
```

Then insert these tests immediately before the final `});` that closes the `describe`:

```ts
it("stores the per-field record and reads it back without widening getByVersionId", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const { listingId, versionId } = await createDraftAndVersion(
      repositories,
      workspaceId,
    );

    const created = await repositories.reviewConfirmations.upsert({
      ...upsertInputFor(listingId, versionId),
      fieldRecords,
    });

    // Six callers read this shape and one returns it to the browser.
    expect(created).not.toHaveProperty("fieldRecords");
    expect(
      await repositories.reviewConfirmations.getByVersionId(versionId),
    ).not.toHaveProperty("fieldRecords");
    expect(
      await repositories.reviewConfirmations.getFieldRecordsByVersionId(
        versionId,
      ),
    ).toEqual(fieldRecords);
  });
});

it("clears the record when a revision is written without one", async () => {
  // The record describes the revision it was written with. Leaving the old
  // one in place would make a previous revision's record look current.
  await database.forWorkspace(workspaceId, async (repositories) => {
    const { listingId, versionId } = await createDraftAndVersion(
      repositories,
      workspaceId,
    );
    await repositories.reviewConfirmations.upsert({
      ...upsertInputFor(listingId, versionId),
      fieldRecords,
    });
    await repositories.reviewConfirmations.upsert(
      upsertInputFor(listingId, versionId),
    );

    expect(
      await repositories.reviewConfirmations.getFieldRecordsByVersionId(
        versionId,
      ),
    ).toBeNull();
  });
});

it("never exposes a field record to another workspace", async () => {
  const { versionId } = await database.forWorkspace(
    workspaceId,
    async (repositories) => {
      const { listingId, versionId } = await createDraftAndVersion(
        repositories,
        workspaceId,
      );
      await repositories.reviewConfirmations.upsert({
        ...upsertInputFor(listingId, versionId),
        fieldRecords,
      });
      return { versionId };
    },
  );

  await database.forWorkspace(otherWorkspaceId, async (repositories) => {
    expect(
      await repositories.reviewConfirmations.getFieldRecordsByVersionId(
        versionId,
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
corepack pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/review-confirmations.integration.test.ts
```

Expected: FAIL with `getFieldRecordsByVersionId is not a function`.

- [ ] **Step 3: Implement the repository changes**

Replace the whole of `packages/db/src/repositories/review-confirmations.ts` with:

```ts
import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { reviewConfirmations } from "../schema.js";

/**
 * What one confirmed field was confirmed against.
 *
 * Digests rather than copies, so no merchant content enters a second table.
 * Each is sha256 hex of a JSON encoding:
 *
 * - `afterDigest` pins the value in the confirmed version.
 * - `before` pins the merchant's cell in the imported row. `null` when the
 *   listing has no imported row or the cell was blank -- a recorded fact that
 *   nothing was supplied, not a missing value.
 * - `evidenceDigest` pins the grounding the AI offered for the field, or `null`
 *   when it offered none. Content, not ids: evidence rows are replaced wholesale
 *   and copied forward under fresh ids, so an id identifies a row rather than
 *   the grounding it carries.
 *
 * Evidence about the confirmed version and its source -- not a transcript of
 * the reviewer's screen, which does not render the merchant's prior value.
 */
export type ReviewFieldRecord = {
  afterDigest: string;
  before: { column: string; digest: string } | null;
  evidenceDigest: string | null;
};

/** Keyed by confirmation field key. See 0027_review_confirmation_field_records.sql. */
export type ReviewFieldRecords = Record<string, ReviewFieldRecord>;

export type UpsertReviewConfirmationInput = {
  listingId: string;
  versionId: string;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  sourceImportId: string | null;
  rowDigest: string | null;
  /**
   * Optional so callers that predate the record keep compiling. Omitted, it is
   * stored as NULL -- including on update, because the record describes the
   * revision it was written with.
   */
  fieldRecords?: ReviewFieldRecords | null;
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
  /**
   * The per-field record for a version's confirmation, or null when there is
   * no confirmation or it was written without one.
   *
   * Deliberately not part of `getByVersionId`: six callers read that shape,
   * `GET /api/listings/[id]` returns it to the browser, and none of them needs
   * this.
   */
  getFieldRecordsByVersionId(
    versionId: string,
  ): Promise<ReviewFieldRecords | null>;
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
      const fieldRecords = input.fieldRecords ?? null;
      const [row] = await transaction
        .insert(reviewConfirmations)
        // workspaceId last: the scoped ID must win even if a caller's object
        // carries one of its own. RLS would reject the write anyway, but the
        // tenancy boundary should not depend on the database catching it.
        .values({ ...input, fieldRecords, workspaceId, revision: 0 })
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
            fieldRecords,
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

    async getFieldRecordsByVersionId(versionId) {
      scope.assertOpen();
      const [row] = await transaction
        .select({ fieldRecords: reviewConfirmations.fieldRecords })
        .from(reviewConfirmations)
        .where(
          and(
            eq(reviewConfirmations.workspaceId, workspaceId),
            eq(reviewConfirmations.versionId, versionId),
          ),
        )
        .limit(1);
      return row?.fieldRecords ?? null;
    },
  };
}
```

- [ ] **Step 4: Export the types**

In `packages/db/src/index.ts`, replace:

```ts
export type {
  ReviewConfirmation,
  ReviewConfirmationRepository,
  UpsertReviewConfirmationInput,
} from "./repositories/review-confirmations.js";
```

with:

```ts
export type {
  ReviewConfirmation,
  ReviewConfirmationRepository,
  ReviewFieldRecord,
  ReviewFieldRecords,
  UpsertReviewConfirmationInput,
} from "./repositories/review-confirmations.js";
```

- [ ] **Step 5: Check no hand-written fake implements the repository type**

Run:

```bash
grep -rn "ReviewConfirmationRepository" apps packages --include="*.ts" --include="*.tsx"
```

Expected: matches only in `packages/db/src/index.ts`, `packages/db/src/repositories/review-confirmations.ts`, and `packages/db/src/client.ts`. If any other file declares an object typed as `ReviewConfirmationRepository`, add this method to that object:

```ts
    async getFieldRecordsByVersionId() {
      return null;
    },
```

- [ ] **Step 6: Run the tests, build and typecheck**

Run:

```bash
corepack pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/review-confirmations.integration.test.ts
corepack pnpm --filter @wukong/db... build
corepack pnpm lint
```

Expected: all integration tests in the file pass; build exits 0; lint reports `Tasks: 14 successful, 14 total`.

- [ ] **Step 7: Commit**

```bash
corepack pnpm exec prettier --write packages/db/src/repositories/review-confirmations.ts packages/db/src/index.ts packages/db/src/repositories/review-confirmations.integration.test.ts
git add packages/db/src/repositories/review-confirmations.ts packages/db/src/index.ts packages/db/src/repositories/review-confirmations.integration.test.ts
git commit -m "feat: write and read the per-field record without widening the ledger's shared shape" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The field-binding leaf module

**Files:**

- Create: `apps/web/lib/review-field-bindings.ts`
- Test: `apps/web/lib/review-field-bindings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/review-field-bindings.test.ts`:

```ts
import type { ReviewableListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { CONFIRMATION_FIELD_KEYS } from "./review-confirmation-keys";
import { REVIEW_FIELD_BINDINGS } from "./review-field-bindings";

// Every localized string is distinct, so a binding that reads the wrong path
// returns a visibly wrong value rather than an accidentally equal one.
const content: ReviewableListing = {
  sku: null,
  producer: null,
  productType: null,
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "title-en", "zh-Hant": "title-zh" },
  description: { en: "description-en", "zh-Hant": "description-zh" },
  seo: {
    title: { en: "seo-title-en", "zh-Hant": "seo-title-zh" },
    description: { en: "seo-description-en", "zh-Hant": "seo-description-zh" },
  },
  tags: ["keyword-b", "keyword-a"],
  imageAssetIds: [],
};

describe("REVIEW_FIELD_BINDINGS", () => {
  it("binds exactly the confirmation field keys, in order", () => {
    expect(Object.keys(REVIEW_FIELD_BINDINGS)).toEqual(CONFIRMATION_FIELD_KEYS);
  });

  it.each([
    ["nameZh", "title-zh", "title.zh-Hant"],
    ["summaryEn", "description-en", "description.en"],
    ["summaryZh", "description-zh", "description.zh-Hant"],
    ["seoTitleEn", "seo-title-en", "seo.title.en"],
    ["seoTitleZh", "seo-title-zh", "seo.title.zh-Hant"],
    ["seoDescriptionEn", "seo-description-en", "seo.description.en"],
    ["seoDescriptionZh", "seo-description-zh", "seo.description.zh-Hant"],
  ] as const)("reads %s from its own path", (key, value, evidenceKey) => {
    expect(REVIEW_FIELD_BINDINGS[key].read(content)).toBe(value);
    expect(REVIEW_FIELD_BINDINGS[key].evidenceKey).toBe(evidenceKey);
  });

  it("reads seoKeywords as the stored array, not the joined display string", () => {
    expect(REVIEW_FIELD_BINDINGS.seoKeywords.read(content)).toEqual([
      "keyword-b",
      "keyword-a",
    ]);
    expect(REVIEW_FIELD_BINDINGS.seoKeywords.evidenceKey).toBe("tags");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run lib/review-field-bindings.test.ts
```

Expected: FAIL with `Failed to resolve import "./review-field-bindings"`.

- [ ] **Step 3: Write the module**

Create `apps/web/lib/review-field-bindings.ts`:

```ts
import type { ReviewableListing } from "@wukong/core";

/**
 * Where one AI-writable confirmation field lives, in content and in evidence.
 */
export type ReviewFieldBinding = {
  /** The confirmed value, read from the version content as stored. */
  read(content: ReviewableListing): string | readonly string[];
  /**
   * Matches `field_evidence.fieldPath` exactly -- `evidenceFor` in
   * `listing-review-client.tsx` compares with `===`.
   */
  evidenceKey: string;
};

/**
 * Each confirmation key's content path and evidence key.
 *
 * Two maps already existed and neither fit. `listing-review-client.tsx`'s field
 * descriptors are client code, and three of their keys differ from these
 * (`titleZhHant`, `descriptionEn`, `descriptionZhHant`).
 * `canonical-listing-gaps.ts` uses these keys but omits `seoDescriptionZh` and
 * reads keywords as a joined string, which is right for gap checks and wrong
 * for a digest.
 *
 * A leaf with only a type import, so the review UI can consume the evidence
 * keys and the ledger can consume the readers without either pulling in the
 * other's dependencies. Hashing lives in `review-field-records.ts`, which is
 * server-only.
 *
 * The keys are the bulk-form column keys too: `BULK_FORM_COLUMNS` carries all
 * eight under these exact names, which is how the imported cell is found.
 */
export const REVIEW_FIELD_BINDINGS = {
  nameZh: {
    read: (content) => content.title["zh-Hant"],
    evidenceKey: "title.zh-Hant",
  },
  summaryEn: {
    read: (content) => content.description.en,
    evidenceKey: "description.en",
  },
  summaryZh: {
    read: (content) => content.description["zh-Hant"],
    evidenceKey: "description.zh-Hant",
  },
  seoTitleEn: {
    read: (content) => content.seo.title.en,
    evidenceKey: "seo.title.en",
  },
  seoTitleZh: {
    read: (content) => content.seo.title["zh-Hant"],
    evidenceKey: "seo.title.zh-Hant",
  },
  seoDescriptionEn: {
    read: (content) => content.seo.description.en,
    evidenceKey: "seo.description.en",
  },
  seoDescriptionZh: {
    read: (content) => content.seo.description["zh-Hant"],
    evidenceKey: "seo.description.zh-Hant",
  },
  seoKeywords: {
    // The array, not `tags.join(", ")`: joining is not injective, so one
    // keyword containing a comma and two keywords would digest identically.
    read: (content) => content.tags,
    evidenceKey: "tags",
  },
} satisfies Record<string, ReviewFieldBinding>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run lib/review-field-bindings.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
corepack pnpm exec prettier --write apps/web/lib/review-field-bindings.ts apps/web/lib/review-field-bindings.test.ts
git add apps/web/lib/review-field-bindings.ts apps/web/lib/review-field-bindings.test.ts
git commit -m "feat: bind each confirmation field to its content path and evidence key" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The server-only record builder

**Files:**

- Create: `apps/web/lib/review-field-records.ts`
- Test: `apps/web/lib/review-field-records.test.ts`

Requires Task 2's types and `corepack pnpm --filter @wukong/db... build` to have run.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/review-field-records.test.ts`:

```ts
import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { CONFIRMATION_FIELD_KEYS } from "./review-confirmation-keys";
import { buildReviewFieldRecords } from "./review-field-records";

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const content: ReviewableListing = {
  sku: null,
  producer: null,
  productType: null,
  country: null,
  region: null,
  vintage: null,
  grapeVarieties: [],
  volumeMl: null,
  abvPercent: null,
  packQuantity: 1,
  priceHkd: null,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "title-en", "zh-Hant": "title-zh" },
  description: { en: "description-en", "zh-Hant": "description-zh" },
  seo: {
    title: { en: "seo-title-en", "zh-Hant": "seo-title-zh" },
    description: { en: "seo-description-en", "zh-Hant": "seo-description-zh" },
  },
  tags: ["keyword-b", "keyword-a"],
  imageAssetIds: [],
};

const evidence = (field: string, excerpt: string): FieldEvidence => ({
  field,
  sourceAssetId: "note",
  page: null,
  excerpt,
  confidence: 0.9,
});

describe("buildReviewFieldRecords", () => {
  it("records every confirmation field, and nothing else", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(Object.keys(records)).toEqual(CONFIRMATION_FIELD_KEYS);
  });

  it("pins the confirmed value as a digest of the value as stored", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(records.nameZh?.afterDigest).toBe(sha("title-zh"));
    expect(records.seoKeywords?.afterDigest).toBe(
      sha(["keyword-b", "keyword-a"]),
    );
  });

  it("does not confuse one keyword containing a comma with two keywords", () => {
    // Both display as "keyword-b, keyword-a". Only the stored array tells them
    // apart, which is why the display string is never digested.
    const single = buildReviewFieldRecords({
      content: { ...content, tags: ["keyword-b, keyword-a"] },
      evidence: [],
      rawRow: null,
    });
    const pair = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(single.seoKeywords?.afterDigest).not.toBe(
      pair.seoKeywords?.afterDigest,
    );
  });

  it("records the merchant's cell as before, and null where the cell is blank", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: {
        productId: "remote-1",
        nameZh: "merchant-name",
        summaryEn: "",
        summaryZh: "   ",
        seoTitleEn: null,
      },
    });
    expect(records.nameZh?.before).toEqual({
      column: "nameZh",
      digest: sha("merchant-name"),
    });
    expect(records.summaryEn?.before).toBeNull();
    expect(records.summaryZh?.before).toBeNull();
    expect(records.seoTitleEn?.before).toBeNull();
    expect(records.seoKeywords?.before).toBeNull();
  });

  it("lets a reader see that the confirmed value is the merchant's own, unchanged", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: { nameZh: "title-zh", summaryEn: "merchant-summary" },
    });
    expect(records.nameZh?.before?.digest).toBe(records.nameZh?.afterDigest);
    expect(records.summaryEn?.before?.digest).not.toBe(
      records.summaryEn?.afterDigest,
    );
  });

  it("records no before at all for a listing that was never imported", () => {
    const records = buildReviewFieldRecords({
      content,
      evidence: [],
      rawRow: null,
    });
    expect(
      Object.values(records).every((record) => record.before === null),
    ).toBe(true);
  });

  it("pins the grounding offered for a field, and null where there was none", () => {
    const records = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [
        evidence("title.zh-Hant", "excerpt-name"),
        evidence("tags", "excerpt-tags"),
      ],
    });
    expect(records.nameZh?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(records.seoKeywords?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(records.summaryEn?.evidenceDigest).toBeNull();
  });

  it("gives the same grounding the same digest whatever order the rows arrive in", () => {
    // getReviewSnapshot reads evidence with no ORDER BY.
    const first = evidence("title.zh-Hant", "excerpt-one");
    const second = evidence("title.zh-Hant", "excerpt-two");
    const forward = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [first, second],
    });
    const backward = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [second, first],
    });
    expect(forward.nameZh?.evidenceDigest).toBe(
      backward.nameZh?.evidenceDigest,
    );
  });

  it("changes the evidence digest when the grounding changes", () => {
    const original = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [evidence("title.zh-Hant", "excerpt-one")],
    });
    const changed = buildReviewFieldRecords({
      content,
      rawRow: null,
      evidence: [evidence("title.zh-Hant", "excerpt-changed")],
    });
    expect(changed.nameZh?.evidenceDigest).not.toBe(
      original.nameZh?.evidenceDigest,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run lib/review-field-records.test.ts
```

Expected: FAIL with `Failed to resolve import "./review-field-records"`.

- [ ] **Step 3: Write the module**

Create `apps/web/lib/review-field-records.ts`:

```ts
import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import type { ReviewFieldRecords } from "@wukong/db";

import { REVIEW_FIELD_BINDINGS } from "./review-field-bindings";

/**
 * sha256 hex of a JSON encoding. One encoding for before and after, so equal
 * digests mean equal values.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export type ReviewFieldRecordsInput = {
  content: ReviewableListing;
  evidence: readonly FieldEvidence[];
  /**
   * The imported row, keyed by bulk-form column key. `null` for a listing that
   * was never imported.
   */
  rawRow: Readonly<Record<string, string | null>> | null;
};

/**
 * What each confirmation field is being confirmed against, as digests.
 *
 * Server-only: it hashes with `node:crypto`. Every input comes from rows the
 * caller does not control -- the confirmed version, its evidence and the
 * imported row -- so nothing here can be supplied by a request.
 */
export function buildReviewFieldRecords(
  input: ReviewFieldRecordsInput,
): ReviewFieldRecords {
  const records: ReviewFieldRecords = {};
  for (const [key, binding] of Object.entries(REVIEW_FIELD_BINDINGS)) {
    const cell = input.rawRow?.[key] ?? null;
    // Each entry encoded on its own and sorted: the snapshot reads evidence
    // with no ORDER BY, and the same grounding in a different order must not
    // look changed.
    const grounding = input.evidence
      .filter((entry) => entry.field === binding.evidenceKey)
      .map(({ sourceAssetId, page, excerpt, confidence }) =>
        JSON.stringify({ sourceAssetId, page, excerpt, confidence }),
      )
      .sort();
    records[key] = {
      afterDigest: digest(binding.read(input.content)),
      before:
        cell === null || cell.trim() === ""
          ? null
          : { column: key, digest: digest(cell) },
      evidenceDigest: grounding.length === 0 ? null : digest(grounding),
    };
  }
  return records;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run lib/review-field-records.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
corepack pnpm exec prettier --write apps/web/lib/review-field-records.ts apps/web/lib/review-field-records.test.ts
git add apps/web/lib/review-field-records.ts apps/web/lib/review-field-records.test.ts
git commit -m "feat: hash each confirmed field against its version, imported cell and evidence" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The review UI consumes the shared evidence keys

**Files:**

- Modify: `apps/web/components/listing-review-client.tsx` (imports, and eight `field(...)` descriptors in `mapListingView`)
- Test: `apps/web/components/listing-review-client.test.ts` (unchanged; must still pass)

A no-behaviour-change refactor that makes the UI and the ledger read one definition, so they cannot drift.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run components/listing-review-client.test.ts
```

Expected: PASS.

- [ ] **Step 2: Import the bindings**

In `apps/web/components/listing-review-client.tsx`, replace:

```ts
import { localized, commonCopy, stateLabel, safeUiError } from "../lib/ui-copy";
```

with:

```ts
import { REVIEW_FIELD_BINDINGS } from "../lib/review-field-bindings";
import { localized, commonCopy, stateLabel, safeUiError } from "../lib/ui-copy";
```

- [ ] **Step 3: Replace the eight evidence-key literals**

Make each replacement in `apps/web/components/listing-review-client.tsx`. Each old string occurs exactly once.

| Replace                                   | With                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `evidenceKey: "title.zh-Hant",`           | `evidenceKey: REVIEW_FIELD_BINDINGS.nameZh.evidenceKey,`           |
| `evidenceKey: "description.zh-Hant",`     | `evidenceKey: REVIEW_FIELD_BINDINGS.summaryZh.evidenceKey,`        |
| `evidenceKey: "description.en",`          | `evidenceKey: REVIEW_FIELD_BINDINGS.summaryEn.evidenceKey,`        |
| `evidenceKey: "seo.title.en",`            | `evidenceKey: REVIEW_FIELD_BINDINGS.seoTitleEn.evidenceKey,`       |
| `evidenceKey: "seo.title.zh-Hant",`       | `evidenceKey: REVIEW_FIELD_BINDINGS.seoTitleZh.evidenceKey,`       |
| `evidenceKey: "seo.description.en",`      | `evidenceKey: REVIEW_FIELD_BINDINGS.seoDescriptionEn.evidenceKey,` |
| `evidenceKey: "seo.description.zh-Hant",` | `evidenceKey: REVIEW_FIELD_BINDINGS.seoDescriptionZh.evidenceKey,` |
| `evidenceKey: "tags",`                    | `evidenceKey: REVIEW_FIELD_BINDINGS.seoKeywords.evidenceKey,`      |

Leave `evidenceKey: "title.en",` (the `titleEn` descriptor) as it is: `nameEn` is not a confirmation field.

- [ ] **Step 4: Verify exactly one literal remains**

Run:

```bash
grep -n 'evidenceKey: "' apps/web/components/listing-review-client.tsx
```

Expected: exactly one line, containing `evidenceKey: "title.en",`.

- [ ] **Step 5: Run the test and typecheck**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run components/listing-review-client.test.ts
corepack pnpm lint
```

Expected: test PASS, unchanged from Step 1; lint `Tasks: 14 successful, 14 total`.

- [ ] **Step 6: Commit**

```bash
corepack pnpm exec prettier --write apps/web/components/listing-review-client.tsx
git add apps/web/components/listing-review-client.tsx
git commit -m "refactor: read the review UI's evidence keys from the ledger's bindings" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The confirmation route writes the records

**Files:**

- Modify: `apps/web/app/api/listings/[id]/review-confirmations/route.ts` (whole file)
- Modify: `apps/web/app/api/listings/[id]/review-confirmations/route.test.ts` (whole file)

- [ ] **Step 1: Replace the route test with the new expectations**

Replace the whole of `apps/web/app/api/listings/[id]/review-confirmations/route.test.ts` with:

```ts
import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { createReviewConfirmationsHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "operator_1",
  role: "operator" as const,
};

const content: ReviewableListing = {
  sku: "OPAK-001",
  producer: "Opak",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "Opak Riesling", "zh-Hant": "opak-riesling-zh" },
  description: { en: "Dry wine", "zh-Hant": "dry-wine-zh" },
  seo: {
    title: { en: "Opak Riesling", "zh-Hant": "opak-riesling-zh" },
    description: { en: "Dry wine", "zh-Hant": "dry-wine-zh" },
  },
  tags: ["wine"],
  imageAssetIds: [],
};

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function request(body: Record<string, unknown>) {
  return new Request(
    `http://localhost/api/listings/${listingId}/review-confirmations`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function routeContext(id: string = listingId) {
  return { params: Promise.resolve({ id }) };
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin";
    activeVersionId?: string | null;
    snapshotExists?: boolean;
    invalidation?: "unchanged" | "reopened" | "publishing" | "stale";
    evidence?: FieldEvidence[];
    platformProduct?: {
      sourceImportId: string | null;
      contentDigest: string | null;
      rawRow?: Record<string, string | null> | null;
    } | null;
  } = {},
) {
  const calls: unknown[] = [];
  const platformProduct =
    options.platformProduct === undefined ? null : options.platformProduct;
  const snapshotExists = options.snapshotExists ?? true;
  const handler = createReviewConfirmationsHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "operator" };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          calls.push(["forWorkspace", workspaceId]);
          return work({
            listings: {
              async invalidateApprovalForConfirmationChange(
                id: string,
                observedVersionId: string,
              ) {
                calls.push([
                  "invalidateApprovalForConfirmationChange",
                  id,
                  observedVersionId,
                ]);
                return options.invalidation ?? "unchanged";
              },
              async getReviewSnapshot(id: string) {
                calls.push(["getReviewSnapshot", id]);
                if (!snapshotExists) return null;
                return {
                  listing: { id },
                  activeVersion:
                    options.activeVersionId === null
                      ? null
                      : { id: options.activeVersionId ?? versionId, content },
                  evidence: options.evidence ?? [],
                };
              },
            },
            platformProducts: {
              async getByListingId(id: string) {
                calls.push(["getByListingId", id]);
                return platformProduct;
              },
            },
            reviewConfirmations: {
              async upsert(input: any) {
                calls.push(["upsert", input]);
                return {
                  id: "confirmation_1",
                  listingId,
                  versionId: input.versionId,
                  fieldConfirmations: input.fieldConfirmations,
                  negativeConfirmations: input.negativeConfirmations,
                  revision: 1,
                  sourceImportId: input.sourceImportId,
                  rowDigest: input.rowDigest,
                };
              },
            },
            audit: {
              async write(event: unknown) {
                calls.push(["audit", event]);
              },
            },
          });
        },
      }) as never,
  });
  return { handler, calls };
}

function upsertInput(calls: unknown[]) {
  const call = calls.find(
    (entry): entry is ["upsert", { fieldRecords: Record<string, any> }] =>
      Array.isArray(entry) && entry[0] === "upsert",
  );
  return call?.[1];
}

describe("PATCH /api/listings/[id]/review-confirmations", () => {
  it("rejects a viewer before opening a workspace transaction", async () => {
    const { handler, calls } = makeHandler({ role: "viewer" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: { no_medical_claims: true },
      }),
      routeContext(),
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a non-boolean confirmation value", async () => {
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: "yes" },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  it("refuses a request that tries to supply its own field records", async () => {
    // The records are derived server-side. A strict, unchanged request schema
    // is what makes that true rather than merely intended.
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { nameZh: true },
        negativeConfirmations: {},
        fieldRecords: {
          nameZh: {
            afterDigest: "a".repeat(64),
            before: null,
            evidenceDigest: null,
          },
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  it("upserts a confirmation and returns the new revision", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: {
        sourceImportId: "import_1",
        contentDigest: "digest_1",
      },
    });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true, description: false },
        negativeConfirmations: { no_medical_claims: true },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 1,
      fieldConfirmations: { title: true, description: false },
      negativeConfirmations: { no_medical_claims: true },
    });
    expect(calls).toContainEqual([
      "upsert",
      {
        listingId,
        versionId,
        fieldConfirmations: { title: true, description: false },
        negativeConfirmations: { no_medical_claims: true },
        sourceImportId: "import_1",
        rowDigest: "digest_1",
        fieldRecords: expect.objectContaining({
          nameZh: expect.anything(),
          seoKeywords: expect.anything(),
        }),
      },
    ]);
    // No imported row and no evidence: every field says so.
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        workspaceId: "ws_opak",
        actorId: "operator_1",
        entityId: listingId,
        action: "review_confirmation.updated",
        metadata: {
          versionId,
          revision: 1,
          fieldsWithSource: 0,
          fieldsWithoutEvidence: 8,
        },
      }),
    ]);
  });

  it("records each field against the imported row and the evidence", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: {
        sourceImportId: "import_1",
        contentDigest: "digest_1",
        rawRow: { nameZh: "opak-riesling-zh", summaryEn: "" },
      },
      evidence: [
        {
          field: "title.zh-Hant",
          sourceAssetId: "note",
          page: null,
          excerpt: "Opak",
          confidence: 0.9,
        },
      ],
    });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { nameZh: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const records = upsertInput(calls)?.fieldRecords;
    expect(records?.nameZh).toEqual({
      afterDigest: sha("opak-riesling-zh"),
      before: { column: "nameZh", digest: sha("opak-riesling-zh") },
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(records?.summaryEn).toEqual({
      afterDigest: sha("Dry wine"),
      before: null,
      evidenceDigest: null,
    });
    // The response shape is unchanged: the record is evidence, not UI state.
    expect(await response.json()).not.toHaveProperty("fieldRecords");
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        metadata: {
          versionId,
          revision: 1,
          fieldsWithSource: 1,
          fieldsWithoutEvidence: 7,
        },
      }),
    ]);
  });

  it("reopens current approval before updating its confirmation ledger", async () => {
    const { handler, calls } = makeHandler({ invalidation: "reopened" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: false },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual([
      "invalidateApprovalForConfirmationChange",
      listingId,
      versionId,
    ]);
  });

  it("maps a version that becomes stale after the snapshot to 409", async () => {
    const { handler, calls } = makeHandler({ invalidation: "stale" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: false },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_version" });
    expect(
      calls.some((call) => Array.isArray(call) && call[0] === "upsert"),
    ).toBe(false);
  });

  it("fails closed without updating confirmations while publishing", async () => {
    const { handler, calls } = makeHandler({ invalidation: "publishing" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: false },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "listing_publishing" });
    expect(
      calls.some((call) => Array.isArray(call) && call[0] === "upsert"),
    ).toBe(false);
  });

  it("populates null sourceImportId/rowDigest for a create-origin listing with no platform product link", async () => {
    const { handler, calls } = makeHandler({ platformProduct: null });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(calls).toContainEqual([
      "upsert",
      expect.objectContaining({
        sourceImportId: null,
        rowDigest: null,
      }),
    ]);
    const records = upsertInput(calls)?.fieldRecords ?? {};
    expect(
      Object.values(records).every((record) => record.before === null),
    ).toBe(true);
  });

  it("rejects a versionId that isn't the listing's current active version", async () => {
    const superseded = "00000000-0000-4000-8000-000000000299";
    const { handler, calls } = makeHandler({
      activeVersionId: "00000000-0000-4000-8000-000000000301",
    });
    const response = await handler(
      request({
        versionId: superseded,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_version" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["upsert", expect.anything()]),
    );
  });

  it("rejects a versionId that belongs to a completely different listing", async () => {
    const otherListingsVersionId = "11111111-1111-4111-8111-111111111111";
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId: otherListingsVersionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_version" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["upsert", expect.anything()]),
    );
  });

  it("returns 404 (not 500) for a listing that no longer exists", async () => {
    const { handler, calls } = makeHandler({ snapshotExists: false });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "listing_not_found" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["upsert", expect.anything()]),
    );
  });

  it("returns 404 (not 500) for a malformed listing id, without touching the database", async () => {
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext("not-a-listing-id"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "listing_not_found" });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify the new cases fail**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run "app/api/listings/[id]/review-confirmations/route.test.ts"
```

Expected: FAIL in "upserts a confirmation and returns the new revision", "records each field against the imported row and the evidence" and the create-origin case, because the route does not yet pass `fieldRecords` or the audit counts. "refuses a request that tries to supply its own field records" already PASSES — the schema is strict today, and this test locks that in.

- [ ] **Step 3: Implement the route change**

Replace the whole of `apps/web/app/api/listings/[id]/review-confirmations/route.ts` with:

```ts
import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import { buildReviewFieldRecords } from "../../../../../lib/review-field-records";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ReviewConfirmationsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
};

// Strict, and deliberately without a fieldRecords key: the per-field record is
// derived from rows the caller does not control, so a request carrying one is
// refused rather than trusted.
const bodySchema = z
  .object({
    versionId: z.string().uuid(),
    fieldConfirmations: z.record(z.string(), z.boolean()),
    negativeConfirmations: z.record(z.string(), z.boolean()),
  })
  .strict();

function assertOperator(role: string): void {
  if (!["operator", "reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Operator access is required.",
    );
  }
}

export function createReviewConfirmationsHandler(
  deps: ReviewConfirmationsRouteDeps,
) {
  return async function reviewConfirmationsHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertOperator(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      }
      const body = bodySchema.parse(await request.json());

      const confirmation = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const snapshot = await repositories.listings.getReviewSnapshot(id);
          if (!snapshot) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }
          if (
            !snapshot.activeVersion ||
            snapshot.activeVersion.id !== body.versionId
          ) {
            throw new ApiError(
              409,
              "stale_version",
              "Listing changed; reload before confirming review fields.",
            );
          }

          const invalidation =
            await repositories.listings.invalidateApprovalForConfirmationChange(
              id,
              body.versionId,
              {
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: id,
              },
              repositories.audit,
            );
          if (invalidation === "stale") {
            throw new ApiError(
              409,
              "stale_version",
              "Listing changed; reload before confirming review fields.",
            );
          }
          if (invalidation === "publishing") {
            throw new ApiError(
              409,
              "listing_publishing",
              "Confirmations cannot change while delivery is in progress.",
            );
          }
          // create-origin listings have no platform_products link, so the
          // digest and import id the ledger records for them are both null,
          // and so is every field record's `before`.
          const platformProduct =
            await repositories.platformProducts.getByListingId(id);

          // What each field is being confirmed against: the confirmed version,
          // its evidence and the imported row -- the same row whose digest is
          // recorded as rowDigest below, so the two bindings cannot disagree.
          const fieldRecords = buildReviewFieldRecords({
            content: snapshot.activeVersion.content,
            evidence: snapshot.evidence,
            rawRow: platformProduct?.rawRow ?? null,
          });

          const result = await repositories.reviewConfirmations.upsert({
            listingId: id,
            versionId: body.versionId,
            fieldConfirmations: body.fieldConfirmations,
            negativeConfirmations: body.negativeConfirmations,
            sourceImportId: platformProduct?.sourceImportId ?? null,
            rowDigest: platformProduct?.contentDigest ?? null,
            fieldRecords,
          });

          const records = Object.values(fieldRecords);
          // Metadata is identifiers and counts only, matching this codebase's
          // audit convention -- never the confirmed content, and not the
          // digests either: those are in the column.
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "review_confirmation.updated",
            metadata: {
              versionId: body.versionId,
              revision: result.revision,
              fieldsWithSource: records.filter(
                (record) => record.before !== null,
              ).length,
              fieldsWithoutEvidence: records.filter(
                (record) => record.evidenceDigest === null,
              ).length,
            },
          });

          return result;
        });

      return jsonResponse(200, {
        revision: confirmation.revision,
        fieldConfirmations: confirmation.fieldConfirmations,
        negativeConfirmations: confirmation.negativeConfirmations,
      });
    });
  };
}

export const PATCH = createReviewConfirmationsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
corepack pnpm --filter @wukong/web exec vitest run "app/api/listings/[id]/review-confirmations/route.test.ts"
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Typecheck**

Run:

```bash
corepack pnpm lint
```

Expected: `Tasks: 14 successful, 14 total`.

- [ ] **Step 6: Commit**

```bash
corepack pnpm exec prettier --write "apps/web/app/api/listings/[id]/review-confirmations/route.ts" "apps/web/app/api/listings/[id]/review-confirmations/route.test.ts"
git add "apps/web/app/api/listings/[id]/review-confirmations/route.ts" "apps/web/app/api/listings/[id]/review-confirmations/route.test.ts"
git commit -m "feat: record what each confirmation tick was made against" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Deployment record and workstream status

**Files:**

- Modify: `docs/implementation/wukong-remediation-verification.md:216-235`
- Modify: `docs/superpowers/plans/2026-09-11-release-gate-closure.md` (the W6 section)

- [ ] **Step 1: Record the two deployment constraints**

In `docs/implementation/wukong-remediation-verification.md`, replace:

```markdown
## Deployment order, now four constraints
```

with:

```markdown
## Deployment order, now six constraints
```

Then replace:

```markdown
the attestation box, which is the worst possible moment to discover it. The
column is additive and nullable, so the migration is safe to run ahead.
```

with:

```markdown
the attestation box, which is the worst possible moment to discover it. The
column is additive and nullable, so the migration is safe to run ahead. 5. **Migration `0026` before the web deploy.** Since W1 the export route writes
`rowDigestMismatchCount` instead of `freshnessAttested` into provenance, and
the `guard_import_result_insert` trigger from `0017` refuses any import
result recorded against such an attempt with
`export_provenance_incomplete`. `0026` replaces the trigger. It runs in the
same `migrate()` invocation as `0025`, so the runner cannot split them; it is
listed because it was missing, not because it adds a separate hazard. 6. **Migration `0027` before the web deploy.** The review-confirmations route
writes `review_confirmations.field_records`. A web deploy that lands first
fails every confirmation tick at the upsert. The column is additive and
nullable, so the migration is safe to run ahead.
```

- [ ] **Step 2: Record W6 as done**

In `docs/superpowers/plans/2026-09-11-release-gate-closure.md`, run:

```bash
grep -n "It must land before Stage 2." docs/superpowers/plans/2026-09-11-release-gate-closure.md
```

Expected: exactly one line, inside the W6 section. Immediately after the paragraph ending on that line, insert:

```markdown
**Done (2026-09-13).** Designed in
[confirmation-ledger field records](../specs/2026-09-13-confirmation-ledger-field-records-design.md)
and implemented as one nullable column, `review_confirmations.field_records`
(`0027`), plus a binding module the review UI now shares with the ledger.

The premise needed the same correction W1's did. All three ingredients already
existed -- `listing_versions`, the imported row, `field_evidence` -- and what was
missing was the ledger binding a field-granular tick to them. Each field now
records a digest of the confirmed value, of the merchant's own cell or `null`,
and of the grounding the AI offered or `null`, derived server-side so a request
cannot supply it.

Approval is unchanged: this is evidence for a stage review, not a new gate.
```

- [ ] **Step 3: Commit**

```bash
corepack pnpm exec prettier --write docs/implementation/wukong-remediation-verification.md docs/superpowers/plans/2026-09-11-release-gate-closure.md
git add docs/implementation/wukong-remediation-verification.md docs/superpowers/plans/2026-09-11-release-gate-closure.md
git commit -m "docs: record the 0026 and 0027 deployment constraints and close W6" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification and push

**Files:** none changed unless a check fails.

- [ ] **Step 1: Typecheck, unit tests and build**

Run:

```bash
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

Expected: lint `Tasks: 14 successful, 14 total`; test `Tasks: 14 successful, 14 total`; build exits 0.

- [ ] **Step 2: Confirm the approval path did not move**

Run:

```bash
git diff --stat 91dcbde..HEAD -- apps/web/lib/listing-approval.ts "apps/web/app/api/listings/[id]/approve" apps/web/lib/review-confirmation-keys.ts "apps/web/app/api/listings/[id]/route.ts" apps/web/lib/canonical-listing-gaps.ts
```

Expected: no output. These are the approval path, the confirmation keys, the GET route that returns the ledger to the browser, and the gap checks the spec leaves alone. Any file listed means the change leaked past its scope — stop and investigate before continuing.

- [ ] **Step 3: Integration suite against real Postgres**

Run:

```bash
corepack pnpm --filter @wukong/db db:migrate
corepack pnpm test:integration
```

Expected: migrate exits 0; the summary reports no failed tests.

- [ ] **Step 4: Format and release gates, after committing**

Run:

```bash
RELEASE_BASE_SHA=9f72a37ebeb6549f1041bae673bcee841bf72402 corepack pnpm format:runtime:check
node scripts/check-release-gate.mjs
```

Expected: the format check exits 0 and prints no `Runtime files requiring Prettier` list; the release gate prints `automated half: all checks pass. This is not sign-off.`

If the format check lists files, run `corepack pnpm exec prettier --write` on each listed file, commit with `git commit -m "style: format the confirmation ledger records" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"`, and re-run this step.

- [ ] **Step 5: Push and confirm CI**

Run:

```bash
git push origin codex/listing-grounding-diagnosis
gh pr checks 83 --repo YNWAforever/wukong-ecommerce-os
```

Expected: `verify` eventually reports `pass`. The Playwright pilot journey ticks confirmations through the real route, so it exercises `buildReviewFieldRecords` against real content and evidence; a failure there is the signal that matters most.
