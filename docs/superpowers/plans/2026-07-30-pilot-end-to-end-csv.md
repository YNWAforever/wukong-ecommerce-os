# Pilot End-to-End via CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exported CSV image URLs survive a human carrying the file to SHOPLINE, and the CSV spec is validated against Opak's store before the pipeline runs.

**Architecture:** `createReadUrl` gains an explicit lifetime that defaults to today's ten minutes. Only the CSV branch of the deliver route asks for seven days; the SHOPLINE API branch and in-app previews keep the short one. A committed script emits a sample CSV so the spec can be validated without any infrastructure.

**Tech Stack:** TypeScript, Vitest, `@aws-sdk/s3-request-presigner`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-30-pilot-end-to-end-csv-design.md`

---

## Scope note

Tasks 1–5 are code. Tracks 2 and 3 from the spec (deploying the Worker, running the
real wine through SHOPLINE) are operator work and appear as checklists at the end —
they cannot be done from this repo.

## File structure

| File                                              | Responsibility                         | Change                                                |
| ------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `packages/assets/src/asset-store.ts`              | Port + TTL constants + in-memory store | Add `ASSET_EXPORT_READ_TTL_MS`; widen `createReadUrl` |
| `packages/assets/src/s3-asset-store.ts`           | Real presigning                        | Honour the passed lifetime                            |
| `packages/assets/src/listing-image-resolver.ts`   | Asset ids → signed URLs                | Pass a lifetime through                               |
| `apps/web/app/api/listings/[id]/deliver/route.ts` | Delivery branches                      | CSV branch asks for the export lifetime               |
| `packages/shopline/src/cli/sample-csv.ts`         | Track 1 harness                        | New                                                   |

---

### Task 1: Give `createReadUrl` an explicit lifetime

**Files:**

- Modify: `packages/assets/src/asset-store.ts:3` (constants), `:40-43` (port), `:127-133` (memory store)
- Test: `packages/assets/src/s3-asset-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/assets/src/s3-asset-store.test.ts`:

```ts
it("presigns a read for the caller's lifetime and defaults to ten minutes", async () => {
  const seen: number[] = [];
  const store = new S3AssetStore({
    bucket: "wukong-opak-prod-assets",
    transport: {
      async send() {
        return {};
      },
    },
    presign: async (_transport, _command, options) => {
      seen.push(options.expiresIn);
      return "https://example.invalid/signed";
    },
  });

  await store.createReadUrl("ws_opak", "ws/ws_opak/sources/d1/a.webp");
  await store.createReadUrl("ws_opak", "ws/ws_opak/sources/d1/a.webp", {
    expiresInMs: ASSET_EXPORT_READ_TTL_MS,
  });

  expect(seen).toEqual([600, 604_800]);
});
```

Add `ASSET_EXPORT_READ_TTL_MS` to the existing import from `./asset-store.js` in that
test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/assets src/s3-asset-store.test.ts`
Expected: FAIL — `ASSET_EXPORT_READ_TTL_MS` is not exported.

- [ ] **Step 3: Add the constant**

In `packages/assets/src/asset-store.ts`, directly below `ASSET_UPLOAD_TTL_MS`:

```ts
// Seven days is the SigV4 ceiling for a presigned URL. Exported CSVs are carried
// to SHOPLINE by a person, so the ten-minute upload window does not apply.
export const ASSET_EXPORT_READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Widen the port**

Replace the `createReadUrl` member of the `AssetStore` interface:

```ts
  createReadUrl(
    workspaceId: string,
    key: string,
    options?: { expiresInMs?: number },
  ): Promise<{ url: string; expiresAt: Date }>;
```

- [ ] **Step 5: Honour it in the in-memory store**

Replace the in-memory `createReadUrl`:

```ts
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
```

- [ ] **Step 6: Honour it in the S3 store**

In `packages/assets/src/s3-asset-store.ts`, replace `createReadUrl`:

```ts
  async createReadUrl(
    workspaceId: string,
    key: string,
    options?: { expiresInMs?: number },
  ) {
    assertAssetKey(workspaceId, key);
    const lifetimeMs = options?.expiresInMs ?? ASSET_UPLOAD_TTL_MS;
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }) as unknown as S3Command;
    const url = await this.#presign(this.#transport, command, {
      expiresIn: lifetimeMs / 1000,
    });
    return {
      url,
      expiresAt: new Date(this.#now().getTime() + lifetimeMs),
    };
  }
```

Add `ASSET_EXPORT_READ_TTL_MS` to the existing import from `./asset-store.js`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run --root packages/assets`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 8: Commit**

```bash
git add packages/assets/src/asset-store.ts packages/assets/src/s3-asset-store.ts packages/assets/src/s3-asset-store.test.ts
git commit -m "feat: let a read presign carry an explicit lifetime"
```

---

### Task 2: Thread the lifetime through the image resolver

**Files:**

- Modify: `packages/assets/src/listing-image-resolver.ts:11-19` (input type), `:59` (call)
- Test: `packages/assets/src/listing-image-resolver.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
it("passes the requested lifetime to the asset store", async () => {
  const seen: Array<{ expiresInMs?: number } | undefined> = [];
  await resolveListingImageUrls({
    workspaceId: "ws_opak",
    draftId: "d1",
    imageAssetIds: ["a1"],
    sourceAssets: {
      async getByIds() {
        return [{ id: "a1", storageKey: "ws/ws_opak/sources/d1/a.webp" }];
      },
    },
    assetStore: {
      async createReadUrl(_workspaceId, _key, options) {
        seen.push(options);
        return { url: "https://example.invalid/x", expiresAt: new Date() };
      },
    },
    readTtlMs: ASSET_EXPORT_READ_TTL_MS,
  });

  expect(seen).toEqual([{ expiresInMs: ASSET_EXPORT_READ_TTL_MS }]);
});
```

If `ListingImageAsset` needs more fields than `id`/`storageKey`, copy the fixture shape
already used in `apps/worker/src/image-resolver.test.ts` rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/assets src/listing-image-resolver.test.ts`
Expected: FAIL — `readTtlMs` is not accepted.

- [ ] **Step 3: Add the field to the input type**

```ts
export type ResolveListingImageUrlsInput = {
  workspaceId: string;
  draftId: string;
  imageAssetIds: readonly string[];
  sourceAssets: {
    getByIds(ids: string[]): Promise<ListingImageAsset[]>;
  };
  assetStore: Pick<AssetStore, "createReadUrl">;
  /** Omitted for in-app reads; set only for URLs leaving the app in a file. */
  readTtlMs?: number;
};
```

- [ ] **Step 4: Pass it at the call site**

Destructure `readTtlMs` in the function signature, then replace line 59:

```ts
        (
          await assetStore.createReadUrl(workspaceId, asset.storageKey, {
            expiresInMs: readTtlMs,
          })
        ).url,
```

`expiresInMs: undefined` falls through to the default, so in-app callers are unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --root packages/assets`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/assets/src/listing-image-resolver.ts packages/assets/src/listing-image-resolver.test.ts
git commit -m "feat: let image resolution request a read lifetime"
```

---

### Task 3: Use the export lifetime in the CSV branch only

**Files:**

- Modify: `apps/web/app/api/listings/[id]/deliver/route.ts:160`
- Test: `apps/web/app/api/listings/[id]/deliver/route.test.ts`

The CSV branch is the `resolveListingImageUrls` call inside `if (input.method === "csv")`
at line 160. The call at line 191 belongs to the SHOPLINE API branch and **must not
change** — that path fetches immediately and does not need a week-long URL.

**Seam note — read before writing the test.** The existing tests in this file inject a
fake `delivery` port through `makeHandler`, so they never reach image resolution at all.
The lambdas at lines 160 and 191 live inside the exported `defaultDelivery`, and the
module already hoists `runtimeMocks.getAssetStore` / `runtimeMocks.getDatabase` via
`vi.mock("../../../../../lib/intake-runtime")`. Those mocks are the seam: drive
`defaultDelivery` directly with a fake asset store, not `makeHandler`.

Also note the existing `deliveryContent` fixture has `imageAssetIds: []`. A test that
asserts on resolved images must supply at least one id, or nothing is resolved and the
assertion passes vacuously.

- [ ] **Step 1: Write the failing test**

```ts
it("signs CSV image URLs for the export lifetime, not the in-app one", async () => {
  const seen: Array<{ expiresInMs?: number } | undefined> = [];
  runtimeMocks.getAssetStore.mockReturnValue({
    async createReadUrl(
      _workspaceId: string,
      _key: string,
      options?: { expiresInMs?: number },
    ) {
      seen.push(options);
      return { url: "https://example.invalid/x.webp", expiresAt: new Date() };
    },
  });
  runtimeMocks.getDatabase.mockReturnValue(deliveryDatabaseFake());

  await defaultDelivery.deliver({
    method: "csv",
    workspaceId: "ws_opak",
    listingId,
    versionId,
    actorId: "reviewer_1",
  } as never);

  expect(seen).toEqual([{ expiresInMs: ASSET_EXPORT_READ_TTL_MS }]);
});
```

`deliveryDatabaseFake()` is a new local helper returning `{ forWorkspace }` that yields
repositories with `shoplineConnections.getDefault`, `listings`, `sourceAssets.getByIds`
(returning one asset), `audit`, and `publishJobs`. Build it by copying the repository
shapes `makeHandler` already constructs in this file — do not invent field names.

Confirm `defaultDelivery.deliver`'s real input type before writing the call; the `as never`
above is a placeholder for whatever that type is and **must be replaced** with the real
shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run "app/api/listings/[id]/deliver/route.test.ts"`
Expected: FAIL — received `[undefined]`.

- [ ] **Step 3: Pass the export lifetime**

At line 160 only:

```ts
              imageUrls: (workspaceId, draftId, imageAssetIds) =>
                resolveListingImageUrls({
                  workspaceId,
                  draftId,
                  imageAssetIds,
                  sourceAssets: repositories.sourceAssets,
                  assetStore,
                  // The operator downloads this file and uploads it to SHOPLINE by
                  // hand. Ten minutes expires before SHOPLINE ever fetches the images.
                  readTtlMs: ASSET_EXPORT_READ_TTL_MS,
                }),
```

Add `ASSET_EXPORT_READ_TTL_MS` to the existing `@wukong/assets` import at the top of the
file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run "app/api/listings/[id]/deliver"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/api/listings/[id]/deliver/route.ts" "apps/web/app/api/listings/[id]/deliver/route.test.ts"
git commit -m "fix: keep exported CSV image URLs alive past the handoff"
```

---

### Task 4: Prove the API branch was not widened

**Files:**

- Test: `apps/web/app/api/listings/[id]/deliver/route.test.ts`

This is the regression that matters. The defect being fixed was one constant serving two
needs; without this test, a later edit can silently widen the API path too.

- [ ] **Step 1: Write the test**

Same seam as Task 3 — `runtimeMocks.getAssetStore` plus `defaultDelivery`, with
`method: "shopline"` instead of `"csv"`:

```ts
it("leaves SHOPLINE API image URLs on the short lifetime", async () => {
  const seen: Array<{ expiresInMs?: number } | undefined> = [];
  runtimeMocks.getAssetStore.mockReturnValue({
    async createReadUrl(
      _workspaceId: string,
      _key: string,
      options?: { expiresInMs?: number },
    ) {
      seen.push(options);
      return { url: "https://example.invalid/x.webp", expiresAt: new Date() };
    },
  });
  runtimeMocks.getDatabase.mockReturnValue(deliveryDatabaseFake());

  await defaultDelivery.deliver({
    method: "shopline",
    workspaceId: "ws_opak",
    listingId,
    versionId,
    actorId: "reviewer_1",
  } as never);

  expect(seen).toEqual([{ expiresInMs: undefined }]);
});
```

The SHOPLINE branch may require a verified connection and reach the two-phase enqueue
path. If it throws before resolving images, assert on `seen` inside a `try`/`finally`
rather than weakening the test — the assertion is about the lifetime, not the outcome.

- [ ] **Step 2: Run it**

Run: `cd apps/web && npx vitest run "app/api/listings/[id]/deliver"`
Expected: PASS immediately — Task 3 deliberately changed only the CSV branch. If it
fails, Task 3 edited the wrong call site.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/app/api/listings/[id]/deliver/route.test.ts"
git commit -m "test: pin the SHOPLINE API read lifetime"
```

---

### Task 5: Track 1 — the CSV validation harness

**Files:**

- Create: `packages/shopline/src/cli/sample-csv.ts`
- Modify: `packages/shopline/package.json` (add the script)

- [ ] **Step 1: Write the harness**

```ts
import { writeFileSync } from "node:fs";

import { createShoplineCsv } from "../csv.js";
import { validateShoplineProducts } from "../validation.js";
import type { ShoplineProductPayload } from "../projection.js";

// One representative Opak wine. Values are illustrative only; the point is to
// exercise every column, including the ones that are easy to get wrong:
// semicolon-joined tags and images, and both language variants.
const sample: ShoplineProductPayload = {
  product: {
    sku: "OPAK-SAMPLE-001",
    title_translations: {
      en: "Sample Cabernet Sauvignon 2019",
      "zh-hant": "樣本 赤霞珠 2019",
    },
    description_translations: {
      en: "A sample description used only to validate the CSV import.",
      "zh-hant": "此為驗證 CSV 匯入用的樣本描述。",
    },
    seo_title_translations: {
      en: "Sample Cabernet Sauvignon 2019",
      "zh-hant": "樣本 赤霞珠 2019",
    },
    seo_description_translations: {
      en: "Sample SEO description.",
      "zh-hant": "樣本 SEO 描述。",
    },
    price: 380,
    quantity: 6,
    unlimited_quantity: false,
    tags: ["red", "cabernet-sauvignon", "2019"],
    images: ["https://example.invalid/sample-bottle.webp"],
    status: false,
  },
} as ShoplineProductPayload;

const payloads = [sample];
validateShoplineProducts(payloads);
const target = process.argv[2] ?? "sample-shopline.csv";
writeFileSync(target, createShoplineCsv(payloads), "utf8");
console.log(`wrote ${target}`);
```

If the real `ShoplineProductPayload` has required fields beyond these, take them from
the fixtures in `packages/shopline/src/csv.test.ts` rather than guessing — the `as`
cast exists only to keep the sample readable, not to skip required fields. Remove the
cast once the shape is complete; a cast that hides a missing required field would make
the harness validate something SHOPLINE will never receive.

**Deliberate divergence from the spec.** The spec said the harness would reuse the
fixtures in `csv.test.ts` so the two cannot drift. Importing a `.test.ts` module from
shipped CLI source is wrong — test files are not part of the build. The harness owns its
sample instead. If drift becomes a real problem, extract the fixture to a shared
non-test module and have both import it; that is not worth doing for one sample today.

- [ ] **Step 2: Add the script**

In `packages/shopline/package.json`, inside `"scripts"`:

```json
    "csv:sample": "tsx src/cli/sample-csv.ts",
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @wukong/shopline csv:sample /tmp/sample-shopline.csv`
Expected: `wrote /tmp/sample-shopline.csv`, and the file's first line is the 15-column
header beginning `SKU,English Title,Traditional Chinese Title,Price`.

- [ ] **Step 4: Verify the whole package still builds**

Run: `npx tsc -p packages/shopline/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/shopline/src/cli/sample-csv.ts packages/shopline/package.json
git commit -m "feat: emit a sample SHOPLINE CSV for spec validation"
```

---

### Task 6: Gates before opening the PR

- [ ] **Step 1: Full web and package suites**

Run: `cd apps/web && npx vitest run` — expected: all pass.
Run: `npx vitest run --root packages/assets` and `npx vitest run --root packages/shopline` — expected: all pass.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit` — expected: no output.

- [ ] **Step 3: Format gate**

Run: `node scripts/check-runtime-format.mjs`
Expected: `hash-pinned format debt waived: 0` and no "requiring Prettier" list. If a file
you touched is listed, run `npx prettier --write` on it. If it was hash-pinned, remove
its entry from **all three** mirrors — `scripts/check-runtime-format.mjs`,
`tests/ci-workflow.test.mjs`, and `docs/runbooks/production-ai-runtime.md` — then
re-run `node --test tests/ci-workflow.test.mjs tests/cloudflare-config.test.mjs`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
gh pr create --repo YNWAforever/wukong-ecommerce-os --base main --fill
```

---

## Track 1 — operator checklist (no code)

- [ ] Run `pnpm --filter @wukong/shopline csv:sample /tmp/sample-shopline.csv`
- [ ] Import that file into Opak's SHOPLINE store
- [ ] Confirm all 15 columns land in the right fields, both `en` and `zh-hant` present
- [ ] Confirm the product is **unpublished** (`status: false` should ensure this)
- [ ] Delete the sample product
- [ ] If any column is wrong, that is a `packages/shopline` code change and a new
      `SHOPLINE_CSV_SPEC_VERSION` — stop and re-plan rather than patching ad hoc

## Track 2 — deploy the Worker (no code)

- [ ] Create queues `wukong-listing-production`, `wukong-listing-dlq-production`,
      `wukong-shopline-production`, `wukong-shopline-dlq-production`
- [ ] Create the Hyperdrive config against Neon; keep the printed id
- [ ] Set the five Worker secrets: `QUEUE_INGRESS_SECRET`, `OPENAI_API_KEY`,
      `SHOPLINE_TOKEN_ENCRYPTION_KEY` (placeholder), `S3_ACCESS_KEY_ID`,
      `S3_SECRET_ACCESS_KEY`
- [ ] `pnpm --filter @wukong/worker deploy:production` with the nine render inputs
- [ ] Set `QUEUE_INGRESS_URL` and `QUEUE_INGRESS_SECRET` in Vercel production, redeploy

## Track 3 — the end-to-end run (no code)

- [ ] One real wine: photo → AI draft → review → approve → export CSV
- [ ] Confirm the CSV's image URLs still resolve after sitting for an hour
- [ ] Import into Opak's store, verify against the Track 1 checklist
- [ ] Delete the product
