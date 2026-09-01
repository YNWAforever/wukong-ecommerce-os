# `/quality` (Gaps + Cost) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `/quality` page reporting 6 content-gap signals (per-listing boolean checks, aggregated to counts) and total AI enrichment cost, computed honestly from current listing content — not a stale import-time snapshot, and not excluding create-origin listings.

**Architecture:** A small adapter (`canonicalListingToGapsInput`) maps `CanonicalListing` onto the exact input shape the already-existing, already-tested `bulkFormGaps` function expects, so the same 6 checks now run against current content for every listing. A pure aggregation function (`computeQualitySummary`) turns per-listing gap results plus a cost total into the page's 4 tiles + 6-row table. One `GET /api/quality` route, one `/quality` page — mirrors the `/jobs` ledger's shape exactly.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, `@wukong/shopline`, `@wukong/db`.

---

## Environment note for every `Run:` step

`pnpm` is not reliably on PATH in this environment. Prefix every command with `corepack`:

```powershell
corepack pnpm --filter @wukong/web test -- <file>
```

Do **not** use an `$env:PATH = "...scratchpad\bin..."` prefix — that shim directory is empty this session. `corepack pnpm` is the confirmed-working form. If `corepack pnpm typecheck`/`test` (turbo-orchestrated) hits `Unable to find package manager binary`, run `corepack enable --install-directory <a scratch dir>` and prepend that directory to PATH for the rest of that session's commands.

---

### Task 1: `canonicalListingToGapsInput` — the adapter

**Files:**
- Create: `apps/web/lib/canonical-listing-gaps.ts`
- Create: `apps/web/lib/canonical-listing-gaps.test.ts`

- [ ] **Step 1: Read the exact types this must bridge**

Read `packages/shopline/src/bulk-form.ts`'s `bulkFormGaps` function and `BulkFormGapsInput`/`BulkFormContentGaps` types (already known: `BulkFormGapsInput = Readonly<Partial<Record<BulkFormColumnKey, string | null>>>`; `bulkFormGaps` reads exactly `nameEn`, `nameZh`, `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `summaryEn`, `summaryZh`, `seoKeywords` off it — no other keys are read, so a partial object with just these 8 keys is sufficient input). Both are exported from `@wukong/shopline`. Read `packages/core/src/listing-schema.ts`'s `CanonicalListing` type in full — confirm which of the schema blocks in that file is the actual exported `CanonicalListing` (there are two similar-looking blocks in the file; only one is the canonical, exported type used by `ListingSummary.activeVersion.content` elsewhere in the codebase — verify by checking what `packages/db/src/repositories/listings.ts` imports and cross-referencing the exact export name). Confirm `localizedTextSchema`'s exact shape (expected `{en: string, "zh-Hant": string}`) and whether its string fields can validly be empty (`.min(1)` or similar) — this determines whether `bulkFormGaps`'s `?? null` (nullish-coalescing, not empty-string-coalescing) handling needs any adjustment in the adapter.

- [ ] **Step 2: Write the failing test**

Create `apps/web/lib/canonical-listing-gaps.test.ts`:

```ts
import { bulkFormGaps } from "@wukong/shopline";
import { describe, expect, it } from "vitest";

import { canonicalListingToGapsInput } from "./canonical-listing-gaps.js";

function contentFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: { en: "Demo Wine", "zh-Hant": "示範美酒" },
    description: { en: "A fine wine.", "zh-Hant": "一款好酒。" },
    seo: {
      title: { en: "Demo Wine | Shop", "zh-Hant": "示範美酒 | 商店" },
      description: { en: "Buy Demo Wine today.", "zh-Hant": "立即購買示範美酒。" },
    },
    tags: ["wine", "demo"],
    ...overrides,
  };
}

describe("canonicalListingToGapsInput + bulkFormGaps", () => {
  it("reports no gaps for fully-translated, non-mirroring content", () => {
    const gaps = bulkFormGaps(canonicalListingToGapsInput(contentFor()));
    expect(gaps).toEqual({
      untranslatedName: false,
      untranslatedSeoTitle: false,
      seoTitleMirrorsName: false,
      seoDescriptionMirrorsSeoTitle: false,
      keywordsMirrorName: false,
      summaryMissing: false,
    });
  });

  it("flags untranslatedName when English and Traditional Chinese titles match", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({ title: { en: "Demo Wine", "zh-Hant": "Demo Wine" } }),
      ),
    );
    expect(gaps.untranslatedName).toBe(true);
  });

  it("flags seoTitleMirrorsName when the SEO title equals the product name", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({
          seo: {
            title: { en: "Demo Wine", "zh-Hant": "示範美酒" },
            description: { en: "Buy Demo Wine today.", "zh-Hant": "立即購買示範美酒。" },
          },
        }),
      ),
    );
    expect(gaps.seoTitleMirrorsName).toBe(true);
  });

  it("joins tags with a comma for the keywords field", () => {
    const input = canonicalListingToGapsInput(contentFor({ tags: ["a", "b", "c"] }));
    expect(input.seoKeywords).toBe("a, b, c");
  });

  it("flags keywordsMirrorName when the joined tags equal the English name", () => {
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(
        contentFor({ title: { en: "wine, demo", "zh-Hant": "示範美酒" }, tags: ["wine", "demo"] }),
      ),
    );
    expect(gaps.keywordsMirrorName).toBe(true);
  });
});
```

If Step 1 found that `localizedTextSchema`'s fields cannot be empty strings (validated non-empty), drop any test case that relied on an empty-string scenario — do not write a test asserting behavior the schema makes unreachable. If the summary-missing check turns out to be unreachable in practice too (both locales always non-empty per schema), note that in a comment on the adapter rather than testing an impossible case.

- [ ] **Step 3: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- canonical-listing-gaps.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/lib/canonical-listing-gaps.ts`:

```ts
import type { CanonicalListing } from "@wukong/core";
import type { BulkFormGapsInput } from "@wukong/shopline";

/**
 * Maps a listing's current content onto the exact input shape
 * `bulkFormGaps` (packages/shopline/src/bulk-form.ts) already expects,
 * reusing its 6 gap checks unmodified against LIVE content instead of the
 * frozen platform_products.rawRow snapshot it's normally fed with -- see
 * the design doc at docs/superpowers/specs/2026-09-01-quality-gaps-cost-design.md
 * for why the checks themselves are correct and only the input source
 * needed to change.
 */
export function canonicalListingToGapsInput(
  content: CanonicalListing,
): BulkFormGapsInput {
  return {
    nameEn: content.title.en,
    nameZh: content.title["zh-Hant"],
    seoTitleEn: content.seo.title.en,
    seoTitleZh: content.seo.title["zh-Hant"],
    seoDescriptionEn: content.seo.description.en,
    summaryEn: content.description.en,
    summaryZh: content.description["zh-Hant"],
    seoKeywords: content.tags.join(", "),
  };
}
```

Adjust the exact import path/name for `CanonicalListing` to match whatever Step 1 confirmed is the real exported type name and source module (it may not be `@wukong/core`'s top-level export — verify against `packages/core/src/index.ts`).

- [ ] **Step 5: Run tests to verify they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- canonical-listing-gaps.test.ts
```
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/canonical-listing-gaps.ts apps/web/lib/canonical-listing-gaps.test.ts
git commit -m "feat: add canonicalListingToGapsInput, reusing bulkFormGaps against live content"
```

---

### Task 2: `computeQualitySummary` — the pure aggregation function

**Files:**
- Create: `apps/web/lib/quality-summary.ts`
- Create: `apps/web/lib/quality-summary.test.ts`

- [ ] **Step 1: Confirm the exact input/output shapes**

Re-read Task 1's `canonicalListingToGapsInput`/`bulkFormGaps` output (`BulkFormContentGaps`, already known: `{untranslatedName, untranslatedSeoTitle, seoTitleMirrorsName, seoDescriptionMirrorsSeoTitle, keywordsMirrorName, summaryMissing}`, all `boolean`). Read `packages/db/src/repositories/listings.ts`'s `ListingSummary` type in full (already known: `activeVersion: {id, content} | null` — can be `null` for a listing with no active version yet; **must be excluded from the assessed total**, not treated as a listing with zero gaps).

- [ ] **Step 2: Write the failing tests**

Create `apps/web/lib/quality-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { computeQualitySummary } from "./quality-summary.js";

function listingWith(content: unknown) {
  return { id: "l1", activeVersion: content ? { id: "v1", content } : null };
}

function cleanContent() {
  return {
    title: { en: "A", "zh-Hant": "甲" },
    description: { en: "desc", "zh-Hant": "描述" },
    seo: {
      title: { en: "seo title", "zh-Hant": "seo 標題" },
      description: { en: "seo desc", "zh-Hant": "seo 描述" },
    },
    tags: ["tag1"],
  };
}

describe("computeQualitySummary", () => {
  it("counts a listing with no gaps as clean", () => {
    const summary = computeQualitySummary([listingWith(cleanContent())], 0);
    expect(summary.totalAssessed).toBe(1);
    expect(summary.cleanCount).toBe(1);
    expect(summary.hasGapsCount).toBe(0);
  });

  it("counts a listing with at least one gap as has-gaps, and tallies the specific signal", () => {
    const summary = computeQualitySummary(
      [listingWith({ ...cleanContent(), title: { en: "A", "zh-Hant": "A" } })],
      0,
    );
    expect(summary.hasGapsCount).toBe(1);
    expect(summary.cleanCount).toBe(0);
    expect(summary.gapCounts.untranslatedName).toBe(1);
    expect(summary.gapCounts.seoTitleMirrorsName).toBe(0);
  });

  it("excludes a listing with no active version from the assessed total", () => {
    const summary = computeQualitySummary([listingWith(null)], 0);
    expect(summary.totalAssessed).toBe(0);
    expect(summary.cleanCount).toBe(0);
    expect(summary.hasGapsCount).toBe(0);
  });

  it("passes through the total cost unchanged", () => {
    const summary = computeQualitySummary([listingWith(cleanContent())], 12.5);
    expect(summary.totalCostUsd).toBe(12.5);
  });

  it("tallies gap counts across multiple listings independently", () => {
    const summary = computeQualitySummary(
      [
        listingWith(cleanContent()),
        listingWith({ ...cleanContent(), title: { en: "A", "zh-Hant": "A" } }),
        listingWith({
          ...cleanContent(),
          seo: {
            title: { en: "A", "zh-Hant": "seo 標題" },
            description: { en: "seo desc", "zh-Hant": "seo 描述" },
          },
        }),
      ],
      0,
    );
    expect(summary.totalAssessed).toBe(3);
    expect(summary.cleanCount).toBe(1);
    expect(summary.hasGapsCount).toBe(2);
    expect(summary.gapCounts.untranslatedName).toBe(1);
    expect(summary.gapCounts.seoTitleMirrorsName).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- quality-summary.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/lib/quality-summary.ts`:

```ts
import { bulkFormGaps, type BulkFormContentGaps } from "@wukong/shopline";
import type { CanonicalListing } from "@wukong/core";

import { canonicalListingToGapsInput } from "./canonical-listing-gaps.js";

export type QualityAssessedListing = {
  id: string;
  activeVersion: { id: string; content: CanonicalListing } | null;
};

export type QualitySummary = {
  totalAssessed: number;
  cleanCount: number;
  hasGapsCount: number;
  gapCounts: Record<keyof BulkFormContentGaps, number>;
  totalCostUsd: number;
};

const EMPTY_GAP_COUNTS: Record<keyof BulkFormContentGaps, number> = {
  untranslatedName: 0,
  untranslatedSeoTitle: 0,
  seoTitleMirrorsName: 0,
  seoDescriptionMirrorsSeoTitle: 0,
  keywordsMirrorName: 0,
  summaryMissing: 0,
};

export function computeQualitySummary(
  listings: readonly QualityAssessedListing[],
  totalCostUsd: number,
): QualitySummary {
  const gapCounts = { ...EMPTY_GAP_COUNTS };
  let cleanCount = 0;
  let hasGapsCount = 0;
  let totalAssessed = 0;

  for (const listing of listings) {
    if (!listing.activeVersion) continue;
    totalAssessed += 1;
    const gaps = bulkFormGaps(
      canonicalListingToGapsInput(listing.activeVersion.content),
    );
    const gapKeys = Object.keys(gaps) as (keyof BulkFormContentGaps)[];
    const hasAnyGap = gapKeys.some((key) => gaps[key]);
    if (hasAnyGap) {
      hasGapsCount += 1;
    } else {
      cleanCount += 1;
    }
    for (const key of gapKeys) {
      if (gaps[key]) gapCounts[key] += 1;
    }
  }

  return { totalAssessed, cleanCount, hasGapsCount, gapCounts, totalCostUsd };
}
```

Adjust the `CanonicalListing` import to match Task 1's confirmed real export path.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- quality-summary.test.ts
```
Expected: PASS, all 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/quality-summary.ts apps/web/lib/quality-summary.test.ts
git commit -m "feat: add computeQualitySummary, the pure gap+cost aggregation function"
```

---

### Task 3: `GET /api/quality` route

**Files:**
- Create: `apps/web/app/api/quality/route.ts`
- Create: `apps/web/app/api/quality/route.test.ts`

- [ ] **Step 1: Read the closest existing read-route precedent**

Read `apps/web/app/api/jobs/route.ts` in full (already known: no role gate beyond authentication, `db.forWorkspace(...)` fetching from repositories in parallel via `Promise.all`, builds a result via a pure function, returns `jsonResponse(200, {...})`; wrapped in `withRouteErrors`). This new route mirrors its shape closely. Also read `packages/db/src/repositories/listings.ts`'s real method for fetching a bounded recent set of listings with their active version content (confirm the exact method name and its default/max limit — do not assume a name or a limit value; use whatever the repository actually exposes) and `packages/db/src/repositories/ai-runs.ts`'s `sumCostForListings(listingIds: readonly string[]): Promise<number>` signature (already confirmed this session).

- [ ] **Step 2: Write the failing test**

Create `apps/web/app/api/quality/route.test.ts`, mirroring `apps/web/app/api/jobs/route.test.ts`'s fixture style (fake `db.forWorkspace`, fake `sessionContext`). Cover:
- Any authenticated member (viewer included) gets `200` with a `QualitySummary`-shaped body.
- An unauthenticated request gets `401` (matching `requireSessionContext`'s standard behavior).
- The listings-fetch repository method and `sumCostForListings` are both called, and `sumCostForListings` is called with exactly the ids of the listings the fetch returned (not an empty array, not some other id source).

- [ ] **Step 3: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- "apps/web/app/api/quality/route.test.ts"
```
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/app/api/quality/route.ts`. The handler:
1. `requireSessionContext(deps.sessionContext)` — no role gate (viewer+, matching `/api/jobs`).
2. Inside `db.forWorkspace(session.workspaceId, async (repositories) => { ... })`: fetch a bounded recent set of listings with active-version content using whatever real repository method Step 1 confirmed, then call `repositories.aiRuns.sumCostForListings(listings.map((l) => l.id))`.
3. Call `computeQualitySummary(listings, totalCostUsd)`.
4. Return `jsonResponse(200, summary)`.
5. Export the route factory as `createQualityHandler(deps)` and bind it at the bottom of the file (`export const GET = createQualityHandler({ ... })`), matching this codebase's ports-and-adapters convention used by every other route this session.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- "apps/web/app/api/quality/route.test.ts"
```
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/quality/route.ts" "apps/web/app/api/quality/route.test.ts"
git commit -m "feat: add GET /api/quality"
```

---

### Task 4: `/quality` page and nav link

**Files:**
- Create: `apps/web/app/(app)/quality/page.tsx`
- Create: `apps/web/components/quality-summary-client.tsx`
- Create: `apps/web/components/quality-summary-client.test.tsx`
- Modify: `apps/web/app/(app)/layout.tsx`

- [ ] **Step 1: Read the closest existing page + client-component pattern**

Read `apps/web/app/(app)/jobs/page.tsx` and `apps/web/components/jobs-ledger-client.tsx` in full (already known: server page with no role gate rendering a client component; the client component does `useEffect` + `fetch` with `AbortController` + try/catch + `response.ok` check, loading/error states). This new page and component mirror both closely — no client-side filtering needed here (unlike `/jobs`), since this page only shows aggregate tiles + a 6-row table, not a filterable list. Also read `apps/web/app/(app)/system-map/page.tsx` (already known, shown above) for the exact `page-wrap`/`page-header`/`eyebrow`/`lede` bilingual markup convention to reuse for this page's header. Grep `apps/web/app/globals.css` for any existing stat-tile CSS class (e.g. from `/dashboard` or `/catalog`) before inventing new class names — reuse what exists.

- [ ] **Step 2: Write the failing test**

Create `apps/web/components/quality-summary-client.test.tsx`. Cover:
- Renders the 4 stat tiles with correct values from a fake fetch response (`totalAssessed`, `cleanCount`, `hasGapsCount`, `totalCostUsd` formatted as a 2-decimal USD string).
- Renders the 6-row gap table with correct per-signal counts and human-readable labels (one row per key in `gapCounts`).
- A fetch error (rejected promise or non-ok response) renders a visible error state.
- The `AbortController` cleanup fires on unmount — mirror `jobs-ledger-client.test.tsx`'s own test for this, asserting `AbortSignal.aborted` becomes `true` directly (not a `console.error` spy for an "unmounted component" warning — this session already confirmed that assertion is not load-bearing under React 18+). Verify this test is genuinely load-bearing by temporarily removing the cleanup return from the effect, confirming the test fails, then restoring it and confirming the test passes.

- [ ] **Step 3: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- quality-summary-client.test.tsx
```
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/components/quality-summary-client.tsx`: `"use client"`, fetches `/api/quality` on mount with the same `AbortController` + try/catch + `response.ok` pattern `jobs-ledger-client.tsx` uses, renders 4 stat tiles (total assessed, clean, has-gaps, total cost) and a 6-row table (one row per gap signal with a human-readable label and its count), using whatever stat-tile CSS class Step 1 found (or the closest existing generic card/table classes if none exists — do not invent a parallel styling system).

Create `apps/web/app/(app)/quality/page.tsx`: server component, no role gate (matches `/jobs`/`/system-map`), renders `<QualitySummaryClient />` inside the page's heading/layout wrapper (mirror `system-map/page.tsx`'s exact wrapper markup, substituting quality-appropriate bilingual copy).

In `apps/web/app/(app)/layout.tsx`, add a nav link alongside the other unconditional links (not inside the `isAdmin` conditional — matches `/jobs`'s and `/system-map`'s placement), matching the exact bilingual pattern already used by every other link:
```tsx
<Link href="/quality">
  內容品質 <span>Quality</span>
</Link>
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- quality-summary-client.test.tsx
```
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/quality/page.tsx" apps/web/components/quality-summary-client.tsx apps/web/components/quality-summary-client.test.tsx "apps/web/app/(app)/layout.tsx"
git commit -m "feat: add the /quality page and nav link"
```

---

### Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run:
```powershell
corepack pnpm typecheck
```
Expected: PASS across every package.

- [ ] **Step 2: Format check**

Run:
```powershell
corepack pnpm format:runtime:check
```
Expected: PASS, or fix flagged files with `corepack pnpm exec prettier --write <files>` and re-check.

- [ ] **Step 3: Full unit suite**

Run:
```powershell
corepack pnpm test
```
Expected: PASS, all packages.

- [ ] **Step 4: Integration suite (requires live Postgres)**

Run:
```powershell
docker compose up -d postgres
corepack pnpm test:integration
```
This package adds no database tables and no repository changes — no new integration tests are expected. Run this step anyway to confirm no regression in the existing integration suite. If Postgres is unreachable, state that explicitly rather than reporting this step as passed.

- [ ] **Step 5: `pnpm runtime:forbidden:check`**

Run:
```powershell
corepack pnpm runtime:forbidden:check
```
Expected: PASS.

---

## Self-Review

**Spec coverage:** §2 (gap adapter) → Task 1. §3 (cost) + §4 (read model) → Tasks 2-3. §4 (page) → Task 4.

**Placeholder scan:** Task 1's Step 1/Step 4 and Task 3's Step 1/Step 4 each explicitly instruct the implementer to verify an exact name/shape against real code before trusting the sketch verbatim (the `CanonicalListing` export path, the listings-fetch method name/limit) — deliberate "read and confirm" instructions given known ambiguity in the source, not unresolved placeholders in the plan's own requirements.

**Type consistency:** `BulkFormContentGaps`/`BulkFormGapsInput` (Task 1, from `@wukong/shopline`) are the exact types `computeQualitySummary` (Task 2) consumes. `QualitySummary` (Task 2) is exactly what the route (Task 3) returns and the client component (Task 4) renders — no reshaping.

**Scope check:** one small adapter function, one pure aggregation function, one read endpoint, one page + one client component + one nav-link edit — comparable to the `/jobs` ledger's own scope, reusing two already-shipped functions (`bulkFormGaps`, `sumCostForListings`) unmodified.
