# Product Shot Approval Flattening (Plan B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a reviewer approves a listing with a chosen product-shot background (white or brand), flatten that background into the cutout server-side, store it as a real asset, and add it to the approved version's `imageAssetIds` — atomically with the approval itself.

**Architecture:** Two new small, isolated capabilities (`AssetStore.readObject` for fetching an asset's raw bytes server-side, and a `flattenProductShot` compositing function using `sharp`) plus one new DB repository method (`promoteAndApprove`, needed because the existing `approve()` requires its target version to already be the listing's active version — which a freshly-appended version never is). `apps/web/lib/listing-approval.ts`'s `approveOne` is restructured to branch: no `background` choice or no cutout asset found → today's exact unchanged path (`approve()` on the existing active version); a background chosen and a cutout exists → fetch the cutout, flatten it, append a new version carrying the flattened asset plus the original version's evidence/flags, and promote+approve that new version via `promoteAndApprove`.

**Tech Stack:** TypeScript, `sharp` (new dependency of `packages/assets` — this runs in `apps/web` on Vercel/Node.js, not the Cloudflare Worker, so `sharp` is usable here unlike in `apps/worker`), Drizzle (no migration), Vitest.

---

## Relationship to prior plans

This is the final piece of `docs/superpowers/specs/2026-08-21-ai-product-shot-generation-design.md`. Plan A (PR #39, merged) built the inert-in-production pipeline step. Plan B1 (PR #40) added the workspace brand-color setting, resolved a cutout preview into the review GET response, and added the `ProductShotPanel` toggle UI — preview only, tracking the chosen `BackgroundChoice` in local component state that nothing yet reads. This plan is what finally reads that choice and persists it.

**No real cutout exists for any listing today** (Plan A's pipeline step is deliberately unwired in production). Every path this plan adds must therefore be a no-op for every real listing's approval flow right now — approving a listing with no cutout asset must behave exactly as it does today, byte-for-byte, regardless of what `background` value is sent.

## Key facts this plan depends on (from prior research)

- `repositories.listings.approve(id, versionId, ...)` (`packages/db/src/repositories/listings.ts:444-494`) requires `listing.activeVersionId === versionId` as a precondition — it can only approve the version that is _already_ active. It cannot promote a version that was just appended and never made active. `editReview` (`listings.ts:496-563`) is the only existing precedent for "append a version and make it active," but its status transitions are edit-specific, not approval.
- `appendVersion(id, content, context, audit, pipelineIdempotencyKey?)` (`listings.ts:674-751`) creates a new version with the given full `content`. It does **not** touch `activeVersionId` — callers do that themselves.
- `getReviewSnapshot(id)` (`listings.ts:399-441`, type `ReviewSnapshot` at `listings.ts:39-48`) returns `{ listing, activeVersion: { id, sequence, content } | null, evidence, flags }` in one read — everything needed to build a new version's full context.
- `replaceEvidence(versionId, evidence)` / `replaceFlags(versionId, flags)` already exist and are how a version's evidence/flags get set.
- `approveOne` (`apps/web/lib/listing-approval.ts`) currently: `requireForPublish(id)` → validate `target === "shopline" && activeVersion` → `domainApprove(activeVersion.id, flags, auditContext, audit)` (from `@wukong/core`, checks blocking flags + writes a `listing.approved` audit event) → `repositories.listings.approve(id, approved.versionId, auditContext, audit)`.
- `apps/web/app/api/listings/[id]/approve/route.ts`'s `bodySchema` is currently `z.object({}).strip()` — the POST body is required to be empty.
- The cutout asset (when one exists) is found via `repositories.sourceAssets.listForListing(id)`, filtered for `kind === "image/png" && metadata.role === "product_shot_cutout"` — the exact convention established in Plan A/B1.
- `AssetStore` (`packages/assets/src/asset-store.ts`) currently has `createUpload`, `createReadUrl`, `head`, `exists`, `writeObject` — no method to read an object's raw bytes server-side. `packages/assets` has no `sharp` dependency yet.
- `MemoryAssetStore`'s internal `#objects` map currently stores only `AssetObjectMetadata`, never real bytes — `writeObject` discards the body after computing its size. This plan widens that internal map so a written body can actually be read back in tests.

---

### Task 1: `AssetStore.readObject` — server-side asset reads

**Files:**

- Modify: `packages/assets/src/asset-store.ts`
- Modify: `packages/assets/src/s3-asset-store.ts`
- Test: `packages/assets/src/asset-store.test.ts`
- Test: `packages/assets/src/s3-asset-store.test.ts`

Symmetric counterpart to `writeObject` (added in Plan A): lets server code fetch an asset's raw bytes, needed to read a stored cutout before compositing it.

- [ ] **Step 1: Write the failing test for `MemoryAssetStore.readObject`**

Read `packages/assets/src/asset-store.test.ts` first to match its exact style. Add:

```ts
describe("MemoryAssetStore.readObject", () => {
  it("returns the exact bytes a prior writeObject call stored", async () => {
    const store = new MemoryAssetStore();
    const body = new TextEncoder().encode("fake-png-bytes");
    const key = createAssetKey({
      workspaceId: "ws_opak",
      fileName: "cutout.png",
      mimeType: "image/png",
      size: body.byteLength,
    });
    await store.writeObject("ws_opak", key, body, "image/png");

    const read = await store.readObject("ws_opak", key);

    expect(read).toEqual(body);
  });

  it("rejects a key that does not belong to the workspace", async () => {
    const store = new MemoryAssetStore();
    await expect(
      store.readObject("ws_opak", "ws/other-workspace/sources/x/file.png"),
    ).rejects.toThrow("Asset key does not belong to workspace");
  });

  it("rejects reading an object that was never written", async () => {
    const store = new MemoryAssetStore();
    const key = createAssetKey({
      workspaceId: "ws_opak",
      fileName: "missing.png",
      mimeType: "image/png",
      size: 1,
    });
    await expect(store.readObject("ws_opak", key)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wukong/assets test -- asset-store.test.ts`
Expected: FAIL — `store.readObject is not a function`.

- [ ] **Step 3: Widen `MemoryAssetStore`'s internal storage and add `readObject` to the interface**

In `packages/assets/src/asset-store.ts`, add to the `AssetStore` interface (after `writeObject`):

```ts
  readObject(workspaceId: string, key: string): Promise<Uint8Array>;
```

Replace `MemoryAssetStore`'s internal field and the methods that touch it — the class currently stores `readonly #objects = new Map<string, AssetObjectMetadata>()`. Change it to also retain bytes:

```ts
export class MemoryAssetStore implements AssetStore {
  readonly #objects = new Map<
    string,
    { metadata: AssetObjectMetadata; body?: Uint8Array }
  >();

  async createUpload(input: CreateUploadInput) {
    const key = createAssetKey(input);
    return {
      key,
      uploadUrl: `memory://upload/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + ASSET_UPLOAD_TTL_MS),
    };
  }

  async createReadUrl(
    workspaceId: string,
    key: string,
    options?: { expiresInMs?: number },
  ) {
    assertAssetKey(workspaceId, key);
    const lifetimeMs = options?.expiresInMs ?? ASSET_UPLOAD_TTL_MS;
    return {
      url: `memory://read/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + lifetimeMs),
    };
  }

  async head(workspaceId: string, key: string) {
    assertAssetKey(workspaceId, key);
    return this.#objects.get(key)?.metadata ?? null;
  }

  async exists(workspaceId: string, key: string) {
    return (await this.head(workspaceId, key)) !== null;
  }

  async writeObject(
    workspaceId: string,
    key: string,
    body: Uint8Array,
    mimeType: string,
  ): Promise<AssetObjectMetadata> {
    assertAssetKey(workspaceId, key);
    const metadata: AssetObjectMetadata = { size: body.byteLength, mimeType };
    this.#objects.set(key, { metadata, body });
    return metadata;
  }

  async readObject(workspaceId: string, key: string): Promise<Uint8Array> {
    assertAssetKey(workspaceId, key);
    const entry = this.#objects.get(key);
    if (!entry?.body) {
      throw new Error(`no object body stored for key: ${key}`);
    }
    return entry.body;
  }

  putObject(
    workspaceId: string,
    key: string,
    metadata: AssetObjectMetadata,
  ): void {
    assertAssetKey(workspaceId, key);
    this.#objects.set(key, { metadata });
  }
}
```

This is the complete replacement for the whole `MemoryAssetStore` class body — every existing method is included above with its behavior unchanged (only the internal storage shape changed, from a bare `AssetObjectMetadata` value to `{ metadata, body? }`), plus the two new/changed methods (`writeObject` now also stores `body`, `readObject` is new).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @wukong/assets test -- asset-store.test.ts`
Expected: PASS. Also confirm no pre-existing test in this file broke (the `head`/`exists`/`writeObject`/`putObject` tests from Plan A must still pass unchanged).

- [ ] **Step 5: Write the failing test for `S3AssetStore.readObject`**

Read `packages/assets/src/s3-asset-store.test.ts` first. Add:

```ts
describe("S3AssetStore.readObject", () => {
  it("issues a GetObjectCommand and returns the body bytes", async () => {
    const bodyBytes = new TextEncoder().encode("fake-png-bytes");
    const send = vi.fn(async () => ({
      Body: { transformToByteArray: async () => bodyBytes },
    }));
    const store = new S3AssetStore({
      bucket: "test-bucket",
      transport: { send },
    });

    const result = await store.readObject(
      "ws_opak",
      "ws/ws_opak/sources/00000000-0000-4000-8000-000000000001/cutout.png",
    );

    expect(result).toEqual(bodyBytes);
    expect(send).toHaveBeenCalledOnce();
    const [command] = send.mock.calls[0]!;
    expect((command as { input: Record<string, unknown> }).input).toMatchObject(
      {
        Bucket: "test-bucket",
        Key: "ws/ws_opak/sources/00000000-0000-4000-8000-000000000001/cutout.png",
      },
    );
  });

  it("throws when the response has no readable body", async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3AssetStore({
      bucket: "test-bucket",
      transport: { send },
    });

    await expect(
      store.readObject(
        "ws_opak",
        "ws/ws_opak/sources/00000000-0000-4000-8000-000000000001/cutout.png",
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @wukong/assets test -- s3-asset-store.test.ts`
Expected: FAIL — `store.readObject is not a function`.

- [ ] **Step 7: Implement `S3AssetStore.readObject`**

In `packages/assets/src/s3-asset-store.ts`, add `GetObjectCommand` to the existing `@aws-sdk/client-s3` import (it already imports `GetObjectCommand`, `HeadObjectCommand`, `NotFound`, `PutObjectCommand`, `S3Client` — confirm `GetObjectCommand` is already there before adding a duplicate import). Add the method (after `writeObject` from Plan A, or after `exists` if `writeObject` isn't there yet — check the file's current order):

```ts
  async readObject(workspaceId: string, key: string): Promise<Uint8Array> {
    assertAssetKey(workspaceId, key);
    const response = (await this.#transport.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
      }) as unknown as S3Command,
    )) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    };
    if (!response.Body) {
      throw new Error(`no object body returned for key: ${key}`);
    }
    return response.Body.transformToByteArray();
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @wukong/assets test -- s3-asset-store.test.ts`
Expected: PASS.

- [ ] **Step 9: Full package test run and typecheck**

Run: `pnpm --filter @wukong/assets test && pnpm --filter @wukong/assets lint`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/assets/src/asset-store.ts packages/assets/src/s3-asset-store.ts packages/assets/src/asset-store.test.ts packages/assets/src/s3-asset-store.test.ts
git commit -m "feat(assets): add AssetStore.readObject for server-side asset reads"
```

---

### Task 2: Server-side background compositing

**Files:**

- Create: `packages/assets/src/product-shot-flatten.ts`
- Modify: `packages/assets/package.json`
- Test: `packages/assets/src/product-shot-flatten.test.ts`

Flattens a transparent-background cutout PNG onto a solid color, producing the final delivery-ready image. Uses `sharp`'s `.flatten({ background })`, purpose-built for exactly this (compositing an alpha-transparent image onto a solid background).

- [ ] **Step 1: Add `sharp` as a dependency**

Run: `pnpm --filter @wukong/assets add sharp`
Expected: `sharp` added to `packages/assets/package.json`'s `dependencies` (a runtime dependency here, unlike `packages/ai`'s spike script where it was dev-only — this actually runs in the production `apps/web` request path).

- [ ] **Step 2: Write the failing test**

Create `packages/assets/src/product-shot-flatten.test.ts`. This test needs a real transparent PNG as input — build one with `sharp` itself rather than hand-authoring binary fixture data:

```ts
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { flattenProductShot } from "./product-shot-flatten.js";

async function makeTransparentPng(): Promise<Uint8Array> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe("flattenProductShot", () => {
  it("composites a transparent PNG onto a solid white background", async () => {
    const cutout = await makeTransparentPng();

    const flattened = await flattenProductShot(cutout, "#ffffff");

    const pixel = await sharp(Buffer.from(flattened))
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Fully opaque white after flattening: R=255 G=255 B=255, and if an
    // alpha channel remains it must be fully opaque (255) -- flatten()
    // removes transparency, it does not just recolor it.
    expect(pixel.data[0]).toBe(255);
    expect(pixel.data[1]).toBe(255);
    expect(pixel.data[2]).toBe(255);
    if (pixel.info.channels === 4) {
      expect(pixel.data[3]).toBe(255);
    }
  });

  it("composites onto a brand color", async () => {
    const cutout = await makeTransparentPng();

    const flattened = await flattenProductShot(cutout, "#112233");

    const pixel = await sharp(Buffer.from(flattened))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(pixel.data[0]).toBe(0x11);
    expect(pixel.data[1]).toBe(0x22);
    expect(pixel.data[2]).toBe(0x33);
  });

  it("rejects a malformed background color", async () => {
    const cutout = await makeTransparentPng();
    await expect(flattenProductShot(cutout, "not-a-color")).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @wukong/assets test -- product-shot-flatten.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `flattenProductShot`**

Create `packages/assets/src/product-shot-flatten.ts`:

```ts
import sharp from "sharp";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export async function flattenProductShot(
  cutoutPng: Uint8Array,
  backgroundColor: string,
): Promise<Uint8Array> {
  if (!HEX_COLOR.test(backgroundColor)) {
    throw new Error(`invalid background color: ${backgroundColor}`);
  }
  const flattened = await sharp(cutoutPng)
    .flatten({ background: backgroundColor })
    .png()
    .toBuffer();
  return new Uint8Array(flattened);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wukong/assets test -- product-shot-flatten.test.ts`
Expected: PASS.

- [ ] **Step 6: Export it from the package**

In `packages/assets/src/index.ts`, add:

```ts
export { flattenProductShot } from "./product-shot-flatten.js";
```

- [ ] **Step 7: Full package test run and typecheck**

Run: `pnpm --filter @wukong/assets test && pnpm --filter @wukong/assets lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/assets/package.json pnpm-lock.yaml packages/assets/src/product-shot-flatten.ts packages/assets/src/product-shot-flatten.test.ts packages/assets/src/index.ts
git commit -m "feat(assets): add server-side product shot background compositing"
```

---

### Task 3: `promoteAndApprove` repository method

**Files:**

- Modify: `packages/db/src/repositories/listings.ts`
- Test: `packages/db/src/repositories/listings-promote-approve.integration.test.ts` (new file)

Promotes a freshly-appended version (never previously active) directly to active-and-approved in one atomic update — `approve()` cannot do this since it requires its target version to already be active.

- [ ] **Step 1: Write the failing integration test**

This mirrors `packages/db/src/repositories/listings-edit-review.integration.test.ts` exactly (its `seedListing(status)` helper, its `admin.unsafe`/`database.migrate()` setup, its raw-SQL status-seeding pattern for reaching an arbitrary status without going through the normal transition flow). Create `packages/db/src/repositories/listings-promote-approve.integration.test.ts`:

```ts
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const workspaceId = "ws_promote_approve";

const listingContent: CanonicalListing = {
  sku: "OPAK-001",
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
  stockQuantity: 4,
  criticScores: [],
  awards: [],
  title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: {
    title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
    description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  },
  tags: ["Riesling"],
  imageAssetIds: [],
};

describe("promoteAndApprove", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const contextFor = (listingId: string): AuditContext => ({
    workspaceId,
    actorId: "test:promote-approve",
    entityId: listingId,
  });

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

  async function seedInReview(): Promise<{
    listingId: string;
    activeVersionId: string;
  }> {
    const created = await forWorkspace(database, workspaceId, async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      const version = await repos.listings.appendVersion(
        listing.id,
        listingContent,
        contextFor(listing.id),
        repos.audit,
      );
      return { listingId: listing.id, versionId: version.id };
    });
    await admin`update listing_drafts set status = 'in_review', active_version_id = ${created.versionId} where workspace_id = ${workspaceId} and id = ${created.listingId}`;
    return { listingId: created.listingId, activeVersionId: created.versionId };
  }

  it("promotes a freshly-appended version to active and approves it in one step", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        { ...listingContent, imageAssetIds: ["asset_flattened_1"] },
        contextFor(listingId),
        repos.audit,
      ),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        newVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("approved");
    expect(after?.activeVersionId).toBe(newVersion.id);
  });

  it("refuses when the active version has changed since baseVersionId was read", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const staleVersionId = "00000000-0000-4000-8000-000000000099";

    await expect(
      forWorkspace(database, workspaceId, (repos) =>
        repos.listings.promoteAndApprove(
          listingId,
          staleVersionId,
          activeVersionId,
          contextFor(listingId),
          repos.audit,
        ),
      ),
    ).rejects.toThrow("active listing version changed");

    const after = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.getById(listingId),
    );
    expect(after?.status).toBe("in_review");
  });

  it("writes a listing.approved audit event with the new version's id", async () => {
    const { listingId, activeVersionId } = await seedInReview();
    const newVersion = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.appendVersion(
        listingId,
        listingContent,
        contextFor(listingId),
        repos.audit,
      ),
    );

    await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.promoteAndApprove(
        listingId,
        activeVersionId,
        newVersion.id,
        contextFor(listingId),
        repos.audit,
      ),
    );

    const events =
      await admin`select action, metadata from audit_events where workspace_id = ${workspaceId} and action = 'listing.approved' order by created_at desc limit 1`;
    expect(events[0]?.metadata).toMatchObject({ versionId: newVersion.id });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @wukong/db test:integration -- listings-promote-approve.integration.test.ts`
Expected: FAIL — `repositories.listings.promoteAndApprove is not a function`.

- [ ] **Step 3: Add `promoteAndApprove` to the `ListingRepository` type**

In `packages/db/src/repositories/listings.ts`, add to the `ListingRepository` type (after `approve`):

```ts
  promoteAndApprove(
    id: string,
    baseVersionId: string,
    newVersionId: string,
    context: AuditContext,
    audit: AuditWriter,
  ): Promise<void>;
```

- [ ] **Step 4: Implement it**

In the object returned by `createListingRepository`, add (right after the existing `approve` method):

```ts
    async promoteAndApprove(id, baseVersionId, newVersionId, context, audit) {
      scope.assertOpen();
      const listing = await this.requireById(id);
      if (listing.activeVersionId !== baseVersionId)
        throw new Error("active listing version changed");
      if (listing.status === "reopened")
        await transitionListing(
          listing.status,
          "submit_review",
          context,
          audit,
        );
      const next = await transitionListing(
        listing.status === "reopened" ? "in_review" : listing.status,
        "approve",
        context,
        audit,
      );
      const updated = await transaction
        .update(listingDrafts)
        .set({
          status: next,
          activeVersionId: newVersionId,
          updatedAt: new Date(),
        })
        .where(
          and(
            byId(id),
            eq(
              listingDrafts.status,
              listing.status === "reopened" ? "in_review" : listing.status,
            ),
            eq(listingDrafts.activeVersionId, baseVersionId),
          ),
        )
        .returning({ id: listingDrafts.id });
      if (updated.length !== 1)
        throw new Error("listing status changed while approving");
      await audit.write({
        ...context,
        action: "listing.approved",
        metadata: { versionId: newVersionId },
      });
    },
```

This is deliberately near-identical to the existing `approve()` method a few lines above it — the only differences are: the precondition checks `baseVersionId` (the version that must currently be active) rather than the version being approved, and the `SET`/`WHERE` clauses use `newVersionId`/`baseVersionId` in place of the single `versionId` `approve()` uses for both roles.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @wukong/db test:integration -- listings-promote-approve.integration.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Full package test run and typecheck**

Run: `pnpm --filter @wukong/db test && pnpm --filter @wukong/db test:integration && pnpm --filter @wukong/db lint`
Expected: all pass, including every pre-existing test in `listings.integration.test.ts`/`listings-edit-review.integration.test.ts` unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/listings.ts packages/db/src/repositories/listings-promote-approve.integration.test.ts
git commit -m "feat(db): add promoteAndApprove for approving a freshly-appended version"
```

---

### Task 4: Wire approval-time flattening into `approveOne`

**Files:**

- Modify: `apps/web/lib/listing-approval.ts`
- Modify: `apps/web/app/api/listings/[id]/approve/route.ts`
- Modify: `apps/web/app/api/listings/[id]/approve/route.test.ts`
- Modify: `apps/web/app/api/listings/bulk-approve/route.test.ts`

This is the integration task tying Tasks 1-3 together. No `listing-approval.test.ts` exists — `approveOne`'s behavior is covered entirely through the two route test files above, both confirmed read in full already. **Both of their fakes mock `repositories.listings.requireForPublish`, not `getReviewSnapshot`.** Switching `approveOne` to call `getReviewSnapshot` (needed because it also returns `evidence`, which `requireForPublish` does not) means **both existing fakes must be updated to provide `getReviewSnapshot` instead** — this is a required change, not an optional one, and both files' EXISTING test assertions must still pass afterward with no behavior change for their scenarios.

The current, exact, full `approveOne` (`apps/web/lib/listing-approval.ts`):

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

`ReviewSnapshot` (the `getReviewSnapshot` return shape, confirmed from `packages/db/src/repositories/listings.ts`) is `{ listing: Listing, activeVersion: {id, sequence, content} | null, evidence: FieldEvidence[], flags: ComplianceFlag[] } | null` — `target`/`status` live on the nested `listing` field, not top-level like `requireForPublish`'s shape. `Listing` is Drizzle-inferred from `listing_drafts` and includes `target`.

- [ ] **Step 1: Update both existing route tests' fakes from `requireForPublish` to `getReviewSnapshot`**

In `apps/web/app/api/listings/[id]/approve/route.test.ts`, in `makeHandler`, replace the `requireForPublish` method on the fake `listings` object with `getReviewSnapshot`, returning the new nested shape (add an empty `evidence: []` since nothing in the existing tests needs real evidence data):

```ts
async getReviewSnapshot(_id: string) {
  calls.push(["getReviewSnapshot", _id]);
  return {
    listing: { id: listingId, target: "shopline", status: options.status ?? "in_review" },
    activeVersion: { id: versionId, sequence: 3, content: { sku: "OPAK-001", imageAssetIds: [] } },
    evidence: [],
    flags: options.flags ?? [],
  };
},
```

Keep the existing `approve` method on the fake unchanged. Run the file's 3 existing tests and confirm all 3 still pass with only this rename/reshape — no assertion in any of them should need to change, since none of them inspect `calls` for a `"requireForPublish"` entry by that literal string (double check this against the actual file; if any assertion does reference that string, update it to `"getReviewSnapshot"`).

Apply the identical fake replacement in `apps/web/app/api/listings/bulk-approve/route.test.ts`'s `makeHandler` (same nested shape, using that file's own `id`/`flagged` variables), and confirm its 4 existing tests still pass unchanged.

- [ ] **Step 2: Write the failing test for "background chosen and a cutout exists"**

Add to `apps/web/app/api/listings/[id]/approve/route.test.ts`, extending `makeHandler`'s fake `repositories` with `sourceAssets`/`workspaces` and extending the handler's deps with an `assetStore` fake plus a real `flattenProductShot` import (or a fake one injected — use whichever the actual `createApproveListingHandler` deps shape ends up needing per Step 4's implementation; read that file fresh once Step 4 is done, before finalizing this test, since the exact deps wiring determines exactly what this test must mock):

```ts
it("flattens the cutout onto the chosen background and approves the new version", async () => {
  const finalStorageKey = "ws/ws_opak/sources/final/product-shot-final.png";
  const calls: unknown[] = [];
  const handler = createApproveListingHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: "reviewer" };
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
              async getReviewSnapshot() {
                return {
                  listing: {
                    id: listingId,
                    target: "shopline",
                    status: "in_review",
                  },
                  activeVersion: {
                    id: versionId,
                    sequence: 3,
                    content: {
                      sku: "OPAK-001",
                      imageAssetIds: ["asset_raw_1"],
                    },
                  },
                  evidence: [
                    {
                      field: "sku",
                      sourceAssetId: "note",
                      page: null,
                      excerpt: "OPAK-001",
                      confidence: 1,
                    },
                  ],
                  flags: [],
                };
              },
              async appendVersion(_id: string, content: any) {
                calls.push(["appendVersion", content]);
                return { id: "version_new_1", sequence: 4 };
              },
              async replaceEvidence(versionId: string, evidence: unknown[]) {
                calls.push(["replaceEvidence", versionId, evidence]);
              },
              async replaceFlags(versionId: string, flags: unknown[]) {
                calls.push(["replaceFlags", versionId, flags]);
              },
              async promoteAndApprove(
                id: string,
                baseVersionId: string,
                newVersionId: string,
              ) {
                calls.push([
                  "promoteAndApprove",
                  id,
                  baseVersionId,
                  newVersionId,
                ]);
              },
              async approve() {
                calls.push(["approve-should-not-be-called"]);
              },
            },
            sourceAssets: {
              async listForListing() {
                return [
                  {
                    id: "asset_cutout_1",
                    kind: "image/png",
                    metadata: { role: "product_shot_cutout" },
                    storageKey: "ws/ws_opak/sources/cutout/x.png",
                  },
                ];
              },
              async create(input: unknown) {
                calls.push(["sourceAssets.create", input]);
                return { id: "asset_final_1" };
              },
              async attachToListing(id: string, assetIds: string[]) {
                calls.push(["attachToListing", id, assetIds]);
              },
            },
            workspaces: {
              async requireProfile() {
                return { brandBackgroundColor: null };
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
    approve: async (
      version: string,
      flags: any[],
      auditContext: any,
      audit: any,
    ) => {
      await audit.write({
        ...auditContext,
        action: "listing.approved",
        metadata: { versionId: version },
      });
      return { versionId: version, status: "approved" as const };
    },
    assetStore: {
      async readObject() {
        return new Uint8Array([1, 2, 3]);
      },
      async writeObject(_ws: string, key: string, body: Uint8Array) {
        calls.push(["writeObject", key, body]);
        return { size: body.byteLength, mimeType: "image/png" };
      },
      createAssetKey() {
        return finalStorageKey;
      },
    },
    flattenProductShot: async (_bytes: Uint8Array, color: string) => {
      calls.push(["flattenProductShot", color]);
      return new Uint8Array([9, 9, 9]);
    },
  } as never);

  const response = await handler(
    new Request(`http://localhost/api/listings/${listingId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ background: "white" }),
    }),
    routeContext(),
  );

  expect(response.status).toBe(200);
  expect(calls).toContainEqual(["flattenProductShot", "#ffffff"]);
  expect(calls).toContainEqual([
    "writeObject",
    finalStorageKey,
    new Uint8Array([9, 9, 9]),
  ]);
  expect(calls).toContainEqual([
    "sourceAssets.create",
    expect.objectContaining({
      storageKey: finalStorageKey,
      kind: "image/png",
      metadata: { role: "product_shot_final", listingId },
    }),
  ]);
  expect(calls).toContainEqual([
    "attachToListing",
    listingId,
    ["asset_final_1"],
  ]);
  expect(calls).toContainEqual([
    "appendVersion",
    expect.objectContaining({
      imageAssetIds: ["asset_raw_1", "asset_final_1"],
    }),
  ]);
  expect(calls).toContainEqual([
    "promoteAndApprove",
    listingId,
    versionId,
    "version_new_1",
  ]);
  expect(calls).not.toContainEqual(["approve-should-not-be-called"]);
});
```

This test is deliberately injecting a fake `flattenProductShot` through the handler's deps rather than importing the real one from `@wukong/assets` — decide during Step 4 whether `approveOne`/the route handler actually accepts `flattenProductShot` as an injectable dependency (following this codebase's established "everything real is injected, concrete binding at the bottom of the file" rule) or imports it directly as a fixed dependency; if it's imported directly rather than injected, this test cannot fake it and must be rewritten to either accept the real compositing output or mock `@wukong/assets`'s export at the module level (`vi.mock`) — read how any existing test in this repo already mocks a `@wukong/assets` export (if any) before choosing, and prefer dependency injection over `vi.mock` if there's no existing precedent for the latter, since injection matches this project's architecture rule more directly.

- [ ] **Step 3: Write the failing test for "no background chosen, or no cutout exists" (must be unchanged)**

Add a test using the existing (now-`getReviewSnapshot`-based) `makeHandler` helper from Step 1, with no `background` in the request body (the existing "approves the server-resolved active version..." test already covers exactly this — confirm it still passes as one of the regression guards; if you want an EXTRA explicit case, add one where `background: "white"` is sent but `sourceAssets.listForListing` returns no `product_shot_cutout`-tagged asset, asserting `listings.approve` is still called with the original `versionId`, and `assetStore`/`flattenProductShot` are never invoked).

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @wukong/web test -- approve/route.test.ts`
Expected: FAIL — `approveOne` doesn't yet accept `background`/`assetStore`/handle the flatten path, and the fakes don't yet provide `getReviewSnapshot`.

- [ ] **Step 5: Restructure `approveOne`**

Replace the full body of `apps/web/lib/listing-approval.ts` with:

```ts
import {
  approveListing as domainApprove,
  type AuditContext,
} from "@wukong/core";
import { flattenProductShot } from "@wukong/assets";

import { ApiError } from "./route-support";

export type ApproveOneAssetStore = {
  readObject(workspaceId: string, key: string): Promise<Uint8Array>;
  writeObject(
    workspaceId: string,
    key: string,
    body: Uint8Array,
    mimeType: string,
  ): Promise<{ size: number; mimeType: string }>;
  createAssetKey(input: {
    workspaceId: string;
    fileName: string;
    mimeType: string;
    size: number;
  }): string;
};

export type ApproveOneDeps = {
  approve?: typeof domainApprove;
  background?: "white" | "brand";
  assetStore?: ApproveOneAssetStore;
};

export type ApproveOneResult = {
  listingId: string;
  versionId: string;
  status: "approved";
};

export async function approveOne(
  id: string,
  auditContext: AuditContext,
  repositories: any,
  deps: ApproveOneDeps = {},
): Promise<ApproveOneResult> {
  const snapshot = await repositories.listings.getReviewSnapshot(id);
  if (!snapshot) {
    throw new ApiError(404, "listing_not_found", "Listing not found.");
  }
  if (snapshot.listing.target !== "shopline" || !snapshot.activeVersion) {
    throw new ApiError(409, "approval_required", "可批准的版本不存在。");
  }

  let versionIdToApprove: string = snapshot.activeVersion.id;

  if (deps.background && deps.assetStore) {
    const listingAssets = await repositories.sourceAssets.listForListing(id);
    const cutout = listingAssets.find(
      (asset: any) =>
        asset.kind === "image/png" &&
        (asset.metadata as Record<string, unknown> | null)?.role ===
          "product_shot_cutout",
    );
    if (cutout) {
      const profile = await repositories.workspaces.requireProfile();
      const targetColor =
        deps.background === "brand" && profile.brandBackgroundColor
          ? profile.brandBackgroundColor
          : "#ffffff";
      const cutoutBytes = await deps.assetStore.readObject(
        auditContext.workspaceId,
        cutout.storageKey,
      );
      const flattenedBytes = await flattenProductShot(cutoutBytes, targetColor);
      const storageKey = deps.assetStore.createAssetKey({
        workspaceId: auditContext.workspaceId,
        fileName: "product-shot-final.png",
        mimeType: "image/png",
        size: flattenedBytes.byteLength,
      });
      await deps.assetStore.writeObject(
        auditContext.workspaceId,
        storageKey,
        flattenedBytes,
        "image/png",
      );
      const finalAsset = await repositories.sourceAssets.create({
        storageKey,
        kind: "image/png",
        metadata: { role: "product_shot_final", listingId: id },
      });
      await repositories.sourceAssets.attachToListing(id, [finalAsset.id]);
      const newContent = {
        ...snapshot.activeVersion.content,
        imageAssetIds: [
          ...snapshot.activeVersion.content.imageAssetIds,
          finalAsset.id,
        ],
      };
      const newVersion = await repositories.listings.appendVersion(
        id,
        newContent,
        auditContext,
        repositories.audit,
      );
      await repositories.listings.replaceEvidence(
        newVersion.id,
        snapshot.evidence,
      );
      await repositories.listings.replaceFlags(newVersion.id, snapshot.flags);
      versionIdToApprove = newVersion.id;
    }
  }

  try {
    const approved = await (deps.approve ?? domainApprove)(
      versionIdToApprove,
      snapshot.flags,
      auditContext,
      repositories.audit,
    );
    if (versionIdToApprove === snapshot.activeVersion.id) {
      if (typeof repositories.listings.approve !== "function")
        throw new Error("listing approval repository is unavailable");
      await repositories.listings.approve(
        id,
        approved.versionId,
        auditContext,
        repositories.audit,
      );
    } else {
      if (typeof repositories.listings.promoteAndApprove !== "function")
        throw new Error("listing approval repository is unavailable");
      await repositories.listings.promoteAndApprove(
        id,
        snapshot.activeVersion.id,
        approved.versionId,
        auditContext,
        repositories.audit,
      );
    }
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

Note the 404 path changed from a try/catch around `requireForPublish` (which threw a "not found"-message error) to a direct `null` check on `getReviewSnapshot`'s result — this is `getReviewSnapshot`'s documented contract (returns `null`, never throws, when the listing doesn't exist), so this is a faithful behavioral translation, not a new gap. Since `flattenProductShot` is imported directly from `@wukong/assets` (not injected through `deps`) in this version, Step 2's test must mock `@wukong/assets`'s export at the module level with `vi.mock("@wukong/assets", ...)` rather than passing a `flattenProductShot` deps field — revise that test's fake-injection approach accordingly once you're implementing this step, keeping the real `readObject`/`writeObject`/`createAssetKey` on `deps.assetStore` as designed (those remain injected, since they're genuinely swappable I/O, unlike the pure `flattenProductShot` function).

- [ ] **Step 6: Extend the approve route's body schema and deps**

In `apps/web/app/api/listings/[id]/approve/route.ts`, change `bodySchema` from `z.object({}).strip()` to:

```ts
const bodySchema = z
  .object({
    background: z.enum(["white", "brand"]).optional(),
  })
  .strip();
```

Add `assetStore: ApproveOneAssetStore` (imported from `../../../../../lib/listing-approval`) to `ApprovalRouteDeps`, and thread the parsed `background` plus `deps.assetStore` into the `approveOne` call:

```ts
const parsedBody = await bodySchema.parseAsync(
  await request.json().catch(() => ({})),
);
const result = await deps
  .getDatabase()
  .forWorkspace(session.workspaceId, (repositories) =>
    approveOne(id, auditContext, repositories, {
      approve: deps.approve,
      background: parsedBody.background,
      assetStore: deps.assetStore,
    }),
  );
```

Wire the concrete `assetStore` at the bottom of the file the same way Plan B1's GET route (`apps/web/app/api/listings/[id]/route.ts`) wired its own `getAssetStore`-derived dependency — read that file's exact concrete-binding block and mirror its adapter shape (turning the real `AssetStore`/`createAssetKey` into the narrower `ApproveOneAssetStore` shape), rather than inventing a different wiring pattern here.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @wukong/web test -- approve/route.test.ts bulk-approve/route.test.ts`
Expected: PASS — all pre-existing tests in both files (updated in Step 1 to use `getReviewSnapshot`) plus the two new tests from Steps 2-3.

- [ ] **Step 8: Full package test run, typecheck, and full monorepo verification**

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets build
pnpm test
pnpm test:integration
pnpm lint
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/listing-approval.ts apps/web/app/api/listings/\[id\]/approve/route.ts apps/web/app/api/listings/\[id\]/approve/route.test.ts apps/web/app/api/listings/bulk-approve/route.test.ts
git commit -m "feat(web): flatten and persist the chosen product-shot background at approval time"
```

---

## Verification

After all four tasks:

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets --filter @wukong/shopline --filter @wukong/jobs build
pnpm test
pnpm test:integration
pnpm lint
```

Expected: all green. For every real listing today (none has a product-shot cutout asset), approving with any `background` value — or none at all — must produce byte-identical behavior to before this plan: the same single existing-version approval, no new asset, no new version, no extra queries beyond the one `listForListing` check that finds nothing.
