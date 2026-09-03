# `/jobs` Import-Result Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `POST /api/listings/[id]/shopline-import-result`, recording what SHOPLINE actually accepted after an operator manually re-imports a Wukong-generated bulk-form file, and surface it as a 5th entry kind in the existing `/jobs` ledger.

**Architecture:** One new table (`import_results`) + repository, one new route (mirroring `approve/route.ts`'s conventions), extensions to four existing `/jobs`-ledger files, and one documentation addition. No changes to `delivery-service.ts` or `bulk-export-service.ts` — `exportAttemptId` is nullable so the endpoint works whether or not the listing's bulk-form file came from a tracked multi-product export.

**Tech Stack:** TypeScript, Drizzle ORM + raw SQL migrations, Next.js route handlers, Vitest (unit + `.integration.test.ts` against live Postgres for the repository layer).

---

**Live-code discipline:** every file:line reference below was verified against the live checkout during this session's design/research pass (2026-09-03). Even so, **each task's first step is always "read the current file"** — treat quoted code as a starting point to diff against, not a guarantee.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for every command, e.g. `corepack pnpm exec vitest run <path>` and `corepack pnpm --filter <package> typecheck`. Task 1's integration test needs live Postgres — `docker compose up -d postgres` first if it isn't already running (per `docs/runbooks/local-development.md`); if Docker isn't available in the execution environment, implement Task 1 in full, report the integration test as written-but-unable-to-run, and let Task 5's final verification confirm it once Postgres is reachable.

---

## Task 1: Migration, schema, and repository

**Files:**

- Create: `packages/db/drizzle/0015_import_results.sql`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/repositories/import-results.ts`
- Create: `packages/db/src/repositories/import-results.integration.test.ts`
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`

- [ ] **Step 1: Read the current files**

Read `packages/db/drizzle/0014_export_attempts.sql`, `packages/db/src/schema.ts` (specifically the `platformProducts` table at lines 644–716 and the `exportAttempts` table at lines 818–853), `packages/db/src/repositories/export-attempts.ts` and `export-attempts.integration.test.ts` in full, and `packages/db/src/client.ts` (imports around lines 55–65, `WorkspaceRepositories` type around lines 76–91, `runForWorkspace`'s repository construction around lines 165–210). Confirm they still match what's quoted below — this plan's line numbers are a starting point, not a guarantee.

Confirm `export_attempts` still has **no** unique index on `(workspace_id, id)` — only `export_attempts_workspace_idempotency_uq` on `(workspace_id, idempotency_key)`. This matters because `import_results.exportAttemptId` needs a composite FK to `(export_attempts.workspace_id, export_attempts.id)`, and Postgres requires a unique constraint on exactly those referenced columns before such an FK can be created.

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0015_import_results.sql`:

```sql
-- export_attempts has no unique index on (workspace_id, id) yet -- only on
-- (workspace_id, idempotency_key). import_results.export_attempt_id needs a
-- composite FK to (workspace_id, id), which requires this index to exist
-- first.
CREATE UNIQUE INDEX IF NOT EXISTS export_attempts_workspace_id_uq
  ON export_attempts (workspace_id, id);

CREATE TABLE IF NOT EXISTS import_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  export_attempt_id uuid,
  outcome text NOT NULL,
  reject_reason text,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_results_outcome_check CHECK (outcome IN ('accepted', 'rejected')),
  CONSTRAINT import_results_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT import_results_workspace_export_attempt_fkey
    FOREIGN KEY (workspace_id, export_attempt_id)
    REFERENCES export_attempts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS import_results_workspace_listing_idx
  ON import_results (workspace_id, listing_id);

ALTER TABLE import_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_results_workspace_policy ON import_results;
CREATE POLICY import_results_workspace_policy ON import_results
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE import_results TO wukong_app;
```

- [ ] **Step 3: Add the Drizzle schema definition**

In `packages/db/src/schema.ts`, immediately after the `exportAttempts` table definition (after its closing `);` — the line following what you read as line 853 in Step 1), add:

```ts
export const importResults = pgTable(
  "import_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    listingId: uuid("listing_id").notNull(),
    /** Null when the recorded listing's bulk-form file came from the
     * single-listing `deliver` (bulk_form) path, which persists no
     * export_attempts row -- only the multi-product `/api/listings/export`
     * route produces one to reference here. */
    exportAttemptId: uuid("export_attempt_id"),
    outcome: text("outcome").notNull(),
    rejectReason: text("reject_reason"),
    recordedBy: text("recorded_by").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index("import_results_workspace_listing_idx").on(
      table.workspaceId,
      table.listingId,
    ),
    check(
      "import_results_outcome_check",
      sql`outcome IN ('accepted', 'rejected')`,
    ),
    foreignKey({
      name: "import_results_workspace_listing_fkey",
      columns: [table.workspaceId, table.listingId],
      foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "import_results_workspace_export_attempt_fkey",
      columns: [table.workspaceId, table.exportAttemptId],
      foreignColumns: [exportAttempts.workspaceId, exportAttempts.id],
    }).onDelete("restrict"),
  ],
);
```

Also add a unique index on `exportAttempts` matching the migration's `export_attempts_workspace_id_uq` — find `exportAttempts`'s own `(table) => [...]` array (the block containing `uniqueIndex("export_attempts_workspace_idempotency_uq")`) and add a sibling entry:

```ts
    uniqueIndex("export_attempts_workspace_id_uq").on(
      table.workspaceId,
      table.id,
    ),
```

Confirm `check`, `foreignKey`, `index`, `uniqueIndex`, and `sql` are already imported at the top of `schema.ts` (they are used by `platformProducts` already) — no new imports needed for this step.

- [ ] **Step 4: Write the failing repository test**

Create `packages/db/src/repositories/import-results.integration.test.ts`, mirroring `export-attempts.integration.test.ts`'s exact structure (same `postgres`/`createDatabase` setup, same `beforeAll`/`afterAll`, same two-workspace pattern). This test needs a real `listing_drafts` row to satisfy the FK — read `export-attempts.integration.test.ts`'s sibling `platform-products.integration.test.ts` (or any integration test that inserts a `listing_drafts` row directly via `admin.unsafe`) to copy the minimal valid INSERT shape for that table, since `listing_drafts` requires `workspace_id` and has sensible defaults for everything else per the schema you read in Step 1.

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

const workspaceId = "ws_import_results";
const otherWorkspaceId = "ws_import_results_other";
const listingId = "11111111-1111-4111-8111-111111111111";

describe("import results repository", () => {
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
    await admin.unsafe(`
      INSERT INTO listing_drafts (id, workspace_id) VALUES
        ('${listingId}', '${workspaceId}');
    `);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("creates an import result and reads it back via listForWorkspace", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.importResults.create({
        listingId,
        exportAttemptId: null,
        outcome: "accepted",
        rejectReason: null,
        recordedBy: "user_1",
      });
      expect(created.outcome).toBe("accepted");
      expect(created.exportAttemptId).toBeNull();

      const listed = await repositories.importResults.listForWorkspace();
      expect(listed.map((row) => row.id)).toContain(created.id);
    });
  });

  it("stores a reject reason for a rejected outcome", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const created = await repositories.importResults.create({
        listingId,
        exportAttemptId: null,
        outcome: "rejected",
        rejectReason: "SKU already exists on another product",
        recordedBy: "user_1",
      });
      expect(created.outcome).toBe("rejected");
      expect(created.rejectReason).toBe(
        "SKU already exists on another product",
      );
    });
  });

  it("never exposes an import result to another workspace", async () => {
    const created = await database.forWorkspace(workspaceId, (repositories) =>
      repositories.importResults.create({
        listingId,
        exportAttemptId: null,
        outcome: "accepted",
        rejectReason: null,
        recordedBy: "user_1",
      }),
    );

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const listed = await repositories.importResults.listForWorkspace();
      expect(listed.map((row) => row.id)).not.toContain(created.id);
    });
  });

  it("enforces the limit bounds on listForWorkspace", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.importResults.listForWorkspace(0),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
      await expect(
        repositories.importResults.listForWorkspace(101),
      ).rejects.toThrow(/limit must be between 1 and 100/i);
    });
  });

  it("rejects a listingId that does not exist in this workspace (FK restrict)", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      await expect(
        repositories.importResults.create({
          listingId: "99999999-9999-4999-8999-999999999999",
          exportAttemptId: null,
          outcome: "accepted",
          rejectReason: null,
          recordedBy: "user_1",
        }),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `corepack pnpm exec vitest run packages/db/src/repositories/import-results.integration.test.ts`
Expected: FAIL — `repositories.importResults` is `undefined` (the repository doesn't exist yet, nothing is registered on `WorkspaceRepositories`).

- [ ] **Step 6: Implement the repository**

Create `packages/db/src/repositories/import-results.ts`:

```ts
import { desc, eq } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { importResults } from "../schema.js";

export type ImportResultOutcome = "accepted" | "rejected";

export type CreateImportResultInput = {
  listingId: string;
  exportAttemptId: string | null;
  outcome: ImportResultOutcome;
  rejectReason: string | null;
  recordedBy: string;
};

export type ImportResult = {
  id: string;
  listingId: string;
  exportAttemptId: string | null;
  outcome: ImportResultOutcome;
  rejectReason: string | null;
  recordedBy: string;
  createdAt: Date;
};

export type ImportResultRepository = {
  create(input: CreateImportResultInput): Promise<ImportResult>;
  /** Newest-first, this workspace's import results only. `limit` defaults to
   * 100 and must be between 1 and 100 -- matches every sibling
   * `listForWorkspace` repository's own bound (export-attempts.ts, etc.). */
  listForWorkspace(limit?: number): Promise<ImportResult[]>;
};

const COLUMNS = {
  id: importResults.id,
  listingId: importResults.listingId,
  exportAttemptId: importResults.exportAttemptId,
  outcome: importResults.outcome,
  rejectReason: importResults.rejectReason,
  recordedBy: importResults.recordedBy,
  createdAt: importResults.createdAt,
};

export function createImportResultRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ImportResultRepository {
  return {
    async create(input) {
      scope.assertOpen();
      const [row] = await transaction
        .insert(importResults)
        .values({
          workspaceId,
          listingId: input.listingId,
          exportAttemptId: input.exportAttemptId,
          outcome: input.outcome,
          rejectReason: input.rejectReason,
          recordedBy: input.recordedBy,
        })
        .returning(COLUMNS);
      if (!row) throw new Error("import result insert did not return a row");
      return row as ImportResult;
    },

    async listForWorkspace(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("import result limit must be between 1 and 100");
      }
      const rows = await transaction
        .select(COLUMNS)
        .from(importResults)
        .where(eq(importResults.workspaceId, workspaceId))
        .orderBy(desc(importResults.createdAt), desc(importResults.id))
        .limit(limit);
      return rows as ImportResult[];
    },
  };
}
```

If `export-attempts.ts`'s own `COLUMNS`-based select does **not** need an `as ExportAttempt[]` cast (check what you read in Step 1), drop the casts here too and match whatever the real file does — don't introduce a cast the established pattern doesn't need.

- [ ] **Step 7: Wire the repository into `client.ts` and `index.ts`**

In `packages/db/src/client.ts`, immediately after the `createExportAttemptRepository` import block:

```ts
import {
  createImportResultRepository,
  type ImportResultRepository,
} from "./repositories/import-results.js";
```

In `WorkspaceRepositories`, immediately after `exportAttempts: ExportAttemptRepository;`:

```ts
importResults: ImportResultRepository;
```

In `runForWorkspace`'s `repositories` object, immediately after the `exportAttempts: createExportAttemptRepository(...)` block:

```ts
        importResults: createImportResultRepository(
          transaction,
          workspaceId,
          scope,
        ),
```

In `packages/db/src/index.ts`, immediately after the `export type { ... } from "./repositories/export-attempts.js";` block:

```ts
export type {
  CreateImportResultInput,
  ImportResult,
  ImportResultOutcome,
  ImportResultRepository,
} from "./repositories/import-results.js";
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `corepack pnpm exec vitest run packages/db/src/repositories/import-results.integration.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 9: Typecheck**

Run: `corepack pnpm --filter @wukong/db typecheck`
Expected: exit 0, clean.

- [ ] **Step 10: Commit**

```bash
git add packages/db/drizzle/0015_import_results.sql packages/db/src/schema.ts packages/db/src/repositories/import-results.ts packages/db/src/repositories/import-results.integration.test.ts packages/db/src/client.ts packages/db/src/index.ts
git commit -m "feat: add import_results table and repository for SHOPLINE import reconciliation"
```

(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 2: `POST /api/listings/[id]/shopline-import-result` route

**Files:**

- Create: `apps/web/app/api/listings/[id]/shopline-import-result/route.ts`
- Create: `apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts`

- [ ] **Step 1: Read the current files**

Read `apps/web/app/api/listings/[id]/approve/route.ts` in full (deps factory, `RouteContext` async-params, id-regex validation, `withRouteErrors`) and `apps/web/app/api/enrichment-batches/route.ts` in full (operator role gate via `requireWorkspaceRole("operator", context.role)`, zod `.strict()` body schema, `ApiError` shape). Also read one existing route test file in this directory tree (e.g. `apps/web/app/api/enrichment-batches/route.test.ts` or `apps/web/app/api/listings/[id]/approve/route.test.ts`) to capture the exact fake-deps construction pattern this codebase uses for route tests — a fake `sessionContext` resolving a fixed session, and a fake `getDatabase()` returning an object whose `forWorkspace` calls straight into an in-memory fake `repositories` object.

Confirm `repositories.listings.getById(id): Promise<Listing | null>` still exists (`packages/db/src/repositories/listings.ts:59`) as the simple existence check to use here — this route does not need `approve/route.ts`'s heavier `getReviewSnapshot` (that method exists for approval-specific business logic this route doesn't need).

Confirm the real `repositories.audit.write(...)` call shape by re-reading `apps/web/app/api/listings/export/route.ts`'s own audit write (its `listing.bulk_export_created` event) — the shape is `{ workspaceId, actorId, entityId, action, metadata }`.

- [ ] **Step 2: Write the failing route test**

Create `apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts`, matching the fake-deps pattern from Step 1's reference file exactly (adapt its literal fake `repositories` shape/imports to whatever that file actually does — the sketch below shows the required test cases, not a guaranteed-exact fake-deps skeleton):

```ts
import { describe, expect, it } from "vitest";

import { createImportResultHandler } from "./route.js";

const listingId = "11111111-1111-4111-8111-111111111111";
const exportAttemptId = "22222222-2222-4222-8222-222222222222";

function makeHandler(
  overrides: {
    role?: string;
    listingExists?: boolean;
    exportAttemptExists?: boolean;
  } = {},
) {
  const role = overrides.role ?? "operator";
  const listingExists = overrides.listingExists ?? true;
  const exportAttemptExists = overrides.exportAttemptExists ?? true;

  const auditEvents: unknown[] = [];
  const created: unknown[] = [];

  const repositories = {
    listings: {
      async getById(id: string) {
        return listingExists ? { id } : null;
      },
    },
    exportAttempts: {
      async getById(id: string) {
        return exportAttemptExists ? { id } : null;
      },
    },
    importResults: {
      async create(input: unknown) {
        const row = {
          id: "created_1",
          createdAt: new Date("2026-09-03T00:00:00.000Z"),
          ...(input as Record<string, unknown>),
        };
        created.push(row);
        return row;
      },
    },
    audit: {
      async write(event: unknown) {
        auditEvents.push(event);
      },
    },
  };

  const deps = {
    sessionContext: {
      async resolve() {
        return {
          workspaceId: "ws_1",
          actorId: "user_1",
          role,
        };
      },
    },
    getDatabase: () => ({
      async forWorkspace(
        _workspaceId: string,
        work: (repos: unknown) => unknown,
      ) {
        return work(repositories);
      },
    }),
  };

  return {
    handler: createImportResultHandler(deps as never),
    auditEvents,
    created,
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/listings/x/shopline-import-result", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/listings/[id]/shopline-import-result", () => {
  it("records an accepted outcome and writes an audit event", async () => {
    const { handler, auditEvents, created } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "accepted" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.outcome).toBe("accepted");
    expect(created).toHaveLength(1);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        action: "listing.shopline_import_result_recorded",
        entityId: listingId,
        metadata: expect.objectContaining({ outcome: "accepted" }),
      }),
    ]);
  });

  it("records a rejected outcome with a reason", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "rejected", rejectReason: "duplicate SKU" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.outcome).toBe("rejected");
  });

  it("records an outcome against a specific exportAttemptId", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "accepted", exportAttemptId }),
      makeContext(listingId),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.exportAttemptId).toBe(exportAttemptId);
  });

  it("rejects a rejected outcome with no rejectReason as a 400", async () => {
    const { handler } = makeHandler();
    const response = await handler(
      makeRequest({ outcome: "rejected" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown listing", async () => {
    const { handler } = makeHandler({ listingExists: false });
    const response = await handler(
      makeRequest({ outcome: "accepted" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("listing_not_found");
  });

  it("returns 404 for an exportAttemptId not found in this workspace", async () => {
    const { handler } = makeHandler({ exportAttemptExists: false });
    const response = await handler(
      makeRequest({ outcome: "accepted", exportAttemptId }),
      makeContext(listingId),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("export_attempt_not_found");
  });

  it("returns 403 for a viewer role", async () => {
    const { handler } = makeHandler({ role: "viewer" });
    const response = await handler(
      makeRequest({ outcome: "accepted" }),
      makeContext(listingId),
    );
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `corepack pnpm exec vitest run "apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts"`
Expected: FAIL — the route module doesn't exist yet.

- [ ] **Step 4: Implement the route**

Create `apps/web/app/api/listings/[id]/shopline-import-result/route.ts`. Adapt the exact import paths (`../../../../../lib/...`) to match this file's real directory depth relative to `apps/web/app/api/listings/[id]/approve/route.ts`'s own imports (same depth — this route lives at the same nesting level under `[id]/`):

```ts
import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };

type ImportResultRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
};

const bodySchema = z
  .object({
    outcome: z.enum(["accepted", "rejected"]),
    rejectReason: z.string().min(1).max(2000).optional(),
    exportAttemptId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (body) => body.outcome !== "rejected" || body.rejectReason !== undefined,
    { message: 'rejectReason is required when outcome is "rejected".' },
  );

export function createImportResultHandler(deps: ImportResultRouteDeps) {
  return async function importResultHandler(
    request: Request,
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
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      }

      const body = bodySchema.parse(await request.json());

      const created = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const listing = await repositories.listings.getById(id);
          if (!listing) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }

          if (body.exportAttemptId) {
            const attempt = await repositories.exportAttempts.getById(
              body.exportAttemptId,
            );
            if (!attempt) {
              throw new ApiError(
                404,
                "export_attempt_not_found",
                "Export attempt not found.",
              );
            }
          }

          const row = await repositories.importResults.create({
            listingId: id,
            exportAttemptId: body.exportAttemptId ?? null,
            outcome: body.outcome,
            rejectReason: body.rejectReason ?? null,
            recordedBy: session.actorId,
          });

          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "listing.shopline_import_result_recorded",
            metadata: {
              outcome: body.outcome,
              exportAttemptId: body.exportAttemptId ?? null,
            },
          });

          return row;
        });

      return jsonResponse(201, {
        id: created.id,
        listingId: created.listingId,
        outcome: created.outcome,
        exportAttemptId: created.exportAttemptId,
        createdAt: created.createdAt.toISOString(),
      });
    });
  };
}

export const POST = createImportResultHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `corepack pnpm exec vitest run "apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts"`
Expected: PASS, all 8 tests.

- [ ] **Step 6: Typecheck**

Run: `corepack pnpm --filter @wukong/web typecheck`
Expected: exit 0, clean.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/api/listings/[id]/shopline-import-result/route.ts" "apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts"
git commit -m "feat: add POST /api/listings/[id]/shopline-import-result endpoint"
```

(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 3: `/jobs` ledger integration

**Files:**

- Modify: `apps/web/lib/jobs-ledger.ts`
- Modify: `apps/web/lib/jobs-ledger.test.ts`
- Modify: `apps/web/app/api/jobs/route.ts`
- Modify: `apps/web/app/api/jobs/route.test.ts`
- Modify: `apps/web/components/jobs-ledger-client.tsx`
- Modify: `apps/web/components/jobs-ledger-client.test.tsx`

- [ ] **Step 1: Read the current files**

Read all six files listed above in full. Confirm `apps/web/lib/jobs-ledger.ts` still matches the shape quoted in this task (180 lines: `LedgerKind` at line 8, `JobsLedgerSources` at lines 22–27, the `entries` array construction inside `buildJobsLedger` ending with the `...sources.exports.map(...)` block around lines 137–154). Confirm `apps/web/app/api/jobs/route.ts` still matches (62 lines: the `Promise.all([...])` at lines 37–45, the `buildJobsLedger({...}, ...)` call at lines 47–50). Confirm `apps/web/components/jobs-ledger-client.tsx`'s `KIND_FILTERS`/`KIND_LABELS` still match (lines 29–42).

- [ ] **Step 2: Write the failing tests**

In `apps/web/lib/jobs-ledger.test.ts`, find the existing test(s) for the `export` source's mapper and add a sibling test for `import_result`, matching this file's real existing per-source test structure and its `JobsLedgerSources` fixture-building conventions:

```ts
it("maps an accepted import result to a succeeded entry", () => {
  const entries = buildJobsLedger(
    {
      batches: [],
      publishJobs: [],
      pipelineRuns: [],
      exports: [],
      importResults: [
        {
          id: "ir_1",
          listingId: "listing_1",
          exportAttemptId: null,
          outcome: "accepted",
          rejectReason: null,
          recordedBy: "user_1",
          createdAt: new Date("2026-09-03T00:00:00.000Z"),
        },
      ],
    },
    10,
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "import_result",
    id: "ir_1",
    listingId: "listing_1",
    normalizedStatus: "succeeded",
    rawStatus: "accepted",
  });
});

it("maps a rejected import result to a failed entry with the reason in the summary", () => {
  const entries = buildJobsLedger(
    {
      batches: [],
      publishJobs: [],
      pipelineRuns: [],
      exports: [],
      importResults: [
        {
          id: "ir_2",
          listingId: "listing_2",
          exportAttemptId: null,
          outcome: "rejected",
          rejectReason: "duplicate SKU",
          recordedBy: "user_1",
          createdAt: new Date("2026-09-03T00:00:00.000Z"),
        },
      ],
    },
    10,
  );
  expect(entries[0]).toMatchObject({
    kind: "import_result",
    normalizedStatus: "failed",
    rawStatus: "rejected",
  });
  expect(entries[0]!.summary).toContain("duplicate SKU");
});
```

Adapt the surrounding `batches: [], publishJobs: [], ...` shape to whatever the file's real existing tests already use for the other three empty sources — match the established fixture style exactly, don't invent a new one.

In `apps/web/app/api/jobs/route.test.ts`, find the existing test asserting all 4 sources are fetched/merged and extend its fake `repositories` object with a 5th fake, `importResults: { async listForWorkspace() { return [...]; } }`, then assert an `import_result`-kind entry appears in the response. Match this file's real existing fake-`repositories`-construction pattern exactly.

In `apps/web/components/jobs-ledger-client.test.tsx`, find the existing per-kind filter/render test(s) and add a sibling case for `import_result`, matching the file's real existing test structure (likely rendering the component with a mocked `fetch` response containing an `import_result`-kind `WireLedgerEntry`, then asserting the kind filter button and the rendered label/summary appear).

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
corepack pnpm exec vitest run apps/web/lib/jobs-ledger.test.ts
corepack pnpm exec vitest run apps/web/app/api/jobs/route.test.ts
corepack pnpm exec vitest run apps/web/components/jobs-ledger-client.test.tsx
```

Expected: all three FAIL — `import_result` isn't a valid `LedgerKind` yet (TypeScript error in the test files themselves, or a runtime mismatch), `JobsLedgerSources` has no `importResults` field, and the route/component don't know about the new kind.

- [ ] **Step 4: Implement the ledger integration**

In `apps/web/lib/jobs-ledger.ts`:

Change the import block (lines 1–6) to also import `ImportResult`:

```ts
import type {
  EnrichmentBatch,
  ExportAttempt,
  ImportResult,
  PipelineRunSummary,
  PublishJob,
} from "@wukong/db";
```

Change line 8:

```ts
export type LedgerKind =
  "batch" | "publish_job" | "pipeline_run" | "export" | "import_result";
```

Change `JobsLedgerSources` (lines 22–27) to add a 5th field:

```ts
export type JobsLedgerSources = {
  batches: readonly EnrichmentBatch[];
  publishJobs: readonly PublishJob[];
  pipelineRuns: readonly PipelineRunSummary[];
  exports: readonly ExportAttempt[];
  importResults: readonly ImportResult[];
};
```

Inside `buildJobsLedger`'s `entries` array construction, immediately after the `...sources.exports.map((attempt): LedgerEntry => {...}),` block, add:

```ts
    ...sources.importResults.map((result): LedgerEntry => ({
      kind: "import_result",
      id: result.id,
      listingId: result.listingId,
      normalizedStatus: result.outcome === "accepted" ? "succeeded" : "failed",
      rawStatus: result.outcome,
      createdAt: result.createdAt,
      summary:
        result.outcome === "accepted"
          ? "Import accepted by SHOPLINE"
          : `Import rejected: ${result.rejectReason ?? "no reason given"}`,
    })),
```

In `apps/web/app/api/jobs/route.ts`, change the `Promise.all([...])` (lines 37–45) to fetch a 5th source:

```ts
const [batches, publishJobs, pipelineRuns, exports, importResults] =
  await Promise.all([
    repositories.enrichmentBatches.listForWorkspace(SOURCE_FETCH_LIMIT),
    repositories.publishJobs.listForWorkspace(SOURCE_FETCH_LIMIT),
    repositories.pipelineRuns.listForWorkspace(SOURCE_FETCH_LIMIT),
    repositories.exportAttempts.listForWorkspace(SOURCE_FETCH_LIMIT),
    repositories.importResults.listForWorkspace(SOURCE_FETCH_LIMIT),
  ]);

return buildJobsLedger(
  { batches, publishJobs, pipelineRuns, exports, importResults },
  LEDGER_DISPLAY_LIMIT,
);
```

In `apps/web/components/jobs-ledger-client.tsx`, change `KIND_FILTERS` (lines 29–35) to add a new entry:

```ts
const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "全部 All" },
  { value: "batch", label: "批次 Batch" },
  { value: "publish_job", label: "發佈工作 Publish job" },
  { value: "pipeline_run", label: "AI 流程 Pipeline run" },
  { value: "export", label: "匯出 Export" },
  { value: "import_result", label: "匯入結果 Import result" },
];
```

Change `KIND_LABELS` (lines 37–42) to match:

```ts
const KIND_LABELS: Record<LedgerKind, string> = {
  batch: "批次 Batch",
  publish_job: "發佈工作 Publish job",
  pipeline_run: "AI 流程 Pipeline run",
  export: "匯出 Export",
  import_result: "匯入結果 Import result",
};
```

No other change needed in this file — the row template is generic over `LedgerKind`.

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
corepack pnpm exec vitest run apps/web/lib/jobs-ledger.test.ts
corepack pnpm exec vitest run apps/web/app/api/jobs/route.test.ts
corepack pnpm exec vitest run apps/web/components/jobs-ledger-client.test.tsx
```

Expected: all three PASS, including every pre-existing test in each file.

- [ ] **Step 6: Typecheck**

Run: `corepack pnpm --filter @wukong/web typecheck`
Expected: exit 0, clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/jobs-ledger.ts apps/web/lib/jobs-ledger.test.ts apps/web/app/api/jobs/route.ts apps/web/app/api/jobs/route.test.ts apps/web/components/jobs-ledger-client.tsx apps/web/components/jobs-ledger-client.test.tsx
git commit -m "feat: show recorded SHOPLINE import results in the /jobs ledger"
```

(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 4: Documentation

**Files:**

- Modify: `docs/runbooks/shopline-pilot-onboarding.md`

- [ ] **Step 1: Read the current file**

Read `docs/runbooks/shopline-pilot-onboarding.md` in full. Confirm its current section numbers — at design time it had: §1 Developer Center installation, §2 Merchant enablement, §3 Hidden test product and delivery, §4 Importing an existing catalog, §5 Enriching an imported catalog, §6 Exporting enrichment back to SHOPLINE, §7 Approving many listings at once, §8 Workspace admin area, §9 Re-delivering a published listing via SHOPLINE API. If this has changed, adjust the renumbering in Step 2 accordingly — don't blindly apply "insert as §7, bump the rest" if the live file no longer has 9 sections in this order.

- [ ] **Step 2: Insert the new section and renumber**

Insert a new section immediately after the existing §6 ("Exporting enrichment back to SHOPLINE") and before the existing §7 ("Approving many listings at once"):

````markdown
## 7. Recording a SHOPLINE import result

After manually re-importing a Wukong-generated bulk-form file into SHOPLINE (§6), record what SHOPLINE actually reported. Nothing does this automatically — the `/jobs` ledger only shows that a file was _generated_, not what happened after you uploaded it.

```bash
curl -X POST "$WUKONG_BASE_URL/api/listings/<draft-uuid>/shopline-import-result" \
  -H "Cookie: $WUKONG_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"outcome":"accepted"}'
```
````

If SHOPLINE rejected the row, record why:

```bash
curl -X POST "$WUKONG_BASE_URL/api/listings/<draft-uuid>/shopline-import-result" \
  -H "Cookie: $WUKONG_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"outcome":"rejected","rejectReason":"duplicate SKU"}'
```

If this listing's file came from a multi-product export, include that export's id so the record can be traced back to the exact file:

```bash
curl -X POST "$WUKONG_BASE_URL/api/listings/<draft-uuid>/shopline-import-result" \
  -H "Cookie: $WUKONG_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"outcome":"accepted","exportAttemptId":"<export-attempt-uuid>"}'
```

Requires the operator role. This call is per-listing: reconciling a multi-product export means calling it once per listing in that batch, the same way approving many listings at once (below) calls single-listing approval logic once per listing rather than as one combined request. Recorded results appear in the `/jobs` ledger as `import_result` entries.

````

Renumber the existing §7 ("Approving many listings at once") to §8, existing §8 ("Workspace admin area") to §9, and existing §9 ("Re-delivering a published listing via SHOPLINE API") to §10 — update only the `## N.` heading numbers, not their titles or content.

- [ ] **Step 3: Verify the renumbering**

```bash
grep -n "^## " docs/runbooks/shopline-pilot-onboarding.md
````

Expected: exactly 10 numbered sections, 1 through 10, in order, no gaps or duplicates, with "Recording a SHOPLINE import result" as §7.

- [ ] **Step 4: Format check**

```bash
corepack pnpm exec prettier --check docs/runbooks/shopline-pilot-onboarding.md
```

If it fails, run `corepack pnpm exec prettier --write docs/runbooks/shopline-pilot-onboarding.md` and re-check.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md
git commit -m "docs: document recording a SHOPLINE import result"
```

(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run every directly-affected test file**

```bash
corepack pnpm exec vitest run packages/db/src/repositories/import-results.integration.test.ts
corepack pnpm exec vitest run "apps/web/app/api/listings/[id]/shopline-import-result/route.test.ts"
corepack pnpm exec vitest run apps/web/lib/jobs-ledger.test.ts
corepack pnpm exec vitest run apps/web/app/api/jobs/route.test.ts
corepack pnpm exec vitest run apps/web/components/jobs-ledger-client.test.tsx
```

Expected: all PASS, zero failures across all five files. If Task 1's integration test couldn't run earlier because Postgres wasn't available, run `docker compose up -d postgres` (per `docs/runbooks/local-development.md`) and confirm it now passes here.

- [ ] **Step 2: Typecheck both touched packages**

```bash
corepack pnpm --filter @wukong/db typecheck
corepack pnpm --filter @wukong/web typecheck
```

Expected: both exit 0, clean.

- [ ] **Step 3: Format check**

```bash
node scripts/check-runtime-format.mjs
```

If any touched file is listed, run `corepack pnpm exec prettier --write <file>` on it and commit that separately as a small `style:` follow-up commit (this is the project's real diff-based format gate — prefer it over a raw `prettier --check .`, which produces CRLF false positives on this Windows checkout).

- [ ] **Step 4: Report status**

Do not push or open a pull request — stop here and report back with the full verification checklist's results (Steps 1–3), matching how every prior package/fix this session was handed back for the user's own review/merge.
