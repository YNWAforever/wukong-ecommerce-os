# Product Shot Review UI (Plan B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace configure a brand background color, and let a reviewer see a listing's AI-generated product-shot cutout (when one exists) composited over white or that brand color, with a toggle between the two — preview only, nothing is persisted by the toggle itself.

**Architecture:** A new, previously-nonexistent write path for `workspaces.profile` (workspace settings), surfaced through one new admin-only API route. The review page's existing GET route gains a `productShot` field (a short-lived signed preview URL for the cutout, if one exists, plus the workspace's brand color) — resolved by filtering the listing's existing assets for the `product_shot_cutout` role Plan A already tags them with. A new client component composites the preview over the chosen background using plain CSS (no canvas, no server round trip) and holds the toggle state locally in the existing review-page client component. Choosing a background here does not persist anything — persistence is Plan B2, a separate follow-on plan.

**Tech Stack:** TypeScript, Drizzle (no migration — `profile` is jsonb), Next.js route handlers, React (client component, CSS compositing), Vitest.

---

## Relationship to the design spec and prior plans

This implements part of `docs/superpowers/specs/2026-08-21-ai-product-shot-generation-design.md`. Plan A (merged, PR #39) built the inert-in-production pipeline step that, once a real AI provider exists, tags a generated cutout as a `source_assets` row: `kind: "image/png"`, `metadata: { role: "product_shot_cutout", listingId }`, attached to the listing. **No real cutout will exist in production until a future "Plan C" (the real `ProductShotProvider`) is built** — this plan's review-UI pieces must therefore degrade gracefully to "nothing to show" for every listing today, not error.

This plan does **not** include: persisting the chosen background at approval time, the new `promoteAndApprove` repository method, or server-side image flattening — all Plan B2, a separate follow-on plan, because it's the most architecturally distinct piece (a new DB method with real transactional precondition logic) and depends on this plan's toggle UI existing first.

## Key research findings this plan depends on

- `packages/db/src/repositories/workspaces.ts` has exactly one method, `requireProfile()` (read-only) — no write path exists anywhere in production code today.
- `workspaceProfileSchema` (`packages/core/src/listing-schema.ts:48-55`) has no color field; `profile` is stored as `jsonb` with no migration needed to add one.
- `SessionContext.role` is one of `"viewer" | "operator" | "reviewer" | "admin" | "owner"` (`apps/web/lib/session-context-port.ts`), with an ordinal helper `requireWorkspaceRole(required, context.role)` (`apps/web/lib/session-context.ts`) already built for exactly this kind of check, currently only ever called with `"operator"` as the threshold anywhere in the codebase — this plan is the first caller to use `"admin"`.
- `apps/web/app/api/listings/[id]/route.ts`'s GET handler has no asset-resolving dependency at all today — `ListingViewResponse` carries no image data.
- `packages/db/src/repositories/source-assets.ts`'s `listForListing(listingId)` returns every asset for a listing with no role filter — the cutout must be found by filtering in application code on `metadata.role === "product_shot_cutout"`.
- `AssetStore.createReadUrl(workspaceId, key, options?)` (`packages/assets/src/asset-store.ts`) already exists and is exactly what's needed for a short-lived preview URL — distinct from the delivery-time `resolveListingImageUrls` helper, which is scoped to a listing's canonical `imageAssetIds` and not a good fit for a pre-approval preview.

---

### Task 1: Workspace brand-background color setting

**Files:**

- Modify: `packages/core/src/listing-schema.ts`
- Modify: `packages/db/src/repositories/workspaces.ts`
- Test: `packages/db/src/repositories/workspaces.integration.test.ts` (new file)
- Create: `apps/web/app/api/workspace/settings/route.ts`
- Test: `apps/web/app/api/workspace/settings/route.test.ts`

- [ ] **Step 1: Add the schema field**

In `packages/core/src/listing-schema.ts`, find `workspaceProfileSchema` and add one field:

```ts
export const workspaceProfileSchema = z.object({
  name: z.string().min(1),
  currency: z.literal("HKD"),
  locales: z.tuple([z.literal("en"), z.literal("zh-Hant")]),
  tone: z.string().min(1),
  claimPolicy: z.array(z.string().min(1)),
  requiredFields: z.array(z.string().min(1)),
  brandBackgroundColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable(),
});
```

- [ ] **Step 2: Run the existing core test suite to see the new required field surface**

Run: `pnpm --filter @wukong/core test -- listing-schema.test.ts`
Expected: FAIL — existing fixtures that build a `WorkspaceProfile` without `brandBackgroundColor` now fail to parse.

- [ ] **Step 3: Fix existing fixtures**

Search the whole repo for object literals matching the `WorkspaceProfile` shape (anywhere a test or seed builds `{ name, currency: "HKD", locales, tone, claimPolicy, requiredFields }`) and add `brandBackgroundColor: null` to each — this includes at minimum `packages/core/src/listing-schema.test.ts`, `apps/worker/src/pipeline-test-support.ts` (the `profile` constant), and `packages/db/src/seed-opak.ts`. Grep first to find every site:

Run: `grep -rln "requiredFields:" packages apps --include="*.ts"`

Add `brandBackgroundColor: null` to every literal the grep finds that also has `claimPolicy`/`requiredFields` alongside it (skip any unrelated match).

- [ ] **Step 4: Run the full test suite to confirm the fixture fix is complete**

Run: `pnpm test`
Expected: PASS — no remaining `WorkspaceProfile` parse failures anywhere.

- [ ] **Step 5: Commit the schema change**

```bash
git add packages/core/src/listing-schema.ts packages/core/src/listing-schema.test.ts apps/worker/src/pipeline-test-support.ts packages/db/src/seed-opak.ts
git commit -m "feat(core): add brandBackgroundColor to WorkspaceProfile"
```

(Adjust the file list above to whatever the grep in Step 3 actually found.)

- [ ] **Step 6: Write the failing integration test for the new repository write method**

This mirrors `packages/db/src/repositories/source-assets.integration.test.ts` exactly (confirmed real file, read in full): `createDatabase`/`forWorkspace`/`WorkspaceRepositories` are all named exports of `../index.js`; `forWorkspace(database, workspaceId, callback)` is a standalone wrapper, not a method called directly on most call sites. A workspace row is created lazily by `listings.create` in that file's fixtures — `workspaces.requireProfile()` requires an existing row, so this test must insert one first via the admin client, matching the `TRUNCATE`/`admin.unsafe` pattern already used for setup in that same file.

Create `packages/db/src/repositories/workspaces.integration.test.ts`:

```ts
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

describe("WorkspaceRepository.updateProfile", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
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
    await admin.unsafe("TRUNCATE TABLE workspaces CASCADE");
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  const baseProfile = {
    name: "Test Workspace",
    currency: "HKD" as const,
    locales: ["en", "zh-Hant"] as const,
    tone: "clear",
    claimPolicy: [] as string[],
    requiredFields: [] as string[],
  };

  it("persists a new brand background color and requireProfile reflects it", async () => {
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ('ws_brand_color', 'Test Workspace', '{}'::jsonb)`,
    );
    await forWorkspace(database, "ws_brand_color", async (repos) => {
      await repos.workspaces.updateProfile({
        ...baseProfile,
        brandBackgroundColor: "#1a2b3c",
      });
      const profile = await repos.workspaces.requireProfile();
      expect(profile.brandBackgroundColor).toBe("#1a2b3c");
    });
  });

  it("rejects a malformed color", async () => {
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ('ws_bad_color', 'Test Workspace', '{}'::jsonb)`,
    );
    await forWorkspace(database, "ws_bad_color", async (repos) => {
      await expect(
        repos.workspaces.updateProfile({
          ...baseProfile,
          brandBackgroundColor: "not-a-color",
        } as never),
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @wukong/db test:integration -- workspaces.integration.test.ts`
Expected: FAIL — `repositories.workspaces.updateProfile is not a function`.

- [ ] **Step 8: Implement `updateProfile`**

In `packages/db/src/repositories/workspaces.ts`:

```ts
import { eq } from "drizzle-orm";
import { workspaceProfileSchema, type WorkspaceProfile } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { workspaces } from "../schema.js";

export type WorkspaceRepository = {
  requireProfile(): Promise<WorkspaceProfile>;
  updateProfile(profile: WorkspaceProfile): Promise<void>;
};

export function createWorkspaceRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceRepository {
  return {
    async requireProfile() {
      scope.assertOpen();
      const [workspace] = await transaction
        .select({ profile: workspaces.profile })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace) throw new Error("workspace not found");
      return workspaceProfileSchema.parse(workspace.profile);
    },
    async updateProfile(profile) {
      scope.assertOpen();
      const parsed = workspaceProfileSchema.parse(profile);
      const updated = await transaction
        .update(workspaces)
        .set({ profile: parsed })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      if (updated.length !== 1) throw new Error("workspace not found");
    },
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @wukong/db test:integration -- workspaces.integration.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/repositories/workspaces.ts packages/db/src/repositories/workspaces.integration.test.ts
git commit -m "feat(db): add WorkspaceRepository.updateProfile"
```

- [ ] **Step 11: Write the failing test for the settings API route**

This mirrors the exact real shape of `apps/web/app/api/listings/[id]/approve/route.ts` (confirmed by reading it in full): a `create<Name>Handler(deps)` factory returning `async function(request) { return withRouteErrors(async () => {...}) }`, `requireSessionContext(deps.sessionContext)` (calling the port, not the deps field directly), and `jsonResponse(status, body)` for responses — not `Response.json`. Create `apps/web/app/api/workspace/settings/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createSettingsHandler } from "./route.js";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseProfile = {
  name: "Opak Cellar",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"] as const,
  tone: "clear",
  claimPolicy: [] as string[],
  requiredFields: [] as string[],
  brandBackgroundColor: null as string | null,
};

describe("POST /api/workspace/settings", () => {
  it("rejects a role below admin", async () => {
    const updateProfile = vi.fn();
    const requireProfile = vi.fn(async () => baseProfile);
    const handler = createSettingsHandler({
      sessionContext: async () => ({
        workspaceId: "ws_opak",
        actorId: "user_1",
        role: "reviewer" as const,
      }),
      getDatabase: () =>
        ({
          forWorkspace: async (_id: string, work: any) =>
            work({ workspaces: { requireProfile, updateProfile } }),
        }) as any,
    });
    const response = await handler(
      makeRequest({ brandBackgroundColor: "#112233" }),
    );
    expect(response.status).toBe(403);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("updates the brand background color for admin and above", async () => {
    const updateProfile = vi.fn(async () => {});
    const requireProfile = vi.fn(async () => baseProfile);
    const handler = createSettingsHandler({
      sessionContext: async () => ({
        workspaceId: "ws_opak",
        actorId: "user_1",
        role: "admin" as const,
      }),
      getDatabase: () =>
        ({
          forWorkspace: async (_id: string, work: any) =>
            work({ workspaces: { requireProfile, updateProfile } }),
        }) as any,
    });
    const response = await handler(
      makeRequest({ brandBackgroundColor: "#112233" }),
    );
    expect(response.status).toBe(200);
    expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ brandBackgroundColor: "#112233" }),
    );
  });

  it("rejects a malformed color with 400", async () => {
    const handler = createSettingsHandler({
      sessionContext: async () => ({
        workspaceId: "ws_opak",
        actorId: "user_1",
        role: "owner" as const,
      }),
      getDatabase: () => ({ forWorkspace: async () => {} }) as any,
    });
    const response = await handler(
      makeRequest({ brandBackgroundColor: "red" }),
    );
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 12: Run test to verify it fails**

Run: `pnpm --filter @wukong/web test -- workspace/settings/route.test.ts`
Expected: FAIL — `route.js` does not exist yet.

- [ ] **Step 13: Implement the route**

Create `apps/web/app/api/workspace/settings/route.ts`. This is a 4-directory-deep route (`app/api/workspace/settings/route.ts`), the same depth as `apps/web/app/api/assets/presign/route.ts` — its `../../../../lib/...` import paths are the confirmed-correct depth to copy:

```ts
import type { SessionContextPort } from "../../../../lib/session-context-port";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import { z } from "zod";

const bodySchema = z
  .object({
    brandBackgroundColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .nullable(),
  })
  .strict();

type SettingsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createSettingsHandler(deps: SettingsRouteDeps) {
  return async function settingsHandler(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Admin access is required.",
        );
      }
      const parsed = bodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Invalid settings payload.");
      }
      await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const current = await repositories.workspaces.requireProfile();
          await repositories.workspaces.updateProfile({
            ...current,
            brandBackgroundColor: parsed.data.brandBackgroundColor,
          });
        });
      return jsonResponse(200, { ok: true });
    });
  };
}

export const POST = createSettingsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

(Move the `zod` import above the relative imports if this codebase's import-ordering convention — visible in `apps/web/app/api/listings/[id]/approve/route.ts`, which puts `@wukong/core`/`zod` before relative imports — requires it; match that file's exact ordering.)

- [ ] **Step 14: Run test to verify it passes**

Run: `pnpm --filter @wukong/web test -- workspace/settings/route.test.ts`
Expected: PASS.

- [ ] **Step 15: Full package test run and typecheck**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 16: Commit**

```bash
git add apps/web/app/api/workspace/settings/route.ts apps/web/app/api/workspace/settings/route.test.ts
git commit -m "feat(web): add admin-only workspace settings route for brand background color"
```

---

### Task 2: Resolve the product-shot cutout and brand color into the review GET response

**Files:**

- Modify: `apps/web/app/api/listings/[id]/route.ts`
- Test: `apps/web/app/api/listings/[id]/route.test.ts`

The cutout must be found by filtering `sourceAssets.listForListing(id)` for `metadata.role === "product_shot_cutout"` — there is no dedicated lookup method. When none exists (every listing today, since Plan A is unwired in production), the response field must be `null`, not an error.

- [ ] **Step 1: Write the failing test for the "no cutout exists" case**

Read `apps/web/app/api/listings/[id]/route.test.ts` in full first to match its exact fake-repository/deps style. Add a test asserting that when `sourceAssets.listForListing` returns assets with no `product_shot_cutout`-tagged entry (or an empty list), the response's `productShot` field is `null`, and no `assetStore.createReadUrl` call is made:

```ts
it("returns null productShot when no cutout asset exists for the listing", async () => {
  const createReadUrl = vi.fn();
  const response = await handler(
    makeRequest(),
    withDeps({
      sourceAssets: {
        listForListing: async () => [
          {
            id: "asset_1",
            kind: "image/jpeg",
            metadata: {},
            storageKey: "ws/x/sources/1/photo.jpg",
          },
        ],
      },
      assetStore: { createReadUrl },
    }),
  );
  const body = await response.json();
  expect(body.productShot).toBeNull();
  expect(createReadUrl).not.toHaveBeenCalled();
});
```

Adapt the exact helper names (`makeRequest`, `withDeps`, `handler`) to whatever this file's existing tests actually use — read the file first and match its real fixture-building style, don't invent new helper names that don't match the file's established pattern.

- [ ] **Step 2: Write the failing test for the "cutout exists" case**

```ts
it("resolves a preview URL and the workspace brand color when a cutout exists", async () => {
  const createReadUrl = vi.fn(async () => ({
    url: "https://assets.example/preview.png",
    expiresAt: new Date("2026-01-01T00:05:00.000Z"),
  }));
  const response = await handler(
    makeRequest(),
    withDeps({
      sourceAssets: {
        listForListing: async () => [
          {
            id: "asset_shot_1",
            kind: "image/png",
            metadata: { role: "product_shot_cutout", listingId: "draft_1" },
            storageKey: "ws/ws_opak/sources/x/product-shot-cutout.png",
          },
        ],
      },
      assetStore: { createReadUrl },
      workspaces: {
        requireProfile: async () => ({
          name: "Opak Cellar",
          currency: "HKD",
          locales: ["en", "zh-Hant"],
          tone: "clear",
          claimPolicy: [],
          requiredFields: [],
          brandBackgroundColor: "#112233",
        }),
      },
    }),
  );
  const body = await response.json();
  expect(body.productShot).toEqual({
    previewUrl: "https://assets.example/preview.png",
    brandBackgroundColor: "#112233",
  });
  expect(createReadUrl).toHaveBeenCalledWith(
    "ws_opak",
    "ws/ws_opak/sources/x/product-shot-cutout.png",
    expect.objectContaining({ expiresInMs: expect.any(Number) }),
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @wukong/web test -- listings/\[id\]/route.test.ts`
Expected: FAIL — `productShot` is not yet part of the response shape.

- [ ] **Step 4: Add the field to `ListingViewResponse` and resolve it in the handler**

Read `apps/web/app/api/listings/[id]/route.ts` in full first. Add to the `ListingViewResponse` type (in `apps/web/components/listing-review-client.tsx`, where it's currently defined, per the research — confirm its actual defining file before editing, since the type may be re-exported from the route file instead):

```ts
productShot: { previewUrl: string; brandBackgroundColor: string | null } | null;
```

In the route handler, after resolving `repositories` inside the existing `forWorkspace` callback, add:

```ts
const listingAssets = await repositories.sourceAssets.listForListing(id);
const cutout = listingAssets.find(
  (asset) =>
    asset.kind === "image/png" &&
    (asset.metadata as Record<string, unknown> | null)?.role ===
      "product_shot_cutout",
);
let productShot: {
  previewUrl: string;
  brandBackgroundColor: string | null;
} | null = null;
if (cutout) {
  const profile = await repositories.workspaces.requireProfile();
  const read = await deps.assetStore.createReadUrl(
    context.workspaceId,
    cutout.storageKey,
    { expiresInMs: 5 * 60 * 1000 },
  );
  productShot = {
    previewUrl: read.url,
    brandBackgroundColor: profile.brandBackgroundColor,
  };
}
```

Add `getAssetStore: () => Pick<AssetStore, "createReadUrl">` to this route's `ListingRouteDeps` type (import the `AssetStore` type from `@wukong/assets`). At the bottom of the file, add `getAssetStore` (imported from `../../../../lib/intake-runtime`, the same module `apps/web/app/api/assets/presign/route.ts` already imports it from — confirmed real export, `export function getAssetStore(): AssetStore`) to the existing concrete deps binding, alongside whatever this route already binds there. Include `productShot` in the final response payload alongside the existing fields, using this file's existing response-building convention (confirm whether it already uses `jsonResponse(200, ...)` like the approve/settings routes, or builds a `Response` directly, and match it — don't introduce a second convention).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @wukong/web test -- listings/\[id\]/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Full package test run and typecheck**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/listings/\[id\]/route.ts apps/web/app/api/listings/\[id\]/route.test.ts apps/web/components/listing-review-client.tsx
git commit -m "feat(web): resolve a listing's product-shot cutout and brand color in the review GET route"
```

---

### Task 3: Review UI panel with background toggle

**Files:**

- Create: `apps/web/components/product-shot-panel.tsx`
- Modify: `apps/web/components/listing-review-client.tsx`
- Test: `apps/web/components/product-shot-panel.test.ts`

Following this codebase's established pattern (`dashboard-listings-client.test.ts` tests the pure `mapDashboardItems` function, not full component rendering), keep the panel's actual logic in one small, pure, independently-testable function and the component itself thin.

- [ ] **Step 1: Write the failing test for the pure background-style function**

Create `apps/web/components/product-shot-panel.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { backgroundStyleFor } from "./product-shot-panel.js";

describe("backgroundStyleFor", () => {
  it("returns white for the white choice regardless of brand color", () => {
    expect(backgroundStyleFor("white", "#112233")).toEqual({
      backgroundColor: "#ffffff",
    });
  });

  it("returns the brand color for the brand choice", () => {
    expect(backgroundStyleFor("brand", "#112233")).toEqual({
      backgroundColor: "#112233",
    });
  });

  it("falls back to white for the brand choice when no brand color is configured", () => {
    expect(backgroundStyleFor("brand", null)).toEqual({
      backgroundColor: "#ffffff",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wukong/web test -- product-shot-panel.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component and its pure function**

Create `apps/web/components/product-shot-panel.tsx`:

```tsx
"use client";

import { useState } from "react";

export type BackgroundChoice = "white" | "brand";

export function backgroundStyleFor(
  choice: BackgroundChoice,
  brandBackgroundColor: string | null,
): { backgroundColor: string } {
  if (choice === "brand" && brandBackgroundColor) {
    return { backgroundColor: brandBackgroundColor };
  }
  return { backgroundColor: "#ffffff" };
}

export type ProductShotPanelProps = {
  previewUrl: string;
  brandBackgroundColor: string | null;
  onChoiceChange?: (choice: BackgroundChoice) => void;
};

export function ProductShotPanel({
  previewUrl,
  brandBackgroundColor,
  onChoiceChange,
}: ProductShotPanelProps) {
  const [choice, setChoice] = useState<BackgroundChoice>("white");

  const select = (next: BackgroundChoice) => {
    setChoice(next);
    onChoiceChange?.(next);
  };

  return (
    <section
      className="product-shot-panel"
      aria-labelledby="product-shot-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            商品照 <span>PRODUCT SHOT</span>
          </p>
          <h2 id="product-shot-heading">背景預覽</h2>
        </div>
      </div>
      <div
        className="product-shot-preview"
        style={backgroundStyleFor(choice, brandBackgroundColor)}
      >
        <img src={previewUrl} alt="Product shot preview" />
      </div>
      <div className="product-shot-toggle" role="group" aria-label="背景選擇">
        <button
          type="button"
          className={
            choice === "white" ? "secondary-button active" : "secondary-button"
          }
          aria-pressed={choice === "white"}
          onClick={() => select("white")}
        >
          白底 White
        </button>
        <button
          type="button"
          className={
            choice === "brand" ? "secondary-button active" : "secondary-button"
          }
          aria-pressed={choice === "brand"}
          disabled={!brandBackgroundColor}
          title={brandBackgroundColor ? undefined : "尚未設定品牌背景色"}
          onClick={() => select("brand")}
        >
          品牌背景 Brand
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @wukong/web test -- product-shot-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the panel into the review page**

Read `apps/web/components/listing-review-client.tsx` in full immediately before editing (672 lines — do not skim; the exact insertion point and the exact shape of `snapshot`/`mapped` state must be read fresh, not assumed from a summary). Add a conditional render of `<ProductShotPanel />` as a sibling to `EvidencePanel` inside `.review-layout` (or the first child of `.review-content`, above `ListingFieldsForm` — pick whichever the actual current layout structure makes more natural once you're looking at the real file), passing `snapshot.productShot.previewUrl` and `snapshot.productShot.brandBackgroundColor` when `snapshot.productShot` is not null, and rendering nothing when it is null. Track the selected `BackgroundChoice` in this component's own state (a new `useState<BackgroundChoice>("white")`, unused by anything else in this plan — Plan B2 will read it when persisting at approval time).

- [ ] **Step 6: Full package test run, typecheck, and manual verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

Manually verify no regression: since no listing in any environment has a real cutout yet (Plan A is unwired in production), confirm the review page renders exactly as it did before this plan for every existing listing — the panel must not appear, and nothing else on the page should change. Check this by loading an existing `in_review` listing in a local dev run and confirming the page looks identical to before.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/product-shot-panel.tsx apps/web/components/product-shot-panel.test.ts apps/web/components/listing-review-client.tsx
git commit -m "feat(web): add a review-page product shot panel with a white/brand background toggle"
```

---

## Verification

After all three tasks:

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets build
pnpm test
pnpm lint
```

Expected: all green. No production behavior change for any listing without a product-shot cutout (every listing today) — the new panel is conditionally absent, and the new settings route is additive (nothing calls it automatically). The one small user-facing addition that's live immediately: an admin/owner can now set a brand background color via the new API route, even though nothing consumes it yet for any real listing until Plan C (the real AI provider) ships.
