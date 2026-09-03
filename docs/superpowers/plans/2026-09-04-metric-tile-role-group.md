# Metric Tile `role="group"` Accessibility Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `role="group"` + `aria-labelledby` (via `useId()`) to every metric tile in `catalog-control-center.tsx`, `dashboard-listings-client.tsx`, and `quality-summary-client.tsx`, so each value/label pair is programmatically associated for assistive technology.

**Architecture:** Three small, independent files, each fixed identically (same pattern, no shared refactor). One task per file — read, TDD the new assertion, implement, commit — followed by one final combined-verification task.

**Tech Stack:** React 19 (`useId`), Vitest + `happy-dom`, plain `react-dom` test-utils (no React Testing Library in this codebase).

---

**Live-code discipline:** every file:line reference below was verified against the live checkout during this session's design/research pass (2026-09-04). Even so, **each task's first step is always "read the current file"** — treat quoted code as a starting point to diff against, not a guarantee.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for every command, e.g. `corepack pnpm exec vitest run <path>`.

**Testing convention (confirmed real across all 3 files):** `// @vitest-environment happy-dom` pragma; `act`/`createElement` from `react`; `createRoot`/`Root` from `react-dom/client`; a local `mount`-style helper that creates a container div, appends it to `document.body`, creates a root, renders inside `act()`, returns `{ container, root }`; a paired `unmount(root)` helper. DOM assertions use plain `container.querySelector`/`querySelectorAll` — **not** React Testing Library's `getByRole`, which isn't installed here. For the new `role="group"` assertions: `container.querySelectorAll('[role="group"]')`, then for each element read its `aria-labelledby` attribute and resolve it via `document.getElementById(id)` (or `container.querySelector(`#${id}`)`), then assert on that resolved element's `textContent`.

---

## Task 1: `catalog-control-center.tsx`

**Files:**
- Modify: `apps/web/components/catalog-control-center.tsx`
- Modify: `apps/web/components/catalog-control-center.test.tsx`

- [ ] **Step 1: Read the current files**

Read `apps/web/components/catalog-control-center.tsx` in full and confirm the `Metric` sub-component (around lines 272-279) and its 5 call sites (around lines 113-125) still match:

```tsx
function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  );
}
```

```tsx
    <section aria-label="商品控制中心">
      <div className={styles.metrics}>
        <Metric value={response.summary.total} label="商品 Products" />
        <Metric value={response.summary.linked} label="已連結 Linked" />
        <Metric
          value={response.summary.needsReview}
          label="待審核 Needs review"
        />
        <Metric
          value={response.summary.needsAttention}
          label="需處理 Attention"
        />
        <Metric value={response.summary.published} label="已發佈 Published" />
      </div>
```

Confirm line 4's import is still `import { useEffect, useState } from "react";`.

Read `apps/web/components/catalog-control-center.test.tsx` in full and confirm the `pageResponse(items, overrides?)` helper (around lines 72-91) still matches:

```ts
function pageResponse(
  items: CatalogItem[],
  overrides: Partial<CatalogPage> = {},
): CatalogPage {
  return {
    items,
    summary: {
      total: 60,
      linked: 10,
      unlinked: 50,
      needsReview: 2,
      needsAttention: 5,
      published: 3,
    },
    page: 1,
    pageSize: 25,
    totalMatching: 60,
    ...overrides,
  };
}
```

and the `mount(fetcher)`/`unmount(root)` helper pair (around lines 13-31) still matches:

```ts
async function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(CatalogControlCenter));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
}
```

- [ ] **Step 2: Write the failing test**

Add this test to the `describe("CatalogControlCenter", ...)` block (or the top-level `describe` this file actually uses — match the real file's structure):

```ts
it("exposes each metric tile as a role=\"group\" tied to its visible label", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(pageResponse([])));

  const { container, root } = await mount(fetcher);

  const tiles = container.querySelectorAll('[role="group"]');
  expect(tiles.length).toBe(5);

  const expectedLabels = [
    "商品 Products",
    "已連結 Linked",
    "待審核 Needs review",
    "需處理 Attention",
    "已發佈 Published",
  ];

  tiles.forEach((tile, index) => {
    const labelledBy = tile.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    const labelElement = document.getElementById(labelledBy!);
    expect(labelElement?.textContent).toBe(expectedLabels[index]);
  });

  await unmount(root);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/web/components/catalog-control-center.test.tsx`
Expected: FAIL — `tiles.length` is `0` (no element has `role="group"` yet).

- [ ] **Step 4: Implement the fix**

Change the import on line 4 from:

```ts
import { useEffect, useState } from "react";
```

to:

```ts
import { useEffect, useId, useState } from "react";
```

Change the `Metric` sub-component from:

```tsx
function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  );
}
```

to:

```tsx
function Metric({ value, label }: { value: number; label: string }) {
  const labelId = useId();
  return (
    <div className={styles.metric} role="group" aria-labelledby={labelId}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.metricLabel} id={labelId}>
        {label}
      </span>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm exec vitest run apps/web/components/catalog-control-center.test.tsx`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/catalog-control-center.tsx apps/web/components/catalog-control-center.test.tsx
git commit -m "fix: expose catalog metric tiles as role=\"group\" for assistive tech"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 2: `dashboard-listings-client.tsx`

**Files:**
- Modify: `apps/web/components/dashboard-listings-client.tsx`
- Modify: `apps/web/components/dashboard-listings-client.test.ts`

- [ ] **Step 1: Read the current files**

Read `apps/web/components/dashboard-listings-client.tsx` in full and confirm: line 3's import is still `import { useEffect, useState } from "react";`; the component has `if (error) return (...)` and `if (!data) return (...)` early-return branches (around lines 100-108) **before** the metric-strip JSX (around lines 117-136), which still matches:

```tsx
      <div className="metric-strip" aria-label="工作台摘要">
        <div>
          <span className="metric-value">{metrics.active}</span>
          <span className="metric-label">
            進行中 <small>Active</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.inReview}</span>
          <span className="metric-label">
            待你審核 <small>Needs review</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.blocked}</span>
          <span className="metric-label">
            阻塞上架 <small>Blocked delivery</small>
          </span>
        </div>
      </div>
```

This early-return-before-metrics ordering matters: any new `useId()` calls must go at the **top** of the component function (alongside the existing `useState`/`useEffect` calls), not immediately before this JSX block. If they were placed after the early returns, they'd be skipped entirely on the error/loading renders and only called on the loaded render — a hook-count mismatch across renders of the same mounted instance, which violates React's Rules of Hooks and throws "Rendered fewer hooks than expected" when the component transitions from loading to loaded.

Read `apps/web/components/dashboard-listings-client.test.ts` in full (note: `.ts`, not `.tsx`) and confirm the existing test around lines 157-186 still matches:

```ts
describe("DashboardListingsClient", () => {
  it("computes the metric strip from response.counts, not from the items array", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [baseItem],
        counts: {
          ...zeroCounts,
          received: 40,
          in_review: 5,
          reopened: 1,
          failed: 2,
          publish_failed: 1,
          published: 100,
        },
      }),
    );

    const { container, root } = await mount(fetcher);

    const values = Array.from(container.querySelectorAll(".metric-value")).map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["49", "6", "3"]);

    await unmount(root);
  });
```

`zeroCounts` and `baseItem` fixtures already exist near the top of this file (around lines 40-61) — reuse them as-is.

- [ ] **Step 2: Write the failing test**

Add this as a new test inside the `describe("DashboardListingsClient", ...)` block, immediately after the existing "computes the metric strip..." test:

```ts
  it('exposes each metric tile as a role="group" tied to its visible label', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        items: [baseItem],
        counts: {
          ...zeroCounts,
          received: 40,
          in_review: 5,
          reopened: 1,
          failed: 2,
          publish_failed: 1,
          published: 100,
        },
      }),
    );

    const { container, root } = await mount(fetcher);

    const tiles = container.querySelectorAll('[role="group"]');
    expect(tiles.length).toBe(3);

    const expectedSubstrings = ["進行中", "待你審核", "阻塞上架"];

    tiles.forEach((tile, index) => {
      const labelledBy = tile.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      const labelElement = document.getElementById(labelledBy!);
      expect(labelElement?.textContent).toContain(expectedSubstrings[index]);
    });

    await unmount(root);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/web/components/dashboard-listings-client.test.ts`
Expected: FAIL — `tiles.length` is `0`.

- [ ] **Step 4: Implement the fix**

Change line 3's import from:

```ts
import { useEffect, useState } from "react";
```

to:

```ts
import { useEffect, useId, useState } from "react";
```

At the top of the component function, alongside the existing `useState` declarations and before the `useEffect` call, add:

```tsx
  const activeLabelId = useId();
  const inReviewLabelId = useId();
  const blockedLabelId = useId();
```

(Read the actual current top-of-function structure first and place these wherever fits naturally alongside the other hooks — the exact insertion point depends on the real current code, which may differ slightly from what this plan assumed.)

Change the metric-strip JSX from:

```tsx
      <div className="metric-strip" aria-label="工作台摘要">
        <div>
          <span className="metric-value">{metrics.active}</span>
          <span className="metric-label">
            進行中 <small>Active</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.inReview}</span>
          <span className="metric-label">
            待你審核 <small>Needs review</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{metrics.blocked}</span>
          <span className="metric-label">
            阻塞上架 <small>Blocked delivery</small>
          </span>
        </div>
      </div>
```

to:

```tsx
      <div className="metric-strip" aria-label="工作台摘要">
        <div role="group" aria-labelledby={activeLabelId}>
          <span className="metric-value">{metrics.active}</span>
          <span className="metric-label" id={activeLabelId}>
            進行中 <small>Active</small>
          </span>
        </div>
        <div role="group" aria-labelledby={inReviewLabelId}>
          <span className="metric-value">{metrics.inReview}</span>
          <span className="metric-label" id={inReviewLabelId}>
            待你審核 <small>Needs review</small>
          </span>
        </div>
        <div role="group" aria-labelledby={blockedLabelId}>
          <span className="metric-value">{metrics.blocked}</span>
          <span className="metric-label" id={blockedLabelId}>
            阻塞上架 <small>Blocked delivery</small>
          </span>
        </div>
      </div>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm exec vitest run apps/web/components/dashboard-listings-client.test.ts`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/dashboard-listings-client.tsx apps/web/components/dashboard-listings-client.test.ts
git commit -m "fix: expose dashboard metric tiles as role=\"group\" for assistive tech"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 3: `quality-summary-client.tsx`

**Files:**
- Modify: `apps/web/components/quality-summary-client.tsx`
- Modify: `apps/web/components/quality-summary-client.test.tsx`

- [ ] **Step 1: Read the current files**

Read `apps/web/components/quality-summary-client.tsx` in full and confirm: line 3's import is still `import { useEffect, useState } from "react";`; the component has `if (error) return (...)` and `if (!data) return (...)` early-return branches (around lines 74-82) **before** the metric-strip JSX (around lines 90-115) — same hook-ordering constraint as Task 2 applies, for the same reason. Confirm the metric-strip JSX still matches:

```tsx
      <div
        className="metric-strip quality-metric-strip"
        aria-label="內容品質統計"
      >
        <div>
          <span className="metric-value">{data.totalAssessed}</span>
          <span className="metric-label">
            已評估商品 <small>Total assessed</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{data.cleanCount}</span>
          <span className="metric-label">
            無缺口 <small>Clean</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{data.hasGapsCount}</span>
          <span className="metric-label">
            有缺口 <small>Has gaps</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{formatUsd(data.totalCostUsd)}</span>
          <span className="metric-label">
            AI 總成本 <small>Total AI cost</small>
          </span>
        </div>
      </div>
```

Read `apps/web/components/quality-summary-client.test.tsx` in full and confirm: the `SAMPLE_SUMMARY` fixture (around lines 47-60) still matches `{ totalAssessed: 42, cleanCount: 10, hasGapsCount: 32, gapCounts: {...}, totalCostUsd: 12.5 }`; `stubFetch(body, status?)` (around lines 36-45) and `mountClient()` (around lines 22-34) are **separate** helpers — `stubFetch` is called first, then `mountClient()` with **no** arguments (different signature than Task 1/2's `mount(fetcher)`); the existing test "fetches /api/quality and renders 4 stat tiles with correct values" (around lines 71-85) still matches:

```ts
  it("fetches /api/quality and renders 4 stat tiles with correct values", async () => {
    const fetcher = stubFetch(SAMPLE_SUMMARY);

    const { container } = await mountClient();

    expect(fetcher).toHaveBeenCalledWith(
      "/api/quality",
      expect.objectContaining({ cache: "no-store" }),
    );

    const tiles = container.querySelectorAll(".metric-value");
    expect(tiles.length).toBe(4);
    const tileText = Array.from(tiles).map((tile) => tile.textContent);
    expect(tileText).toEqual(["42", "10", "32", "$12.50"]);
  });
```

- [ ] **Step 2: Write the failing test**

Add this as a new test inside the `describe("QualitySummaryClient", ...)` block, immediately after the existing "fetches /api/quality..." test:

```ts
  it('exposes each metric tile as a role="group" tied to its visible label', async () => {
    stubFetch(SAMPLE_SUMMARY);

    const { container } = await mountClient();

    const tiles = container.querySelectorAll('[role="group"]');
    expect(tiles.length).toBe(4);

    const expectedSubstrings = ["已評估商品", "無缺口", "有缺口", "AI 總成本"];

    tiles.forEach((tile, index) => {
      const labelledBy = tile.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      const labelElement = document.getElementById(labelledBy!);
      expect(labelElement?.textContent).toContain(expectedSubstrings[index]);
    });
  });
```

Note: unlike Task 1/2's tests, this file's `afterEach` (already present, around lines 63-69) handles unmounting for every test automatically — do not add a manual `unmount()` call here, matching this file's own established convention (its existing tests don't call one either).

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm exec vitest run apps/web/components/quality-summary-client.test.tsx`
Expected: FAIL — `tiles.length` is `0`.

- [ ] **Step 4: Implement the fix**

Change line 3's import from:

```ts
import { useEffect, useState } from "react";
```

to:

```ts
import { useEffect, useId, useState } from "react";
```

At the top of the component function, alongside the existing `useState` declarations and before the `useEffect` call, add:

```tsx
  const totalAssessedLabelId = useId();
  const cleanLabelId = useId();
  const hasGapsLabelId = useId();
  const totalCostLabelId = useId();
```

(Read the actual current top-of-function structure first and place these wherever fits naturally alongside the other hooks.)

Change the metric-strip JSX from:

```tsx
      <div
        className="metric-strip quality-metric-strip"
        aria-label="內容品質統計"
      >
        <div>
          <span className="metric-value">{data.totalAssessed}</span>
          <span className="metric-label">
            已評估商品 <small>Total assessed</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{data.cleanCount}</span>
          <span className="metric-label">
            無缺口 <small>Clean</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{data.hasGapsCount}</span>
          <span className="metric-label">
            有缺口 <small>Has gaps</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{formatUsd(data.totalCostUsd)}</span>
          <span className="metric-label">
            AI 總成本 <small>Total AI cost</small>
          </span>
        </div>
      </div>
```

to:

```tsx
      <div
        className="metric-strip quality-metric-strip"
        aria-label="內容品質統計"
      >
        <div role="group" aria-labelledby={totalAssessedLabelId}>
          <span className="metric-value">{data.totalAssessed}</span>
          <span className="metric-label" id={totalAssessedLabelId}>
            已評估商品 <small>Total assessed</small>
          </span>
        </div>
        <div role="group" aria-labelledby={cleanLabelId}>
          <span className="metric-value">{data.cleanCount}</span>
          <span className="metric-label" id={cleanLabelId}>
            無缺口 <small>Clean</small>
          </span>
        </div>
        <div role="group" aria-labelledby={hasGapsLabelId}>
          <span className="metric-value">{data.hasGapsCount}</span>
          <span className="metric-label" id={hasGapsLabelId}>
            有缺口 <small>Has gaps</small>
          </span>
        </div>
        <div role="group" aria-labelledby={totalCostLabelId}>
          <span className="metric-value">{formatUsd(data.totalCostUsd)}</span>
          <span className="metric-label" id={totalCostLabelId}>
            AI 總成本 <small>Total AI cost</small>
          </span>
        </div>
      </div>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm exec vitest run apps/web/components/quality-summary-client.test.tsx`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/quality-summary-client.tsx apps/web/components/quality-summary-client.test.tsx
git commit -m "fix: expose quality metric tiles as role=\"group\" for assistive tech"
```
(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all 3 test files together**

```bash
corepack pnpm exec vitest run apps/web/components/catalog-control-center.test.tsx apps/web/components/dashboard-listings-client.test.ts apps/web/components/quality-summary-client.test.tsx
```

Expected: all PASS, zero failures across all three files.

- [ ] **Step 2: Typecheck**

```bash
corepack pnpm --filter @wukong/web typecheck
```

Expected: exit 0, clean.

- [ ] **Step 3: Format check**

```bash
node scripts/check-runtime-format.mjs
```

If any of the 6 touched files is listed, run `corepack pnpm exec prettier --write <file>` on it and commit that separately as a small `style:` follow-up commit.

- [ ] **Step 4: Report status**

Do not push or open a pull request — stop here and report back with the full verification checklist's results (Steps 1-3), matching how every prior package/fix this session was handed back for the user's own review/merge.
