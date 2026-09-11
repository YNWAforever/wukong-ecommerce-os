# Freshness Attestation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the export gate's always-true `freshnessAttested` boolean with the digests the operator actually saw, so the server can refuse an export whose source moved since they looked, and can record what they attested.

**Architecture:** The operator's attested digest becomes `expectedRowDigest`, which is what that field was always documented to mean. That turns the existing `row_digest_mismatch` — today a comparison of a value against a re-read of itself — into a real check, and adds no new freshness reason. Set equality between attested and requested listings is a 400 request error at the route, like the existing duplicate-ids refusal. The evidence is stored in a new nullable `source_attestation` column on `export_attempts`, written on refused attempts as well as successful ones.

**Tech Stack:** pnpm + Turborepo, TypeScript strict, Next.js 16 App Router, Vitest, zod v4, Drizzle + raw SQL migrations, Postgres.

**Design spec:** [`docs/superpowers/specs/2026-09-12-freshness-attestation-design.md`](../specs/2026-09-12-freshness-attestation-design.md)

---

## Before you start

Run every command from the worktree root:
`C:\Users\laich\Documents\WukongEommerce\.claude\worktrees\wukong-ecommerce-implementation-ff6145`

`pnpm` is not on PATH on this machine. Either use `corepack pnpm …` or put a shim on PATH. Integration tests need Postgres: `docker compose up -d postgres` (never `down`; the compose project is shared with other worktrees).

Two project rules that bite here:

- `migrate()` re-runs every SQL file on every invocation and keeps no applied-migrations table, so **every migration must be idempotent**.
- A Postgres `CHECK` is invisible to fake-repository unit tests. Task 5 rehearses the migration against a real Postgres before any code depends on it.

## File structure

| File                                                      | Responsibility                                                            | Task |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ---- |
| `packages/core/src/assert-export-freshness.ts`            | Owns `not_attested` and feeds the attested digest into the content checks | 1    |
| `apps/web/lib/bulk-update-eligibility.ts`                 | Passes the operator's digest through instead of the server's own read     | 2    |
| `apps/web/lib/bulk-export-service.ts`                     | Carries per-listing attested digests into the per-listing gate            | 3    |
| `apps/web/lib/bulk-approve-limit.ts`                      | Holds `MAX_BULK_EXPORT_ITEMS` beside the approve bound                    | 4    |
| `apps/web/app/api/listings/export/route.ts`               | Request shape, set equality, persistence, audit counts                    | 4, 6 |
| `packages/db/drizzle/0025_export_attempt_attestation.sql` | Adds the nullable evidence column                                         | 5    |
| `packages/db/src/schema.ts`                               | Declares the column to Drizzle                                            | 5    |
| `packages/db/src/repositories/export-attempts.ts`         | Accepts and writes the evidence                                           | 5    |
| `apps/web/components/bulk-export-panel.tsx`               | Sends what it displayed; drops the tick when a digest moves               | 7    |
| `apps/web/components/catalog-control-center.tsx`          | Supplies digests alongside ids                                            | 7    |
| `apps/web/app/api/listings/[id]/deliver/route.ts`         | Requires an explicit attestation on `bulk_form`                           | 8    |

---

### Task 1: Core — the attested digest is the expected digest

**Files:**

- Modify: `packages/core/src/assert-export-freshness.ts:16-32` (input type), `:50-62` (function body)
- Test: `packages/core/src/assert-export-freshness.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/assert-export-freshness.test.ts`, change `BASE_INPUT` (currently `:9-16`) to drop `expectedRowDigest`/`freshnessAttested` and carry the attested digest:

```ts
const BASE_INPUT: AssertExportFreshnessInput = {
  workspaceId: "ws_opak",
  listingId: "listing_1",
  expectedSourceImportId: "source_import_1",
  expectedVersionId: "version_1",
  attestedRowDigest: "digest_1",
};
```

Replace the existing `"rejects when freshness was not attested…"` case with this pair:

```ts
it("rejects when no attestation was supplied, before checking anything else", async () => {
  const result = await assertExportFreshness(
    { ...BASE_INPUT, attestedRowDigest: null },
    depsWith({
      async getPlatformProductLink() {
        throw new Error("must not be called");
      },
    }),
  );
  expect(result).toEqual({ ok: false, reason: "not_attested" });
});

it("rejects when the source moved since the operator looked", async () => {
  // The operator attested the digest they were shown; the link now carries a
  // different one. Before this change `expectedRowDigest` came from the
  // caller's own read of the same link, so this compared a value with a
  // re-read of itself and could only fail on a microsecond race.
  const result = await assertExportFreshness(
    { ...BASE_INPUT, attestedRowDigest: "digest_the_operator_saw" },
    depsWith(),
  );
  expect(result).toEqual({ ok: false, reason: "row_digest_mismatch" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node_modules/.bin/vitest run --root packages/core src/assert-export-freshness.test.ts`
Expected: FAIL — TypeScript rejects `attestedRowDigest`, which is not on `AssertExportFreshnessInput`.

- [ ] **Step 3: Change the input type**

In `packages/core/src/assert-export-freshness.ts`, replace the whole `AssertExportFreshnessInput` declaration (`:16-32`) with:

```ts
export type AssertExportFreshnessInput = Omit<
  ContentFreshnessInput,
  "expectedRowDigest"
> & {
  /**
   * Not read by this function — every `deps` lookup is keyed by
   * `listingId`/`sourceImportId` alone. Carried on the input for interface
   * fidelity with the caller that wires real deps: tenancy scoping happens by
   * how that caller closes over a workspace-bound transaction, not by this
   * pure function checking the id itself.
   */
  workspaceId: string;
  /**
   * The row digest the operator was shown and attested to, or `null` when no
   * attestation was supplied.
   *
   * This IS the expectation the content check compares against, which is what
   * `expectedRowDigest` was always documented to mean: "named from the
   * caller's point of expectation rather than the port's point of storage".
   * Feeding it from the caller's own read of the link — as this path used to —
   * made that check compare a value against a re-read of itself.
   *
   * Never a time-since-import comparison: the master instruction bars a
   * hard-coded freshness threshold until Opak approves a policy.
   */
  attestedRowDigest: string | null;
};
```

- [ ] **Step 4: Change the function body**

In the same file, replace the attestation guard and the content call (`:55-62`) with:

```ts
if (input.attestedRowDigest === null) {
  return { ok: false, reason: "not_attested" };
}

const contentFreshness = await assertContentFreshness(
  { ...input, expectedRowDigest: input.attestedRowDigest },
  deps,
);
if (!contentFreshness.ok) {
  return contentFreshness;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run --root packages/core src/assert-export-freshness.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Typecheck the package**

Run: `node_modules/.bin/tsc --noEmit -p packages/core`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/assert-export-freshness.ts packages/core/src/assert-export-freshness.test.ts
git commit -m "feat: make the attested digest the expectation the export gate checks"
```

---

### Task 2: Eligibility passes the operator's digest, not its own read

**Files:**

- Modify: `apps/web/lib/bulk-update-eligibility.ts:113-121` (input type), `:229-236` (the call)
- Test: `apps/web/lib/bulk-update-eligibility.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/bulk-update-eligibility.test.ts`:

```ts
describe("attested digest", () => {
  it("refuses when the attested digest is not what the link now carries", async () => {
    // The point of the change: the caller no longer supplies the server's own
    // reading of the link as the expectation.
    const result = await checkBulkUpdateEligibility(
      {
        workspaceId: "ws_opak",
        listingId: "listing_1",
        versionId: "version_1",
        attestedRowDigest: "a-digest-the-link-no-longer-has",
      },
      eligibleDeps(),
    );

    expect(result).toEqual({ ok: false, reason: "row_digest_mismatch" });
  });

  it("refuses when no attestation was supplied at all", async () => {
    const result = await checkBulkUpdateEligibility(
      {
        workspaceId: "ws_opak",
        listingId: "listing_1",
        versionId: "version_1",
        attestedRowDigest: null,
      },
      eligibleDeps(),
    );

    expect(result).toEqual({ ok: false, reason: "not_attested" });
  });
});
```

`eligibleDeps()` stands for this file's existing helper that builds deps for a fully-eligible listing. Use whichever helper the file's passing cases already use — do not invent a new one.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vitest run --root apps/web lib/bulk-update-eligibility.test.ts`
Expected: FAIL — `attestedRowDigest` is not a known property.

- [ ] **Step 3: Change the input type**

In `apps/web/lib/bulk-update-eligibility.ts`, in the `checkBulkUpdateEligibility` signature (`:113-121`), replace `freshnessAttested: boolean;` with:

```ts
/** The digest the operator attested, or null when none was supplied. */
attestedRowDigest: string | null;
```

- [ ] **Step 4: Pass it through instead of the server's own read**

In the same file, in the `assertExportFreshness` call (`:229-236`), replace these two lines:

```ts
      expectedRowDigest: link.contentDigest,
      freshnessAttested: input.freshnessAttested,
```

with:

```ts
      attestedRowDigest: input.attestedRowDigest,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run --root apps/web lib/bulk-update-eligibility.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-update-eligibility.ts apps/web/lib/bulk-update-eligibility.test.ts
git commit -m "feat: check the operator's digest rather than the server's own read"
```

---

### Task 3: The export service carries per-listing attestations

**Files:**

- Modify: `apps/web/lib/bulk-export-service.ts:55` (input type), `:154` (the per-listing call)
- Test: `apps/web/lib/bulk-export-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/bulk-export-service.test.ts`:

```ts
describe("per-listing attestation", () => {
  it("excludes a listing whose attested digest no longer matches", async () => {
    const result = await createBulkExport(
      {
        workspaceId: "ws_opak",
        requestedBy: "actor_1",
        listingIds: ["listing_1"],
        attestedDigests: new Map([["listing_1", "stale-digest"]]),
      },
      exportDeps(),
    );

    expect(result.manifest[0]).toMatchObject({
      listingId: "listing_1",
      outcome: "excluded_stale",
    });
  });

  it("treats a listing with no attestation as unattested", async () => {
    const result = await createBulkExport(
      {
        workspaceId: "ws_opak",
        requestedBy: "actor_1",
        listingIds: ["listing_1"],
        attestedDigests: new Map(),
      },
      exportDeps(),
    );

    expect(result.manifest[0]).toMatchObject({ outcome: "excluded_stale" });
  });
});
```

`exportDeps()` stands for this file's existing helper for a successful export. Use whichever the file's passing cases already use. If this file maps freshness failures to a manifest outcome other than `excluded_stale`, assert that outcome instead — check what the existing cases expect for a stale listing.

- [ ] **Step 2: Run them to verify they fail**

Run: `node_modules/.bin/vitest run --root apps/web lib/bulk-export-service.test.ts`
Expected: FAIL — `attestedDigests` is not a known property.

- [ ] **Step 3: Change the service input**

In `apps/web/lib/bulk-export-service.ts`, in `CreateBulkExportInput` (`:55`), replace `freshnessAttested: boolean;` with:

```ts
/**
 * The digest the operator attested, per listing id.
 *
 * A map rather than a boolean because the attestation is evidence about
 * specific content: a listing absent from it was never attested, which the
 * per-listing gate reports as `not_attested`.
 */
attestedDigests: ReadonlyMap<string, string>;
```

- [ ] **Step 4: Pass the per-listing digest**

In the same file, at the `checkBulkUpdateEligibility` call (`:154`), replace:

```ts
        freshnessAttested: input.freshnessAttested,
```

with:

```ts
        attestedRowDigest: input.attestedDigests.get(listingId) ?? null,
```

If the loop variable is not named `listingId` at that point, use whatever identifier that iteration binds.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run --root apps/web lib/bulk-export-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-export-service.ts apps/web/lib/bulk-export-service.test.ts
git commit -m "feat: carry per-listing attested digests through the export service"
```

---

### Task 4: The request shape, the bound, and set equality

**Files:**

- Modify: `apps/web/lib/bulk-approve-limit.ts`
- Modify: `apps/web/app/api/listings/export/route.ts:33-44` (schema), `:87` (handler), `:90-96` (input), `:112-121` (provenance)
- Test: `apps/web/app/api/listings/export/route.test.ts`

- [ ] **Step 1: Add the bound**

Append to `apps/web/lib/bulk-approve-limit.ts`:

```ts
/**
 * The most listings one export request accepts.
 *
 * 100 matches the largest attended UAT stage in the rollout runbook. The
 * request previously had no maximum at all, which mattered little when the
 * body was a list of ids and matters more now that it carries per-listing
 * evidence.
 */
export const MAX_BULK_EXPORT_ITEMS = 100;
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/web/app/api/listings/export/route.test.ts`:

```ts
describe("attestation request shape", () => {
  it("refuses a request whose attestation misses a requested listing", async () => {
    const response = await postExport({
      listingIds: ["listing_1", "listing_2"],
      attestation: {
        listings: [{ listingId: "listing_1", contentDigest: "d1" }],
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "attestation_incomplete",
    });
  });

  it("refuses a request that attests a listing it did not ask to export", async () => {
    const response = await postExport({
      listingIds: ["listing_1"],
      attestation: {
        listings: [
          { listingId: "listing_1", contentDigest: "d1" },
          { listingId: "listing_9", contentDigest: "d9" },
        ],
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "attestation_incomplete",
    });
  });

  it("refuses more listings than one attended stage exports", async () => {
    const listingIds = Array.from({ length: 101 }, (_, i) => `listing_${i}`);
    const response = await postExport({
      listingIds,
      attestation: {
        listings: listingIds.map((listingId) => ({
          listingId,
          contentDigest: "d",
        })),
      },
    });

    expect(response.status).toBe(400);
  });
});
```

`postExport(body)` stands for this file's existing helper for posting to the route. Use whichever the file's passing cases already use.

- [ ] **Step 3: Run them to verify they fail**

Run: `node_modules/.bin/vitest run --root apps/web app/api/listings/export/route.test.ts -t "attestation request shape"`
Expected: FAIL — the schema rejects `attestation` as an unknown key, because it is `.strict()`.

- [ ] **Step 4: Change the schema**

In `apps/web/app/api/listings/export/route.ts`, add the import:

```ts
import { MAX_BULK_EXPORT_ITEMS } from "../../../../lib/bulk-approve-limit";
```

and replace the whole `bodySchema` (`:33-44`) with:

```ts
const bodySchema = z
  .object({
    listingIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_EXPORT_ITEMS),
    attestation: z.object({
      listings: z
        .array(
          z.object({
            listingId: z.string().min(1),
            contentDigest: z.string().min(1),
          }),
        )
        .min(1)
        .max(MAX_BULK_EXPORT_ITEMS),
    }),
  })
  .strict()
  .refine(
    (value) => new Set(value.listingIds).size === value.listingIds.length,
    {
      message: "listingIds must not contain duplicate entries",
      path: ["listingIds"],
    },
  );
```

- [ ] **Step 5: Enforce set equality in the handler**

In the same file, immediately after `const body = bodySchema.parse(await request.json());` (`:87`), insert:

```ts
// Set equality, not containment: an attestation that omits a requested
// listing never covered it, and one that names an extra listing was made
// against a different selection. Either way the evidence does not
// describe this export, so it is a bad request rather than a per-listing
// outcome.
const attested = new Map(
  body.attestation.listings.map((entry) => [
    entry.listingId,
    entry.contentDigest,
  ]),
);
if (
  attested.size !== new Set(body.listingIds).size ||
  body.listingIds.some((listingId) => !attested.has(listingId))
) {
  throw new ApiError(
    400,
    "attestation_incomplete",
    "The attestation does not cover exactly the listings requested.",
  );
}
```

- [ ] **Step 6: Pass the map to the service and fix provenance**

In the same file, in the `input` object (`:90-96`), replace:

```ts
          freshnessAttested: body.freshnessAttested,
```

with:

```ts
          attestedDigests: attested,
```

and in the `provenance` object (`:112-121`) replace:

```ts
          freshnessAttested: body.freshnessAttested,
```

with:

```ts
          attestedListingCount: attested.size,
```

- [ ] **Step 7: Migrate the existing cases in this file**

This file sends `freshnessAttested` in several places, including three `not_attested` assertions (`:900`, `:906`, `:1003`). For each, send an `attestation` whose listings match that case's `listingIds`, using the digest that case's fixture link carries. A case that asserted `not_attested` by sending `freshnessAttested: false` should either omit that listing from the attestation (keeping `not_attested`) or attest a different digest (becoming `row_digest_mismatch`) — pick whichever matches what the case was actually testing.

- [ ] **Step 8: Run the whole file**

Run: `node_modules/.bin/vitest run --root apps/web app/api/listings/export/route.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/bulk-approve-limit.ts apps/web/app/api/listings/export/route.ts apps/web/app/api/listings/export/route.test.ts
git commit -m "feat: take the operator's evidence on the export request and bound it"
```

---

### Task 5: Migration 0025 and the evidence column

**Files:**

- Create: `packages/db/drizzle/0025_export_attempt_attestation.sql`
- Modify: `packages/db/src/schema.ts` (the `exportAttempts` table, from `:838`)
- Modify: `packages/db/src/repositories/export-attempts.ts` (`ensure`, from `:195`)
- Test: `packages/db/src/repositories/export-attempts.integration.test.ts`

- [ ] **Step 1: Write the migration**

Create `packages/db/drizzle/0025_export_attempt_attestation.sql`:

```sql
-- What the operator attested, kept beside the attempt it authorised.
--
-- The export gate used to receive one boolean, which the only UI that calls it
-- hardcoded to true. A human was asked -- the panel disables its button until
-- the box is ticked -- but the attestation was made and enforced entirely in
-- the browser, so nothing recorded who attested, when, or what it covered, and
-- no UAT stage could cite it.
--
-- Nullable on purpose: NULL means "recorded before this column existed", which
-- is true of every historical row. A default of '[]' would invent an empty
-- attestation for exports that never had one, and the route's set-equality
-- check makes an empty array otherwise unreachable.
--
-- Strictly additive. The table already has ENABLE/FORCE row-level security and
-- a workspace policy (0014_export_attempts.sql:15-17), which this column
-- inherits, so there are no policy changes here. Re-running the file is a
-- no-op.
ALTER TABLE export_attempts
  ADD COLUMN IF NOT EXISTS source_attestation jsonb;

DO $attestation_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'export_attempts_source_attestation_is_array'
  ) THEN
    ALTER TABLE export_attempts
      ADD CONSTRAINT export_attempts_source_attestation_is_array
      CHECK (
        source_attestation IS NULL
        OR jsonb_typeof(source_attestation) = 'array'
      );
  END IF;
END
$attestation_check$;
```

- [ ] **Step 2: Rehearse the migration twice**

A Postgres `CHECK` is invisible to fake-repository unit tests — that is how a previous fix passed every unit test and would have raised `check_violation` in production. Prove idempotency before any code depends on this.

From `packages/db`:

```bash
./node_modules/.bin/tsx -e "import {createDatabase} from './src/index.ts'; const db=createDatabase('postgres://wukong_app:wukong-app-local@localhost:54329/wukong',{migrationUrl:'postgres://wukong:wukong@localhost:54329/wukong'}); for (const pass of [1,2]) { await db.migrate(); console.log('pass '+pass+' ok'); } await db.close();"
```

Expected: `pass 1 ok` then `pass 2 ok`, with no error.

- [ ] **Step 3: Declare the column to Drizzle**

In `packages/db/src/schema.ts`, inside the `exportAttempts` table definition, after the `provenance` column, add:

```ts
    sourceAttestation: jsonb("source_attestation").$type<
      Array<{ listingId: string; contentDigest: string }>
    >(),
```

- [ ] **Step 4: Write the failing integration test**

Append to `packages/db/src/repositories/export-attempts.integration.test.ts`:

```ts
it("stores the operator's attestation on a refused attempt as well as a ready one", async () => {
  // "They attested X, we refused because Y" is the half of the evidence a stage
  // review actually needs, so this is recorded before the outcome is known --
  // not only on success.
  const attestation = [{ listingId: "listing_1", contentDigest: "digest_1" }];

  const ensured = await forWorkspace(database, workspaceId, (repos) =>
    repos.exportAttempts.ensure({
      idempotencyKey: "attestation-key-1",
      requestedBy: "actor_1",
      manifest: [],
      sourceAttestation: attestation,
    }),
  );

  const stored = await admin`
    select source_attestation from export_attempts where id = ${ensured.attempt.id}
  `;
  expect(stored[0]!.source_attestation).toEqual(attestation);
});

it("refuses an attestation that is not an array", async () => {
  // The CHECK, which no fake repository can see.
  await expect(
    admin`
      insert into export_attempts (workspace_id, idempotency_key, requested_by, manifest, source_attestation)
      values (${workspaceId}, 'bad-shape-1', 'actor_1', '[]'::jsonb, '{"not":"an array"}'::jsonb)
    `,
  ).rejects.toThrow(/source_attestation_is_array/);
});
```

Use this file's existing `database`, `admin`, `workspaceId` and `forWorkspace` bindings, and its own shape for `ensure`'s required fields — if `ensure` needs more than shown, pass whatever the file's existing passing cases pass.

- [ ] **Step 5: Run it to verify it fails**

```bash
TEST_DATABASE_URL=postgres://wukong_app:wukong-app-local@localhost:54329/wukong TEST_DATABASE_ADMIN_URL=postgres://wukong:wukong@localhost:54329/wukong node_modules/.bin/vitest run --root packages/db src/repositories/export-attempts.integration.test.ts
```

Expected: FAIL — `ensure` does not accept `sourceAttestation`.

- [ ] **Step 6: Accept and write the evidence**

In `packages/db/src/repositories/export-attempts.ts`, add to `ensure`'s input type:

```ts
      sourceAttestation?: Array<{ listingId: string; contentDigest: string }>;
```

and include it in the inserted values:

```ts
        sourceAttestation: input.sourceAttestation ?? null,
```

- [ ] **Step 7: Run the integration test to verify it passes**

Run the Step 5 command again.
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/drizzle/0025_export_attempt_attestation.sql packages/db/src/schema.ts packages/db/src/repositories/export-attempts.ts packages/db/src/repositories/export-attempts.integration.test.ts
git commit -m "feat: keep the operator's attestation beside the attempt it authorised"
```

---

### Task 6: The route records the evidence and audits the counts

**Files:**

- Modify: `apps/web/app/api/listings/export/route.ts:138` (`ensure`), and the `listing.bulk_form_exported` audit write
- Test: `apps/web/app/api/listings/export/route.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/app/api/listings/export/route.test.ts`:

```ts
it("records what was attested on the attempt, and audits only counts", async () => {
  const response = await postExport({
    listingIds: ["listing_1"],
    attestation: {
      listings: [{ listingId: "listing_1", contentDigest: "digest_1" }],
    },
  });

  expect(response.status).toBe(200);
  expect(ensuredAttempts[0]).toMatchObject({
    sourceAttestation: [{ listingId: "listing_1", contentDigest: "digest_1" }],
  });

  const audited = auditEvents.find(
    (event) => event.action === "listing.bulk_form_exported",
  );
  expect(audited?.metadata).toMatchObject({ attestedListingCount: 1 });
  // Digests are hashes rather than content, but the column is the record --
  // audit metadata stays small.
  expect(JSON.stringify(audited?.metadata)).not.toContain("digest_1");
});
```

`ensuredAttempts` and `auditEvents` stand for this file's existing fake-repository captures. Use whichever the file's existing cases assert against.

- [ ] **Step 2: Run it to verify it fails**

Run: `node_modules/.bin/vitest run --root apps/web app/api/listings/export/route.test.ts -t "records what was attested"`
Expected: FAIL — nothing is passed to `ensure`.

- [ ] **Step 3: Pass the evidence to `ensure`**

In `apps/web/app/api/listings/export/route.ts`, in the `repositories.exportAttempts.ensure({ … })` call (`:138`), add:

```ts
              sourceAttestation: body.attestation.listings,
```

- [ ] **Step 4: Add the counts to the audit event**

In the same file, in the `listing.bulk_form_exported` audit write's `metadata`, add:

```ts
            attestedListingCount: attested.size,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run --root apps/web app/api/listings/export/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/listings/export/route.ts apps/web/app/api/listings/export/route.test.ts
git commit -m "feat: record the attestation on the attempt and audit its counts"
```

---

### Task 7: The panel sends what it displayed

**Files:**

- Modify: `apps/web/components/bulk-export-panel.tsx:45` (`selectionIdentity`), `:49-56` (props), `:112-119` (the request)
- Modify: `apps/web/components/catalog-control-center.tsx:275`
- Test: `apps/web/components/bulk-export-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/components/bulk-export-panel.test.tsx` (create it if absent, following the happy-dom pattern in `apps/web/components/batch-list.test.tsx`):

```ts
it("drops the attestation when a digest changes beneath an unchanged selection", async () => {
  // selectionIdentity joined ids only, so a catalog refresh that changed a
  // row's digest left the tick standing over content the operator never saw.
  const { container, root, rerender } = await mountPanel([
    { listingId: "listing_1", contentDigest: "digest_1" },
  ]);
  try {
    const checkbox = container.querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    await act(async () => checkbox.click());
    expect(findButtonByText(container, "Generate")!.disabled).toBe(false);

    await rerender([{ listingId: "listing_1", contentDigest: "digest_2" }]);

    expect(findButtonByText(container, "Generate")!.disabled).toBe(true);
  } finally {
    await unmountPanel(root);
  }
});
```

`mountPanel`, `rerender`, `unmountPanel` and `findButtonByText` are local helpers: `mountPanel` renders `BulkExportPanel` with the given `listings` prop, `rerender` re-renders it with new listings on the same root, and `findButtonByText` is the same helper `batch-list.test.tsx` uses. Write them in this file if they do not exist.

- [ ] **Step 2: Run it to verify it fails**

Run: `node_modules/.bin/vitest run --root apps/web components/bulk-export-panel.test.tsx`
Expected: FAIL — the prop is still `readonly string[]`.

- [ ] **Step 3: Change the prop and the identity**

In `apps/web/components/bulk-export-panel.tsx`, change the prop from `listingIds: readonly string[]` to:

```ts
listings: ReadonlyArray<{ listingId: string; contentDigest: string }>;
```

and replace `selectionIdentity` (`:45-47`) with:

```ts
/**
 * What the operator attested, not merely which rows they picked.
 *
 * This joined ids alone, so when the catalog refreshed and a row's digest
 * changed beneath an unchanged selection, the tick survived over content
 * nobody had looked at. Folding the digests in drops the attestation exactly
 * when what was shown stops being true.
 */
function selectionIdentity(
  listings: ReadonlyArray<{ listingId: string; contentDigest: string }>,
): string {
  return [...listings]
    .map((entry) => `${entry.listingId}:${entry.contentDigest}`)
    .sort()
    .join("\u001f");
}
```

Where the component still needs bare ids, derive them:

```ts
const listingIds = listings.map((entry) => entry.listingId);
```

- [ ] **Step 4: Send the evidence**

In the same file, in the request body (`:115-119`), replace:

```ts
          listingIds: submittedIds,
          freshnessAttested: true,
```

with:

```ts
          listingIds: submittedIds,
          attestation: { listings: [...listings] },
```

- [ ] **Step 5: Supply digests at the call site**

In `apps/web/components/catalog-control-center.tsx`, at `<BulkExportPanel …>` (`:275`), replace `listingIds={selectedIds}` with a `listings` prop built from the rows the checkboxes already iterate (`:462`), for example:

```tsx
          listings={selectedIds.map((listingId) => ({
            listingId,
            contentDigest:
              response.items.find((item) => item.listingId === listingId)
                ?.contentDigest ?? "",
          }))}
```

Use whatever this component already calls its row collection. `contentDigest` is on the catalog contract (`apps/web/lib/catalog-contract.ts:22`).

- [ ] **Step 6: Give the operator words for both refusals**

In `apps/web/lib/approval-ui-copy.ts`, add copy for the refusal that is new,
and reword the one whose meaning changed. Match this file existing entry
shape -- if it keys copy differently from the pairs below, follow its shape.

```ts
  attestation_incomplete: [
    "此確認未涵蓋你選取的商品，請重新確認後再試。",
    "This confirmation does not cover the listings you selected. Confirm again and retry.",
  ],
```

`row_digest_mismatch` used to mean that two reads of the same link raced,
which an operator could do nothing about. It now means the source moved after
they looked, which they can act on:

```ts
  row_digest_mismatch: [
    "來源資料在你確認之後已變更，請重新檢視並確認。",
    "The source changed after you confirmed it. Review it again and confirm.",
  ],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run --root apps/web components/bulk-export-panel.test.tsx components/catalog-control-center.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/bulk-export-panel.tsx apps/web/components/bulk-export-panel.test.tsx apps/web/components/catalog-control-center.tsx apps/web/lib/approval-ui-copy.ts
git commit -m "feat: attest the digests the operator was actually shown"
```

---

### Task 8: Close the deliver path's silent default

**Files:**

- Modify: `apps/web/app/api/listings/[id]/deliver/route.ts:32` (schema), `:158-161` (the call)
- Modify: `apps/web/lib/delivery-service.ts:31` (input), `:501-504` (the export call)
- Test: `apps/web/app/api/listings/[id]/deliver/route.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/app/api/listings/[id]/deliver/route.test.ts`:

```ts
it("refuses a bulk_form delivery that carries no attestation", async () => {
  // The route coerced an absent field to false and passed it straight into
  // createBulkExport, so the first UI to call this would have inherited a
  // refusal nobody chose. Failing loudly is the point.
  const response = await postDeliver("listing_1", { method: "bulk_form" });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: "attestation_incomplete",
  });
});
```

`postDeliver` stands for this file's existing helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `node_modules/.bin/vitest run --root apps/web "app/api/listings/[id]/deliver/route.test.ts"`
Expected: FAIL — the request is accepted.

- [ ] **Step 3: Require the attestation explicitly**

In `apps/web/app/api/listings/[id]/deliver/route.ts`, replace `freshnessAttested: z.boolean().optional(),` (`:32`) with:

```ts
    attestedContentDigest: z.string().min(1).optional(),
```

and replace the `bulk_form` branch (`:159-161`) with:

```ts
          ...(body.method === "bulk_form"
            ? {
                attestedContentDigest: (() => {
                  if (!body.attestedContentDigest) {
                    throw new ApiError(
                      400,
                      "attestation_incomplete",
                      "A bulk form delivery must carry the attested source digest.",
                    );
                  }
                  return body.attestedContentDigest;
                })(),
              }
            : {}),
```

- [ ] **Step 4: Thread it through the service**

In `apps/web/lib/delivery-service.ts`, replace `freshnessAttested?: boolean;` (`:31`) with:

```ts
  attestedContentDigest?: string;
```

and replace the export call's attestation line (`:504`) with:

```ts
    attestedDigests: new Map(
      input.attestedContentDigest
        ? [[input.draftId, input.attestedContentDigest]]
        : [],
    ),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node_modules/.bin/vitest run --root apps/web "app/api/listings/[id]/deliver/route.test.ts" lib/delivery-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/[id]/deliver/route.ts" apps/web/lib/delivery-service.ts "apps/web/app/api/listings/[id]/deliver/route.test.ts"
git commit -m "fix: make the deliver path demand an attestation instead of defaulting to none"
```

---

### Task 9: Full gates, records, and the deployment constraint

**Files:**

- Modify: `docs/implementation/wukong-remediation-verification.md` (the "Deployment order" section)
- Modify: `docs/superpowers/plans/2026-09-11-release-gate-closure.md` (W1)

- [ ] **Step 1: Run every gate**

```bash
pnpm lint
pnpm test
pnpm build
RELEASE_BASE_SHA=9f72a37ebeb6549f1041bae673bcee841bf72402 pnpm format:runtime:check
pnpm release-gate:check
```

Expected: 14/14 tasks for lint and for test, 8/8 for build, no files requiring Prettier, and 6 automated release-gate checks passing.

- [ ] **Step 2: Run the integration suite**

Needs Postgres, MinIO and the `wukong-local` bucket — nothing in the runbook creates that bucket, so create it if the product-shot files fail with `NoSuchBucket`.

```bash
pnpm test:integration
```

Expected: all files pass, no failures.

- [ ] **Step 3: Record the deployment constraint**

In `docs/implementation/wukong-remediation-verification.md`, under "Deployment order", update the heading's count and add:

```markdown
4. **Migration `0025` before the web deploy.** The export route writes
   `export_attempts.source_attestation`. A web deploy that precedes the
   migration fails every export at the insert, after the operator has already
   attested — the worst possible moment to discover it.
```

- [ ] **Step 4: Mark W1 done in the workstream plan**

In `docs/superpowers/plans/2026-09-11-release-gate-closure.md`, under W1, add a `**Done**` note recording that the attested digest now feeds `expectedRowDigest`, that no new freshness reason was needed because `row_digest_mismatch` became the real check, and that `attestation_incomplete` is a 400 rather than a per-listing outcome.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: record the attestation work and its deployment constraint"
```

---

## What this plan does not do

- **It does not verify the merchant's live store.** Nothing can. The attestation records a human judgement and binds it to what they saw.
- **It adds no expiry window.** An attestation submitted with its own export is never stale in wall-clock terms. If attestations later become independent artefacts, revisit it.
- **It enables no SHOPLINE write.** Preview stays `mock`, production stays `disabled` with `SHOPLINE_PUBLISH_ENABLED=false`.
- **It builds no delivery UI for `bulk_form`.** Task 8 makes that path fail loudly; it does not make it usable.
