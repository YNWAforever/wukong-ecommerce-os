# Wukong Shopline AI Listing MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tenant-isolated SaaS workflow that converts product images, supplier PDFs, and operator notes into a bilingual, evidence-backed wine listing which a human can approve and deliver to SHOPLINE through the OpenAPI or a validated CSV fallback.

**Architecture:** Use a pnpm/Turborepo TypeScript monorepo with a Next.js operator app, a BullMQ worker, PostgreSQL/Drizzle repositories, an S3-compatible asset boundary, a provider-neutral AI gateway, and a versioned SHOPLINE projection shared by the API connector and CSV exporter. Domain packages own validation and policy; web and worker code orchestrate those packages without duplicating approval, tenant, or platform rules.

**Tech Stack:** Node.js 24, pnpm 11.7, TypeScript 7.0, Turborepo 2.10, Next.js 16.2, React 19.2, Tailwind CSS 4.3, Zod 4.4, Drizzle ORM 0.45, PostgreSQL, BullMQ 5.80, Redis, OpenAI SDK 6.46 with the Responses API, AWS SDK 3.1085 for S3-compatible storage, Auth.js 5 beta, Vitest 4.1, and Playwright 1.61.

## Global Constraints

- Every tenant-owned record contains `workspace_id`; application access goes through workspace-scoped repositories and PostgreSQL row-level security.
- Human approval is mandatory before every SHOPLINE API write and every CSV export; this rule is enforced in the domain and delivery services, not only in the UI.
- The agent must not invent vintage, critic score, region, ABV, volume, price, stock, or awards. Unknown values remain empty and are surfaced as `Needs information`.
- Every AI call records provider, model, prompt version, latency, token use, estimated cost, outcome, workspace, and draft.
- Every field edit, compliance resolution, approval, state transition, and delivery attempt writes an append-only audit event.
- English and Traditional Chinese are the MVP content locales; Traditional Chinese is the primary operator UI locale.
- Opak Cellar rules are workspace seed data, never conditionals keyed to an Opak name or ID.
- Direct SHOPLINE access uses `https://open.shopline.io/v1`, bearer authentication, `POST /products`, `PUT /products/{id}`, and `GET /products/{id}` according to the current official OpenAPI registry.
- The OpenAI adapter uses the Responses API with Zod-backed Structured Outputs; `OPENAI_LISTING_MODEL` defaults to `gpt-5.6-terra` and is configurable without code changes.
- Production resources, secrets, and writes to Opak Cellar require explicit authorization outside this implementation plan.

---

## File Map

```text
apps/web/
  app/(app)/dashboard/page.tsx            Draft queues and next actions
  app/(app)/listings/new/page.tsx         Intake form
  app/(app)/listings/[id]/page.tsx        Evidence, review, and delivery workspace
  app/api/assets/presign/route.ts          Authorized upload URL creation
  app/api/assets/finalize/route.ts         Source-asset registration
  app/api/listings/route.ts                Draft creation
  app/api/listings/[id]/approve/route.ts   Approval action
  app/api/listings/[id]/deliver/route.ts   SHOPLINE API or CSV delivery
  app/api/auth/[...nextauth]/route.ts      Auth.js route
  auth.ts                                  Auth.js configuration
  lib/session-context.ts                   Session-to-workspace authorization
  components/                              Focused dashboard, intake, review, and delivery UI

apps/worker/
  src/index.ts                             Queue worker bootstrap
  src/listing-pipeline.ts                  Extract, reconcile, generate, and validate orchestration
  src/publish-product.ts                   Idempotent SHOPLINE publication job

packages/core/
  src/listing-schema.ts                    Canonical wine listing Zod schemas
  src/workflow.ts                          State machine and transition policy
  src/compliance.ts                        Deterministic claim rules and resolution policy
  src/review.ts                            Immutable edit, approval, and reopen operations

packages/db/
  src/schema.ts                            Auth, tenant, listing, audit, AI, and delivery tables
  src/client.ts                            Pooled and migration database clients
  src/repositories/                        Workspace-scoped persistence interfaces
  drizzle/                                 Generated SQL migrations including RLS
  src/seed-opak.ts                         Opak workspace and profile seed

packages/assets/
  src/asset-store.ts                       AssetStore interface and memory test adapter
  src/s3-asset-store.ts                    Signed S3-compatible implementation

packages/ai/
  src/contracts.ts                         Provider-neutral extraction/generation contracts
  src/fake-listing-provider.ts             Deterministic test adapter
  src/openai-listing-provider.ts           Responses API multimodal adapter
  src/prompts.ts                           Versioned extraction and generation prompts

packages/shopline/
  src/projection.ts                        Canonical-to-SHOPLINE mapping
  src/validation.ts                        Platform field validation
  src/csv.ts                               CSV fallback
  src/connector.ts                         CommerceConnector interface
  src/shopline-connector.ts                Bearer-auth OpenAPI adapter

tests/e2e/
  listing-pilot.spec.ts                    Full Opak happy path and approval-negative path
fixtures/opak/
  expected-listing.json                    Authorized synthetic pilot expectation
  supplier-sheet.txt                       Synthetic supplier facts
  bottle-label.svg                         Synthetic product label image
```

---

### Task 1: Monorepo Foundation and Canonical Listing Contract

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/listing-schema.ts`
- Test: `packages/core/src/listing-schema.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `canonicalListingSchema`, `CanonicalListing`, `listingFactsSchema`, `ListingFacts`, `fieldEvidenceSchema`, `FieldEvidence`, `workspaceProfileSchema`, and `WorkspaceProfile`.

- [ ] **Step 1: Create the workspace manifests and test runner**

```json
{
  "name": "wukong-ecommerce-os",
  "private": true,
  "packageManager": "pnpm@11.7.0",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@types/node": "latest",
    "prettier": "3.9.5",
    "turbo": "2.10.4",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Add workspace patterns for `apps/*` and `packages/*`, a strict shared TypeScript config, and Turbo tasks whose `build` depends on upstream builds while `test`, `lint`, and `typecheck` are cacheable.

- [ ] **Step 2: Install the verified dependency set**

Run: `pnpm.cmd install`

Expected: exit code `0`, `pnpm-lock.yaml` created, and no unsupported-engine warning.

- [ ] **Step 3: Write the failing canonical-listing test**

```ts
import { describe, expect, it } from "vitest";
import { canonicalListingSchema } from "./listing-schema";

describe("canonicalListingSchema", () => {
  it("accepts an evidence-backed bilingual wine listing", () => {
    const parsed = canonicalListingSchema.parse({
      sku: "OPAK-DEMO-001",
      title: { en: "Demo Estate Riesling 2024", "zh-Hant": "Demo Estate 雷司令 2024" },
      description: { en: "Dry Riesling.", "zh-Hant": "乾身雷司令。" },
      producer: "Demo Estate",
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
      seo: {
        title: { en: "Demo Riesling 2024", "zh-Hant": "Demo 雷司令 2024" },
        description: { en: "Dry Mosel Riesling.", "zh-Hant": "Mosel 乾身雷司令。" }
      },
      tags: ["Riesling", "Mosel"],
      imageAssetIds: ["asset_demo_1"]
    });

    expect(parsed.priceHkd).toBe(288);
  });

  it("rejects negative prices and impossible alcohol values", () => {
    expect(() => canonicalListingSchema.parse({ priceHkd: -1, abvPercent: 101 })).toThrow();
  });
});
```

- [ ] **Step 4: Run the test and confirm the contract is absent**

Run: `pnpm.cmd --filter @wukong/core test -- listing-schema.test.ts`

Expected: FAIL because `./listing-schema` does not exist.

- [ ] **Step 5: Implement the canonical schemas**

```ts
import { z } from "zod";

export const localizedTextSchema = z.object({
  en: z.string().trim().min(1),
  "zh-Hant": z.string().trim().min(1)
});

export const fieldEvidenceSchema = z.object({
  field: z.string().min(1),
  sourceAssetId: z.string().min(1),
  page: z.number().int().positive().nullable(),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export const listingFactsSchema = z.object({
  sku: z.string().trim().min(1).nullable(),
  producer: z.string().trim().min(1).nullable(),
  productType: z.enum(["wine", "spirits", "sake", "other"]).nullable(),
  country: z.string().trim().min(1).nullable(),
  region: z.string().trim().min(1).nullable(),
  vintage: z.number().int().min(1800).max(2100).nullable(),
  grapeVarieties: z.array(z.string().trim().min(1)),
  volumeMl: z.number().int().positive().nullable(),
  abvPercent: z.number().min(0).max(100).nullable(),
  packQuantity: z.number().int().positive().default(1),
  priceHkd: z.number().nonnegative().nullable(),
  stockQuantity: z.number().int().nonnegative().nullable(),
  criticScores: z.array(z.object({ source: z.string(), score: z.string(), evidenceId: z.string() })),
  awards: z.array(z.object({ name: z.string(), evidenceId: z.string() }))
});

export const canonicalListingSchema = listingFactsSchema.extend({
  sku: z.string().trim().min(1),
  producer: z.string().trim().min(1),
  productType: z.enum(["wine", "spirits", "sake", "other"]),
  country: z.string().trim().min(1),
  volumeMl: z.number().int().positive(),
  abvPercent: z.number().min(0).max(100),
  priceHkd: z.number().nonnegative(),
  title: localizedTextSchema,
  description: localizedTextSchema,
  seo: z.object({ title: localizedTextSchema, description: localizedTextSchema }),
  tags: z.array(z.string().trim().min(1)),
  imageAssetIds: z.array(z.string().min(1))
});

export const workspaceProfileSchema = z.object({
  name: z.string().min(1),
  currency: z.literal("HKD"),
  locales: z.tuple([z.literal("en"), z.literal("zh-Hant")]),
  tone: z.string().min(1),
  claimPolicy: z.array(z.string().min(1)),
  requiredFields: z.array(z.string().min(1))
});

export type CanonicalListing = z.infer<typeof canonicalListingSchema>;
export type ListingFacts = z.infer<typeof listingFactsSchema>;
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
```

- [ ] **Step 6: Run the package checks**

Run: `pnpm.cmd --filter @wukong/core test; pnpm.cmd --filter @wukong/core typecheck`

Expected: both commands exit `0` and the schema test reports `2 passed`.

- [ ] **Step 7: Commit the foundation**

```powershell
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.workspace.ts .gitignore .env.example pnpm-lock.yaml packages/core
git commit -m "build: establish Wukong monorepo and listing contract"
```

---

### Task 2: Workflow, Review, and Compliance Policy

**Files:**
- Create: `packages/core/src/workflow.ts`
- Create: `packages/core/src/compliance.ts`
- Create: `packages/core/src/review.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/workflow.test.ts`
- Test: `packages/core/src/compliance.test.ts`
- Test: `packages/core/src/review.test.ts`

**Interfaces:**
- Consumes: `CanonicalListing` and `WorkspaceProfile` from Task 1.
- Produces: `ListingStatus`, `transitionListing`, `scanCompliance`, `resolveFlag`, `approveListing`, and `reopenListing`.

- [ ] **Step 1: Write failing state-machine and approval tests**

```ts
import { describe, expect, it } from "vitest";
import { transitionListing } from "./workflow";

describe("transitionListing", () => {
  it("permits the reviewed approval path", () => {
    expect(transitionListing("in_review", "approve")).toBe("approved");
  });

  it("rejects delivery from an unapproved state", () => {
    expect(() => transitionListing("in_review", "begin_publish")).toThrow("Illegal transition");
  });
});
```

Add compliance tests proving `guaranteed health benefits` is blocking and a review test proving approval fails while a blocking flag is unresolved.

- [ ] **Step 2: Run tests and verify the policy modules are missing**

Run: `pnpm.cmd --filter @wukong/core test -- workflow.test.ts compliance.test.ts review.test.ts`

Expected: FAIL with unresolved module errors.

- [ ] **Step 3: Implement the guarded workflow**

```ts
export type ListingStatus =
  | "received" | "processing" | "needs_info" | "in_review"
  | "approved" | "reopened" | "publishing" | "published"
  | "publish_failed" | "failed";

export type ListingAction =
  | "start_processing" | "request_info" | "submit_review" | "approve"
  | "reopen" | "begin_publish" | "publish_succeeded" | "publish_failed" | "fail" | "retry";

const transitions: Record<ListingStatus, Partial<Record<ListingAction, ListingStatus>>> = {
  received: { start_processing: "processing" },
  processing: { request_info: "needs_info", submit_review: "in_review", fail: "failed" },
  needs_info: { start_processing: "processing" },
  in_review: { approve: "approved" },
  approved: { reopen: "reopened", begin_publish: "publishing" },
  reopened: { submit_review: "in_review" },
  publishing: { publish_succeeded: "published", publish_failed: "publish_failed" },
  published: { reopen: "reopened" },
  publish_failed: { retry: "publishing", reopen: "reopened" },
  failed: { retry: "processing" }
};

export function transitionListing(status: ListingStatus, action: ListingAction): ListingStatus {
  const next = transitions[status][action];
  if (!next) throw new Error(`Illegal transition: ${status} -> ${action}`);
  return next;
}
```

- [ ] **Step 4: Implement deterministic compliance and approval**

```ts
export type ComplianceFlag = {
  id: string;
  field: string;
  rule: "health_claim" | "guarantee" | "rating_without_evidence" | "superlative";
  severity: "blocking" | "warning";
  status: "open" | "resolved";
  resolutionReason: string | null;
};

const blockingPatterns = [
  { rule: "health_claim" as const, pattern: /health benefit|治療|保健功效/i },
  { rule: "guarantee" as const, pattern: /guaranteed|保證/i }
];

export function scanCompliance(fields: Record<string, string>): ComplianceFlag[] {
  return Object.entries(fields).flatMap(([field, value]) =>
    blockingPatterns
      .filter(({ pattern }) => pattern.test(value))
      .map(({ rule }, index) => ({
        id: `${field}:${rule}:${index}`,
        field,
        rule,
        severity: "blocking" as const,
        status: "open" as const,
        resolutionReason: null
      }))
  );
}

export function resolveFlag(flag: ComplianceFlag, reason: string): ComplianceFlag {
  if (reason.trim().length < 10) throw new Error("A meaningful resolution reason is required");
  return { ...flag, status: "resolved", resolutionReason: reason.trim() };
}

export function approveListing(versionId: string, flags: ComplianceFlag[]) {
  if (flags.some((flag) => flag.severity === "blocking" && flag.status === "open")) {
    throw new Error("Blocking compliance flags must be resolved before approval");
  }
  return { versionId, status: "approved" as const };
}

export function reopenListing(status: ListingStatus): ListingStatus {
  return transitionListing(status, "reopen");
}
```

- [ ] **Step 5: Run policy tests**

Run: `pnpm.cmd --filter @wukong/core test`

Expected: all Task 1 and Task 2 tests pass.

- [ ] **Step 6: Commit the domain policy**

```powershell
git add packages/core
git commit -m "feat: enforce listing workflow and approval policy"
```

---

### Task 3: Tenant Data Model, Audit Store, and RLS

**Files:**
- Create: `docker-compose.yml`
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/repositories/listings.ts`
- Create: `packages/db/src/repositories/audit.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/drizzle/0000_initial.sql`
- Test: `packages/db/src/repositories/listings.integration.test.ts`

**Interfaces:**
- Consumes: listing statuses and canonical-listing JSON from Tasks 1 and 2.
- Produces: `Database`, `forWorkspace(database, workspaceId, work)`, `ListingRepository`, `AuditWriter`, and persisted prompt/AI/publish records.

- [ ] **Step 1: Add local PostgreSQL, Redis, MinIO, and Mailpit services**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: wukong
      POSTGRES_PASSWORD: wukong
      POSTGRES_DB: wukong
    ports: ["54329:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U wukong"]
      interval: 2s
      timeout: 2s
      retries: 20
  redis:
    image: redis:8-alpine
    ports: ["6389:6379"]
  minio:
    image: minio/minio:latest
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: wukong
      MINIO_ROOT_PASSWORD: wukong-secret
    ports: ["9010:9000", "9011:9001"]
  mailpit:
    image: axllent/mailpit:latest
    ports: ["1026:1025", "8026:8025"]
```

- [ ] **Step 2: Write the failing cross-workspace repository test**

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDatabase, forWorkspace } from "../index";

describe("workspace isolation", () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL!);

  beforeAll(async () => {
    await db.migrate();
  });

  it("never returns another workspace's listing", async () => {
    const created = await forWorkspace(db, "ws_opak", (repos) =>
      repos.listings.create({ target: "shopline" })
    );
    const foreignResult = await forWorkspace(db, "ws_other", (repos) =>
      repos.listings.getById(created.id)
    );

    expect(foreignResult).toBeNull();
  });
});
```

- [ ] **Step 3: Start PostgreSQL and confirm the test fails**

Run: `docker compose up -d postgres; pnpm.cmd --filter @wukong/db test:integration`

Expected: FAIL because `createDatabase` and `forWorkspace` do not exist.

- [ ] **Step 4: Define the Drizzle tables and scoped repository**

```ts
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const listingStatus = pgEnum("listing_status", [
  "received", "processing", "needs_info", "in_review", "approved",
  "reopened", "publishing", "published", "publish_failed", "failed"
]);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  profile: jsonb("profile").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const listingDrafts = pgTable("listing_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id).notNull(),
  status: listingStatus("status").default("received").notNull(),
  target: text("target").default("shopline").notNull(),
  activeVersionId: uuid("active_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [index("listing_workspace_status_idx").on(table.workspaceId, table.status)]);

export const listingVersions = pgTable("listing_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  listingId: uuid("listing_id").references(() => listingDrafts.id).notNull(),
  sequence: integer("sequence").notNull(),
  content: jsonb("content").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("listing_version_sequence_uq").on(table.listingId, table.sequence)]);
```

Add auth tables, memberships, source assets, field evidence, compliance flags, prompt versions, AI runs, SHOPLINE connections, publish jobs, review events, and audit events with `workspace_id` indexes. The repository constructor captures a non-empty workspace ID and includes it in every select, update, and delete predicate.

- [ ] **Step 5: Add database-level RLS policies**

```sql
ALTER TABLE listing_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_workspace_policy ON listing_drafts
USING (workspace_id = current_setting('app.workspace_id', true))
WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
```

Apply the same policy shape to every tenant-owned table. `forWorkspace` starts a transaction, executes `select set_config('app.workspace_id', $1, true)`, and exposes repositories only within that transaction callback.

- [ ] **Step 6: Run migration, isolation, and type checks**

Run: `pnpm.cmd --filter @wukong/db db:migrate; pnpm.cmd --filter @wukong/db test:integration; pnpm.cmd --filter @wukong/db typecheck`

Expected: migration exits `0`, the cross-workspace test passes, and typecheck exits `0`.

- [ ] **Step 7: Commit the data layer**

```powershell
git add docker-compose.yml packages/db pnpm-lock.yaml
git commit -m "feat: add tenant-isolated listing data layer"
```

---

### Task 4: Asset Storage and Listing Intake

**Files:**
- Create: `packages/assets/package.json`
- Create: `packages/assets/src/asset-store.ts`
- Create: `packages/assets/src/s3-asset-store.ts`
- Create: `packages/assets/src/index.ts`
- Test: `packages/assets/src/asset-store.test.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/app/api/assets/presign/route.ts`
- Create: `apps/web/app/api/assets/finalize/route.ts`
- Create: `apps/web/app/api/listings/route.ts`
- Test: `apps/web/app/api/assets/finalize/route.test.ts`

**Interfaces:**
- Consumes: `forWorkspace`, source-asset repository, and listing repository from Task 3.
- Produces: `AssetStore`, `MemoryAssetStore`, `S3AssetStore`, `POST /api/assets/presign`, `POST /api/assets/finalize`, and `POST /api/listings`.

- [ ] **Step 1: Write the failing asset-key isolation test**

```ts
import { describe, expect, it } from "vitest";
import { MemoryAssetStore } from "./asset-store";

describe("MemoryAssetStore", () => {
  it("prefixes every key with the authorized workspace", async () => {
    const store = new MemoryAssetStore();
    const upload = await store.createUpload({
      workspaceId: "ws_opak",
      fileName: "supplier.pdf",
      mimeType: "application/pdf",
      size: 1024
    });
    expect(upload.key).toMatch(/^ws\/ws_opak\/sources\//);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm.cmd --filter @wukong/assets test`

Expected: FAIL because the package and adapter are absent.

- [ ] **Step 3: Implement the asset boundary**

```ts
export type CreateUploadInput = {
  workspaceId: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  size: number;
};

export interface AssetStore {
  createUpload(input: CreateUploadInput): Promise<{ key: string; uploadUrl: string; expiresAt: Date }>;
  createReadUrl(workspaceId: string, key: string): Promise<{ url: string; expiresAt: Date }>;
  exists(workspaceId: string, key: string): Promise<boolean>;
}

export function assertAssetInput(input: CreateUploadInput) {
  if (input.size <= 0 || input.size > 20 * 1024 * 1024) throw new Error("File must be between 1 byte and 20 MB");
  if (!input.fileName.trim()) throw new Error("File name is required");
}
```

`S3AssetStore` generates keys as `ws/{workspaceId}/sources/{uuid}/{safeFileName}`, uses a 10-minute presigned PUT, and refuses a read key that does not begin with the same workspace prefix.

- [ ] **Step 4: Write the failing finalize-route test**

```ts
it("rejects a storage key from another workspace", async () => {
  const response = await finalizeAsset(
    { workspaceId: "ws_opak", actorId: "user_1" },
    { key: "ws/ws_other/sources/a/file.pdf", mimeType: "application/pdf", size: 1200, sha256: "a".repeat(64) }
  );
  expect(response.status).toBe(403);
});
```

- [ ] **Step 5: Implement presign, finalize, and listing creation handlers**

Handlers parse Zod request schemas, derive workspace and actor only from `sessionContext()`, verify storage existence at finalize, persist SHA-256 and MIME metadata, and emit `asset.finalized` or `listing.created` audit events. `POST /api/listings` accepts `sourceAssetIds` and `note`, verifies every asset belongs to the workspace, then creates one `received` draft.

- [ ] **Step 6: Run package and route tests**

Run: `pnpm.cmd --filter @wukong/assets test; pnpm.cmd --filter @wukong/web test -- finalize/route.test.ts`

Expected: all tests pass; the negative route test returns `403`.

- [ ] **Step 7: Commit intake**

```powershell
git add packages/assets apps/web package.json pnpm-lock.yaml
git commit -m "feat: add isolated asset intake and draft creation"
```

---

### Task 5: Provider-Neutral AI Gateway and OpenAI Adapter

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/src/contracts.ts`
- Create: `packages/ai/src/prompts.ts`
- Create: `packages/ai/src/fake-listing-provider.ts`
- Create: `packages/ai/src/openai-listing-provider.ts`
- Create: `packages/ai/src/index.ts`
- Test: `packages/ai/src/fake-listing-provider.test.ts`
- Test: `packages/ai/src/openai-listing-provider.test.ts`

**Interfaces:**
- Consumes: `ListingFacts`, `FieldEvidence`, `CanonicalListing`, and `WorkspaceProfile` from Task 1.
- Produces: `ListingAIProvider`, `ExtractionResult`, `GenerationResult`, `FakeListingProvider`, and `OpenAIListingProvider`.

- [ ] **Step 1: Write the failing provider contract test**

```ts
import { describe, expect, it } from "vitest";
import { FakeListingProvider } from "./fake-listing-provider";

describe("FakeListingProvider", () => {
  it("returns missing price instead of inventing it", async () => {
    const provider = new FakeListingProvider();
    const result = await provider.extract({
      assets: [{ id: "asset_1", mimeType: "image/png", readUrl: "memory://label" }],
      note: "Demo Estate Riesling 2024, 750ml, 12.5% ABV"
    });
    expect(result.facts.priceHkd).toBeNull();
    expect(result.missingFields).toContain("priceHkd");
  });
});
```

- [ ] **Step 2: Run the test and verify the provider is absent**

Run: `pnpm.cmd --filter @wukong/ai test`

Expected: FAIL because `FakeListingProvider` does not exist.

- [ ] **Step 3: Define the gateway interfaces and prompt versions**

```ts
export type ExtractionInput = {
  assets: Array<{ id: string; mimeType: string; readUrl: string }>;
  note: string | null;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  model: string;
  promptVersion: string;
};

export type ExtractionResult = {
  facts: ListingFacts;
  evidence: FieldEvidence[];
  missingFields: string[];
  usage: AIUsage;
};

export type GenerationInput = {
  facts: ListingFacts;
  evidence: FieldEvidence[];
  profile: WorkspaceProfile;
  imageAssetIds: string[];
};

export type GenerationResult = {
  listing: CanonicalListing;
  usage: AIUsage;
};

export interface ListingAIProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
  generate(input: GenerationInput): Promise<GenerationResult>;
}

export const EXTRACTION_PROMPT = { name: "listing-extraction", version: "1.0.0" } as const;
export const GENERATION_PROMPT = { name: "listing-generation", version: "1.0.0" } as const;
```

- [ ] **Step 4: Implement the deterministic fake**

The fake parses the supplied fixture note into known fields, attaches a note excerpt as evidence, returns `null` for absent protected facts, and creates bilingual fixture copy from the supplied producer and vintage. It never reads environment variables.

- [ ] **Step 5: Write the OpenAI request-shape test before the adapter**

```ts
it("uses Responses structured parsing and configured model", async () => {
  const create = vi.fn().mockResolvedValue({
    output_parsed: extractionFixture,
    usage: { input_tokens: 100, output_tokens: 50 }
  });
  const provider = new OpenAIListingProvider({ responses: { parse: create } } as never, "gpt-5.6-terra");
  await provider.extract({ assets: [], note: "Demo Estate Riesling 2024" });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-terra" }));
});
```

- [ ] **Step 6: Implement the OpenAI Responses adapter**

```ts
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

export class OpenAIListingProvider implements ListingAIProvider {
  constructor(
    private readonly client: OpenAI = new OpenAI(),
    private readonly model = process.env.OPENAI_LISTING_MODEL ?? "gpt-5.6-terra"
  ) {}

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const response = await this.client.responses.parse({
      model: this.model,
      reasoning: { effort: "low" },
      input: buildExtractionInput(input),
      text: { format: zodTextFormat(extractionOutputSchema, "listing_extraction") }
    });
    if (!response.output_parsed) throw new Error("AI extraction returned no parsed output");
    return withUsage(response.output_parsed, response.usage);
  }
}
```

`buildExtractionInput` emits `input_text`, `input_image`, and `input_file` parts, tells the model to leave absent protected facts `null`, and requires evidence excerpts. The adapter performs one bounded repair request only when a parsed response is absent; refusals and API errors remain typed failures.

- [ ] **Step 7: Run AI unit tests without an API key**

Run: `pnpm.cmd --filter @wukong/ai test; pnpm.cmd --filter @wukong/ai typecheck`

Expected: all tests pass without a network call or `OPENAI_API_KEY`.

- [ ] **Step 8: Commit the AI boundary**

```powershell
git add packages/ai pnpm-lock.yaml
git commit -m "feat: add structured listing AI gateway"
```

---

### Task 6: Listing Pipeline and BullMQ Worker

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/queue.ts`
- Create: `apps/worker/src/listing-pipeline.ts`
- Create: `apps/worker/src/index.ts`
- Test: `apps/worker/src/listing-pipeline.test.ts`

**Interfaces:**
- Consumes: `ListingAIProvider`, `AssetStore`, workspace repositories, `scanCompliance`, and `transitionListing`.
- Produces: `LISTING_QUEUE`, `enqueueListingPipeline`, and `runListingPipeline({ workspaceId, draftId })`.

- [ ] **Step 1: Write the failing complete-pipeline test**

```ts
it("moves an evidence-backed draft into review and logs AI usage", async () => {
  const result = await runListingPipeline({ workspaceId: "ws_opak", draftId: "draft_1" }, deps);
  expect(result.status).toBe("in_review");
  expect(deps.audit.events).toContainEqual(expect.objectContaining({ action: "listing.submitted_for_review" }));
  expect(deps.aiRuns.records).toHaveLength(2);
});
```

Add a second test where missing price moves to `needs_info` and a provider timeout moves to `failed` without losing the source assets.

- [ ] **Step 2: Run the worker tests and verify the orchestrator is absent**

Run: `pnpm.cmd --filter @wukong/worker test`

Expected: FAIL with unresolved `runListingPipeline`.

- [ ] **Step 3: Implement the pipeline orchestration**

```ts
export async function runListingPipeline(
  input: { workspaceId: string; draftId: string },
  deps: PipelineDependencies
) {
  return deps.withWorkspace(input.workspaceId, async (repos) => {
    const draft = await repos.listings.requireById(input.draftId);
    await repos.listings.transition(draft.id, "start_processing");
    const assets = await repos.assets.listForDraft(draft.id);
    const extraction = await deps.ai.extract(await deps.assetInputs(assets));
    await repos.aiRuns.append(aiRunFrom("extract", extraction.usage, draft.id));
    const generation = await deps.ai.generate({
      facts: extraction.facts,
      evidence: extraction.evidence,
      profile: await repos.workspaces.requireProfile(),
      imageAssetIds: assets.filter((asset) => asset.mimeType.startsWith("image/")).map((asset) => asset.id)
    });
    await repos.aiRuns.append(aiRunFrom("generate", generation.usage, draft.id));
    const flags = scanCompliance(flattenLocalizedContent(generation.listing));
    const version = await repos.listings.appendVersion(draft.id, generation.listing, "agent");
    await repos.listings.replaceEvidence(version.id, extraction.evidence);
    await repos.listings.replaceFlags(version.id, flags);
    const action = extraction.missingFields.length ? "request_info" : "submit_review";
    const status = await repos.listings.transition(draft.id, action);
    return { status, versionId: version.id };
  });
}

function flattenLocalizedContent(listing: CanonicalListing): Record<string, string> {
  return {
    titleEn: listing.title.en,
    titleZhHant: listing.title["zh-Hant"],
    descriptionEn: listing.description.en,
    descriptionZhHant: listing.description["zh-Hant"]
  };
}

function aiRunFrom(task: "extract" | "generate", usage: AIUsage, draftId: string) {
  return { task, draftId, ...usage, outcome: "succeeded" as const };
}
```

- [ ] **Step 4: Add queue idempotency and bounded retries**

`enqueueListingPipeline` uses job ID `listing:{workspaceId}:{draftId}:{activeVersionSequence}`. The worker uses three attempts with exponential backoff starting at 2 seconds, records the terminal error code, and never includes file bytes, credentials, or raw prompts in the BullMQ payload.

- [ ] **Step 5: Run worker tests and a local Redis smoke test**

Run: `docker compose up -d redis; pnpm.cmd --filter @wukong/worker test; pnpm.cmd --filter @wukong/worker test:integration`

Expected: unit and Redis queue tests pass; duplicate enqueue returns the existing job.

- [ ] **Step 6: Commit orchestration**

```powershell
git add apps/worker pnpm-lock.yaml
git commit -m "feat: orchestrate evidence-backed listing generation"
```

---

### Task 7: SHOPLINE Projection, Validation, and CSV Fallback

**Files:**
- Create: `packages/shopline/package.json`
- Create: `packages/shopline/src/projection.ts`
- Create: `packages/shopline/src/validation.ts`
- Create: `packages/shopline/src/csv.ts`
- Create: `packages/shopline/src/index.ts`
- Create: `packages/shopline/fixtures/shopline-create-product.json`
- Test: `packages/shopline/src/projection.test.ts`
- Test: `packages/shopline/src/csv.test.ts`

**Interfaces:**
- Consumes: `CanonicalListing`.
- Produces: `ShoplineProductPayload`, `projectToShopline`, `validateShoplineProduct`, and `createShoplineCsv`.

- [ ] **Step 1: Write the failing projection test**

```ts
it("maps bilingual content into SHOPLINE translations", () => {
  const payload = projectToShopline(approvedListingFixture);
  expect(payload.product.title_translations).toEqual({
    en: "Demo Estate Riesling 2024",
    "zh-hant": "Demo Estate 雷司令 2024"
  });
  expect(payload.product.price).toBe(288);
  expect(payload.product.status).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify the mapper is absent**

Run: `pnpm.cmd --filter @wukong/shopline test -- projection.test.ts`

Expected: FAIL because `projectToShopline` does not exist.

- [ ] **Step 3: Implement the versioned SHOPLINE payload**

```ts
export type ShoplineProductPayload = {
  product: {
    sku: string;
    price: number;
    quantity?: number;
    unlimited_quantity: boolean;
    title_translations: { en: string; "zh-hant": string };
    description_translations: { en: string; "zh-hant": string };
    seo_title_translations: { en: string; "zh-hant": string };
    seo_description_translations: { en: string; "zh-hant": string };
    tags: string[];
    images: string[];
    status: false;
  };
};

export function projectToShopline(listing: CanonicalListing, imageUrls: string[] = []): ShoplineProductPayload {
  return {
    product: {
      sku: listing.sku,
      price: listing.priceHkd!,
      ...(listing.stockQuantity === null ? {} : { quantity: listing.stockQuantity }),
      unlimited_quantity: listing.stockQuantity === null,
      title_translations: { en: listing.title.en, "zh-hant": listing.title["zh-Hant"] },
      description_translations: { en: listing.description.en, "zh-hant": listing.description["zh-Hant"] },
      seo_title_translations: { en: listing.seo.title.en, "zh-hant": listing.seo.title["zh-Hant"] },
      seo_description_translations: { en: listing.seo.description.en, "zh-hant": listing.seo.description["zh-Hant"] },
      tags: listing.tags,
      images: imageUrls,
      status: false
    }
  };
}
```

`validateShoplineProduct` rejects a missing price, blank translation, duplicate SKU, non-HTTPS image URL, title beyond the recorded platform limit, and any value not representable by the current contract fixture.

- [ ] **Step 4: Write and implement the CSV golden test**

```ts
it("creates a stable UTF-8 SHOPLINE CSV", () => {
  const csv = createShoplineCsv([projectToShopline(approvedListingFixture)]);
  expect(csv).toContain("SKU,English Title,Traditional Chinese Title,Price");
  expect(csv).toContain("OPAK-DEMO-001,Demo Estate Riesling 2024,Demo Estate 雷司令 2024,288");
});
```

Use `csv-stringify/sync` with `header: true`, CRLF record delimiters, and a stable column order recorded in `SHOPLINE_CSV_SPEC_VERSION = "opak-2026-07"`.

- [ ] **Step 5: Run projection, validation, and CSV tests**

Run: `pnpm.cmd --filter @wukong/shopline test; pnpm.cmd --filter @wukong/shopline typecheck`

Expected: tests and typecheck pass; the CSV snapshot is UTF-8 and deterministic.

- [ ] **Step 6: Commit the delivery projection**

```powershell
git add packages/shopline pnpm-lock.yaml
git commit -m "feat: add versioned SHOPLINE projection and CSV"
```

---

### Task 8: SHOPLINE OpenAPI Connector and Approval-Gated Delivery

**Files:**
- Create: `packages/shopline/src/connector.ts`
- Create: `packages/shopline/src/shopline-connector.ts`
- Test: `packages/shopline/src/shopline-connector.test.ts`
- Create: `apps/worker/src/publish-product.ts`
- Test: `apps/worker/src/publish-product.test.ts`

**Interfaces:**
- Consumes: `ShoplineProductPayload`, approved versions, publish-job repository, and audit writer.
- Produces: `CommerceConnector`, `ShoplineConnector`, and `publishApprovedProduct`.

- [ ] **Step 1: Write the failing connector HTTP test**

```ts
it("creates a hidden SHOPLINE product with bearer authentication", async () => {
  server.use(http.post("https://open.shopline.io/v1/products", ({ request }) => {
    expect(request.headers.get("authorization")).toBe("Bearer shopline_test_token");
    return HttpResponse.json({ product: { _id: "remote_123" } });
  }));
  const result = await connector.createProduct(shoplinePayloadFixture, "delivery_key_1");
  expect(result.remoteProductId).toBe("remote_123");
});
```

- [ ] **Step 2: Run the connector test and verify it fails**

Run: `pnpm.cmd --filter @wukong/shopline test -- shopline-connector.test.ts`

Expected: FAIL because `ShoplineConnector` is absent.

- [ ] **Step 3: Implement the transport contract**

```ts
export interface CommerceConnector {
  verifyConnection(): Promise<{ merchantId: string | null }>;
  createProduct(payload: ShoplineProductPayload, idempotencyKey: string): Promise<{ remoteProductId: string }>;
  updateProduct(remoteProductId: string, payload: ShoplineProductPayload, idempotencyKey: string): Promise<void>;
  getProductStatus(remoteProductId: string): Promise<{ exists: boolean; status: boolean | null }>;
}

export class ShoplineConnector implements CommerceConnector {
  constructor(private readonly token: string, private readonly baseUrl = "https://open.shopline.io/v1") {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, ...init.headers }
    });
    if (!response.ok) throw await ShoplineError.fromResponse(response);
    return response.json() as Promise<T>;
  }
}

export class ShoplineError extends Error {
  static async fromResponse(response: Response) {
    const code = response.status === 401 || response.status === 403
      ? "invalid_credentials_or_permission"
      : response.status === 422
        ? "validation_failed"
        : response.status === 429
          ? "rate_limited"
          : "remote_unavailable";
    return new ShoplineError(code);
  }
}
```

Map `401/403` to `invalid_credentials_or_permission`, `422` to `validation_failed`, `429` to `rate_limited`, and `5xx` to `remote_unavailable`. Do not log the bearer token or full request body.

- [ ] **Step 4: Write the failing pre-approval delivery test**

```ts
it("rejects delivery before approval without calling SHOPLINE", async () => {
  await expect(publishApprovedProduct({ workspaceId: "ws_opak", draftId: "draft_1" }, deps))
    .rejects.toThrow("Only the active approved version can be delivered");
  expect(deps.connector.createProduct).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Implement idempotent approval-gated publishing**

The service loads the active version inside a workspace transaction, verifies status `approved`, checks zero unresolved blocking flags, projects and validates the listing, hashes the canonical payload, creates a unique publish job keyed by `workspaceId:versionId:shopline:create`, and only then calls the connector. On an ambiguous timeout it calls `getProductStatus` before retrying. Success stores remote ID and payload digest, transitions to `published`, and writes `listing.published`; failure transitions to `publish_failed` and writes a redacted error code.

- [ ] **Step 6: Run connector and worker delivery tests**

Run: `pnpm.cmd --filter @wukong/shopline test; pnpm.cmd --filter @wukong/worker test -- publish-product.test.ts`

Expected: connector contract tests pass, the negative approval test proves zero HTTP calls, and duplicate delivery returns the stored result.

- [ ] **Step 7: Commit direct delivery**

```powershell
git add packages/shopline apps/worker pnpm-lock.yaml
git commit -m "feat: deliver approved listings through SHOPLINE"
```

---

### Task 9: Invite-Only Authentication and Opak Workspace Seed

**Files:**
- Create: `apps/web/auth.ts`
- Create: `apps/web/app/api/auth/[...nextauth]/route.ts`
- Create: `apps/web/lib/session-context.ts`
- Create: `apps/web/middleware.ts`
- Create: `packages/db/src/seed-opak.ts`
- Create: `packages/db/src/seeds/opak-profile.ts`
- Test: `apps/web/lib/session-context.test.ts`
- Test: `packages/db/src/seed-opak.test.ts`

**Interfaces:**
- Consumes: Auth.js tables, memberships, workspace profiles, and audit writer.
- Produces: `auth`, `sessionContext()`, `requireWorkspaceRole()`, and the deterministic `ws_opak` seed.

- [ ] **Step 1: Write failing session and seed tests**

```ts
it("derives workspace and actor from membership rather than request input", async () => {
  const context = await sessionContext({ user: { email: "operator@opak.example" } }, repositories);
  expect(context).toEqual({ workspaceId: "ws_opak", actorId: "user_opak_operator", role: "operator" });
});
```

Seed test assertions must verify HKD, locales `["en", "zh-Hant"]`, SHOPLINE platform, premium non-exaggerated tone, and claim rules for ratings, awards, exclusivity, health effects, and superlatives.

- [ ] **Step 2: Run tests and verify auth context is absent**

Run: `pnpm.cmd --filter @wukong/web test -- session-context.test.ts; pnpm.cmd --filter @wukong/db test -- seed-opak.test.ts`

Expected: both fail because the modules do not exist.

- [ ] **Step 3: Configure Auth.js email sign-in**

```ts
import NextAuth from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { database } from "@wukong/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(database),
  providers: [Nodemailer({ server: process.env.AUTH_SMTP_URL!, from: process.env.AUTH_EMAIL_FROM! })],
  callbacks: {
    async signIn({ user }) {
      return database.memberships.hasActiveInvite(user.email ?? "");
    }
  },
  session: { strategy: "database" }
});
```

Every successful and rejected sign-in writes an auth audit event. Protected routes redirect unauthenticated sessions to `/signin`; API routes return `401`.

- [ ] **Step 4: Implement session-to-workspace authorization**

`sessionContext()` reads the authenticated user ID, loads the selected active membership server-side, and returns `{ workspaceId, actorId, role }`. `requireWorkspaceRole("reviewer")` uses the role order `viewer < operator < reviewer < admin`. Route handlers do not accept `workspaceId` or `actorId` from request JSON.

- [ ] **Step 5: Implement idempotent Opak seed data**

```ts
export const opakProfile: WorkspaceProfile = {
  name: "Opak Cellar",
  currency: "HKD",
  locales: ["en", "zh-Hant"],
  tone: "Knowledgeable, concise, premium, and non-exaggerated.",
  claimPolicy: ["ratings require evidence", "awards require evidence", "health claims are blocked", "superlatives require review"],
  requiredFields: ["sku", "producer", "productType", "country", "volumeMl", "abvPercent", "priceHkd"]
};
```

The seed upserts `ws_opak`, the profile, prompt version `1.0.0`, and an invited pilot operator email provided by `OPAK_OPERATOR_EMAIL`; it never seeds a password or SHOPLINE token.

- [ ] **Step 6: Run auth and seed tests**

Run: `pnpm.cmd --filter @wukong/web test -- session-context.test.ts; pnpm.cmd --filter @wukong/db test -- seed-opak.test.ts`

Expected: both test files pass and a second seed run changes zero rows.

- [ ] **Step 7: Commit access and pilot configuration**

```powershell
git add apps/web packages/db pnpm-lock.yaml
git commit -m "feat: add invite-only Opak pilot workspace"
```

---

### Task 10: Operator Dashboard, Intake, Review, and Delivery UI

**Files:**
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/(app)/layout.tsx`
- Create: `apps/web/app/(app)/dashboard/page.tsx`
- Create: `apps/web/app/(app)/listings/new/page.tsx`
- Create: `apps/web/app/(app)/listings/[id]/page.tsx`
- Create: `apps/web/components/listing-queue.tsx`
- Create: `apps/web/components/listing-intake-form.tsx`
- Create: `apps/web/components/evidence-panel.tsx`
- Create: `apps/web/components/listing-fields-form.tsx`
- Create: `apps/web/components/compliance-flags.tsx`
- Create: `apps/web/components/delivery-panel.tsx`
- Test: `apps/web/components/listing-fields-form.test.tsx`
- Test: `apps/web/components/delivery-panel.test.tsx`

**Interfaces:**
- Consumes: authenticated API routes and listing view models.
- Produces: the complete operator flow with Traditional Chinese primary labels and accessible English secondary labels.

- [ ] **Step 1: Write failing review and delivery component tests**

```tsx
it("shows provenance and disables approval for unresolved blocking flags", () => {
  render(<ListingFieldsForm model={reviewModelWithOpenHealthClaim} />);
  expect(screen.getByText("來源證據")).toBeVisible();
  expect(screen.getByRole("button", { name: "批准上架" })).toBeDisabled();
  expect(screen.getByText("必須先處理高風險聲稱")).toBeVisible();
});

it("labels CSV as fallback when SHOPLINE is disconnected", () => {
  render(<DeliveryPanel model={{ connection: "disconnected", status: "approved" }} />);
  expect(screen.getByRole("button", { name: "下載 SHOPLINE CSV" })).toBeEnabled();
  expect(screen.queryByText("已連接 SHOPLINE")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run component tests and verify the UI is absent**

Run: `pnpm.cmd --filter @wukong/web test -- listing-fields-form.test.tsx delivery-panel.test.tsx`

Expected: FAIL with missing component modules.

- [ ] **Step 3: Implement the application shell and queue**

Use a restrained light interface with navy text, warm amber accents, white surfaces, visible focus rings, 44-pixel minimum controls, and no decorative animation that delays work. The queue groups `需要資料`, `待審核`, `已批准`, `已上架`, and `失敗`, with counts and direct next-action links.

- [ ] **Step 4: Implement intake and upload progress**

`ListingIntakeForm` accepts up to ten JPEG/PNG/WebP files, one PDF, and notes. It presigns each file, uploads directly, finalizes assets, creates the draft, enqueues processing, and redirects to the listing page. Per-file errors remain beside the file; successful files are not re-uploaded during retry.

- [ ] **Step 5: Implement the two-pane review workspace**

Desktop uses a sticky evidence panel and grouped fields; narrow screens stack evidence above the active field. Each factual field displays confidence, source excerpt, and `需要資料` when null. Edits are submitted as a complete typed patch against the active version ID, preventing lost updates.

- [ ] **Step 6: Implement delivery status and actions**

The panel shows `未連接`, `連接錯誤`, or `已連接` based on verified server data. API publish is enabled only for reviewers/admins on an approved version with a verified connection. CSV uses the same approval gate. Remote product links appear only from stored successful results.

- [ ] **Step 7: Run UI tests, accessibility assertions, and typecheck**

Run: `pnpm.cmd --filter @wukong/web test; pnpm.cmd --filter @wukong/web typecheck`

Expected: component tests pass, there are no axe violations in the tested review state, and typecheck exits `0`.

- [ ] **Step 8: Commit the operator interface**

```powershell
git add apps/web pnpm-lock.yaml
git commit -m "feat: add bilingual listing review workspace"
```

---

### Task 11: Review, Approval, CSV, and Publish API Wiring

**Files:**
- Create: `apps/web/app/api/listings/[id]/route.ts`
- Create: `apps/web/app/api/listings/[id]/review/route.ts`
- Create: `apps/web/app/api/listings/[id]/approve/route.ts`
- Create: `apps/web/app/api/listings/[id]/deliver/route.ts`
- Create: `apps/web/lib/delivery-service.ts`
- Test: `apps/web/app/api/listings/[id]/approve/route.test.ts`
- Test: `apps/web/app/api/listings/[id]/deliver/route.test.ts`

**Interfaces:**
- Consumes: `sessionContext`, review policy, scoped repositories, SHOPLINE projection/connector, and queue functions.
- Produces: listing view JSON, immutable edits, approval, guarded CSV download, and queued direct publishing.

- [ ] **Step 1: Write the failing negative delivery route test**

```ts
it("returns 409 for CSV before approval", async () => {
  const response = await deliverListing(requestFor({ method: "csv" }), routeContext("draft_in_review"));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "approval_required", message: "批准後才可匯出或上架。" });
});
```

Add tests for stale version edits returning `409`, viewer approval returning `403`, unresolved blocking flags returning `422`, disconnected API delivery returning `409` with CSV fallback metadata, and an approved CSV returning `text/csv; charset=utf-8`.

- [ ] **Step 2: Run route tests and verify the integration is absent**

Run: `pnpm.cmd --filter @wukong/web test -- approve/route.test.ts deliver/route.test.ts`

Expected: FAIL because route handlers are absent.

- [ ] **Step 3: Implement immutable review edits**

The review route requires `operator`, validates `baseVersionId` equals the active version, parses `canonicalListingSchema`, stores a new sequence, records a field-level diff in `review_events`, moves approved/published drafts to `reopened`, and writes `listing.edited` with changed field names but not sensitive field values.

- [ ] **Step 4: Implement approval**

The approval route requires `reviewer`, reloads the active version and flags inside one workspace transaction, calls `approveListing`, stores reviewer/timestamp/version, transitions through the domain service, and writes `listing.approved`. It cannot accept a requested status from the client.

- [ ] **Step 5: Implement a single delivery service**

```ts
export async function deliverListing(input: DeliverInput, deps: DeliveryDeps): Promise<DeliveryResult> {
  const approved = await deps.listings.requireActiveApproved(input.draftId);
  const payload = projectToShopline(approved.content, await deps.imageUrls(approved.content.imageAssetIds));
  const validation = validateShoplineProduct(payload);
  if (!validation.ok) return { kind: "validation_error", issues: validation.issues };
  if (input.method === "csv") {
    await deps.audit.write({ action: "listing.csv_exported", entityId: input.draftId });
    return { kind: "csv", body: createShoplineCsv([payload]), specVersion: SHOPLINE_CSV_SPEC_VERSION };
  }
  const jobId = await deps.publisher.enqueue({ workspaceId: input.workspaceId, draftId: input.draftId });
  return { kind: "queued", jobId };
}
```

Define the boundary types immediately above the service:

```ts
export type DeliverInput = {
  workspaceId: string;
  draftId: string;
  method: "csv" | "shopline_api";
};

export type DeliveryResult =
  | { kind: "csv"; body: string; specVersion: string }
  | { kind: "queued"; jobId: string }
  | { kind: "validation_error"; issues: string[] };

export type DeliveryDeps = {
  listings: { requireActiveApproved(draftId: string): Promise<{ content: CanonicalListing }> };
  imageUrls(assetIds: string[]): Promise<string[]>;
  audit: { write(event: { action: string; entityId: string }): Promise<void> };
  publisher: { enqueue(input: { workspaceId: string; draftId: string }): Promise<string> };
};
```

- [ ] **Step 6: Run route and full package tests**

Run: `pnpm.cmd --filter @wukong/web test; pnpm.cmd test`

Expected: negative and positive route tests pass, and all workspace package tests remain green.

- [ ] **Step 7: Commit full application wiring**

```powershell
git add apps/web apps/worker packages pnpm-lock.yaml
git commit -m "feat: wire review approval and SHOPLINE delivery"
```

---

### Task 12: Pilot Fixtures, AI Evaluation, End-to-End Verification, and Runbooks

**Files:**
- Create: `fixtures/opak/supplier-sheet.txt`
- Create: `fixtures/opak/bottle-label.svg`
- Create: `fixtures/opak/expected-listing.json`
- Create: `packages/ai/src/eval.ts`
- Test: `packages/ai/src/eval.test.ts`
- Create: `packages/db/src/cli/audit-verify.ts`
- Create: `playwright.config.ts`
- Create: `tests/e2e/listing-pilot.spec.ts`
- Create: `docs/runbooks/local-development.md`
- Create: `docs/runbooks/shopline-pilot-onboarding.md`
- Create: `docs/runbooks/production-readiness.md`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the complete system.
- Produces: repeatable extraction metrics, a browser-level acceptance test, CI gates, and controlled Opak onboarding instructions.

- [ ] **Step 1: Add synthetic but representative Opak fixtures**

`supplier-sheet.txt` contains explicit producer, SKU, country, region, vintage, grape, 750 ml volume, 12.5% ABV, HK$288 price, and no critic score or stock. `bottle-label.svg` repeats only producer, vintage, region, volume, and ABV. `expected-listing.json` requires those facts, bilingual titles, and `null` stock with zero critic scores.

- [ ] **Step 2: Write the failing evaluation test**

```ts
it("measures protected-field hallucinations separately from recall", () => {
  const report = evaluateExtraction(expectedFixture, actualFixture);
  expect(report.requiredFactRecall).toBeGreaterThanOrEqual(0.9);
  expect(report.unsupportedCriticalFacts).toEqual([]);
});
```

- [ ] **Step 3: Implement deterministic evaluation metrics**

`evaluateExtraction` compares only facts present in the expected fixture for recall, records absent protected fields populated by the agent as unsupported critical facts, measures exact/normalized numeric agreement, and reports latency and token usage separately. The command exits non-zero below 90% recall or above zero unsupported critical facts.

- [ ] **Step 4: Write the end-to-end pilot test**

```ts
test("Opak operator creates, reviews, approves, and delivers a listing", async ({ page }) => {
  await signInAsPilotOperator(page);
  await page.goto("/listings/new");
  await page.getByLabel("產品圖片或文件").setInputFiles([
    { name: "bottle-label.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") },
    { name: "supplier-sheet.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF", "utf8") }
  ]);
  await page.getByLabel("補充資料").fill("Demo Estate Riesling 2024, Germany, Mosel, Riesling, 750ml, 12.5% ABV, SKU OPAK-DEMO-001, HK$288");
  await page.getByRole("button", { name: "建立上架草稿" }).click();
  await expect(page.getByText("待審核")).toBeVisible();
  await expect(page.getByText("來源證據")).toBeVisible();
  await expect(page.getByText("庫存：需要資料")).toBeVisible();
  await expect(page.getByRole("button", { name: "下載 SHOPLINE CSV" })).toBeDisabled();
  await page.getByRole("button", { name: "批准上架" }).click();
  await page.getByRole("button", { name: "下載 SHOPLINE CSV" }).click();
  await expect(page.getByText("CSV 已建立")).toBeVisible();
  await page.getByRole("button", { name: "發佈至 SHOPLINE 測試連接" }).click();
  await expect(page.getByText("remote_123")).toBeVisible();
});
```

Add a separate browser test that calls the delivery route before approval and asserts `409`, proving the server gate independently of disabled buttons.

- [ ] **Step 5: Add CI with real service dependencies**

The workflow runs on Node 24 with PostgreSQL and Redis service containers, installs with `pnpm install --frozen-lockfile`, runs migrations, lint, typecheck, unit tests, integration tests, build, starts the test server with fake AI and mock SHOPLINE adapters, then runs Playwright. Upload Playwright artifacts only on failure.

- [ ] **Step 6: Write operational runbooks**

The local runbook gives exact Docker, environment, migration, seed, worker, web, and test commands. The SHOPLINE onboarding runbook separates Developer Center installation from merchant OpenAPI enablement, verifies permissions without a write, requires explicit approval for a hidden test product, records the API version, and documents CSV fallback. The production checklist covers Neon pooled/direct URLs, Redis, object storage, SMTP, encryption key, AI key, Sentry endpoint, backups, retention, and secret rotation ownership without creating any resource.

`packages/db/src/cli/audit-verify.ts` loads a workspace-scoped audit sequence, verifies required action names in chronological order, runs the foreign-workspace probe, prints the missing-action count and accessible-foreign-record count, and exits non-zero when either count is non-zero. Add it as the `audit:verify` package script.

- [ ] **Step 7: Run the complete verification suite**

Run: `pnpm.cmd lint; pnpm.cmd typecheck; pnpm.cmd test; pnpm.cmd test:integration; pnpm.cmd build; pnpm.cmd test:e2e`

Expected: every command exits `0`; evaluation reports at least `0.90` required-fact recall and `0` unsupported critical facts; Playwright passes the happy path and pre-approval negative path.

- [ ] **Step 8: Inspect audit and isolation evidence**

Run: `pnpm.cmd --filter @wukong/db audit:verify --workspace ws_opak --draft fixture_draft_1`

Expected: output includes creation, two AI runs, review edit, approval, CSV export, publish attempt, and publish success with no missing sequence; the cross-workspace verifier reports `0 accessible foreign records`.

- [ ] **Step 9: Commit pilot verification and runbooks**

```powershell
git add fixtures packages/ai tests playwright.config.ts docs/runbooks .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "test: verify the Opak SHOPLINE pilot workflow"
```

---

## Completion Audit

Before claiming the MVP complete, inspect current evidence for every item below:

- `pnpm.cmd lint`, `typecheck`, `test`, `test:integration`, `build`, and `test:e2e` all pass from a clean checkout.
- The browser test proves a user can complete intake, generation, evidence review, edit, approval, CSV, and mock SHOPLINE delivery.
- A direct HTTP negative test proves both CSV and API delivery reject unapproved versions.
- PostgreSQL integration tests prove cross-workspace reads, writes, assets, AI logs, exports, and connector metadata are denied.
- The evaluation report proves at least 90% recall on present required facts and zero unsupported protected facts.
- Audit verification proves every AI call, state transition, review edit, compliance resolution, approval, and delivery attempt is present.
- The current official SHOPLINE contract fixture matches `https://open.shopline.io/v1/products` and recorded request fields.
- The OpenAI adapter contract test proves the Responses API, Structured Outputs, configured model, usage capture, and refusal/error handling.
- The Opak profile is data-driven and a second workspace can be seeded without changing source code.
- No real SHOPLINE credential, OpenAI key, customer document, or production resource appears in Git history.

## Reference Sources

- SHOPLINE OpenAPI getting started: `https://open-api.docs.shoplineapp.com/docs/getting-started`
- SHOPLINE current OpenAPI registry: `https://dash.readme.com/api/v1/api-registry/238i42mrd9l9pu`
- OpenAI latest model guidance: `https://developers.openai.com/api/docs/guides/latest-model.md`
- OpenAI Structured Outputs: `https://developers.openai.com/api/docs/guides/structured-outputs.md`
- Approved design: `docs/superpowers/specs/2026-07-12-shopline-ai-listing-mvp-design.md`

