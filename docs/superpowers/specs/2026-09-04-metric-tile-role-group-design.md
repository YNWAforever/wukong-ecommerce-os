# Metric Tile `role="group"` Accessibility Fix — Design

**Date:** 2026-09-04
**Status:** Approved (brainstorming), pending implementation plan
**Origin:** flagged during Package J's accessibility hardening work but not fixed then; picked up as a follow-up item this session and re-verified against the live `claude/integrate-packages-h-i` branch before this design was written.

## 1. What this fixes

Three components render "metric tiles" — a numeric value paired with a text label, e.g. `3` above `進行中 Active` — as plain `<div>`s wrapping a value `<span>` and a label `<span>`, with no programmatic association between the two (WCAG 2.2 SC 1.3.1, Info and Relationships). A sighted user sees the visual grouping; a screen reader user gets two unrelated pieces of text in sequence with nothing tying "3" to "Active" specifically.

## 2. Current state (verified against `claude/integrate-packages-h-i`)

- **`apps/web/components/catalog-control-center.tsx`** (lines 272-279) — a reusable `Metric({ value, label })` sub-component, instantiated 5 times:
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
- **`apps/web/components/dashboard-listings-client.tsx`** (lines ~117-136) — 3 tiles, each an inline bare `<div>` (no shared component), inside a `.metric-strip` wrapper that itself has a coarse `aria-label="工作台摘要"` covering the whole strip, not per-tile.
- **`apps/web/components/quality-summary-client.tsx`** (lines ~90-115) — 4 tiles, same inline bare-`<div>` pattern as above, inside its own `.metric-strip`-classed wrapper with `aria-label="內容品質統計"`.

Confirmed via `git grep`/direct reads: no existing test in any of the three components' test files asserts on the _absence_ of `role="group"`, so adding it is purely additive. `quality-summary-client.test.tsx`'s one existing markup-shape assertion (`container.querySelectorAll(".metric-value")`, line 81) is unaffected — it queries the value span's class, not the wrapping div's attributes.

## 3. The fix — identical pattern in all 3 files, no refactor

For each individual tile: give the label `<span>` a unique `id` via React's `useId()` hook, and add `role="group" aria-labelledby={thatId}` to the wrapping `<div>`. This is the standard WCAG technique for exposing a visually-grouped value+label pair to assistive technology without duplicating the label text into a separate `aria-label` string (which would also go stale if the label copy changes in only one place).

- **`catalog-control-center.tsx`** — trivial: one `useId()` call inside `Metric()` itself, since it's already a proper per-instance component. No change needed elsewhere.
- **`dashboard-listings-client.tsx`** (3 tiles) and **`quality-summary-client.tsx`** (4 tiles) — a fixed, small number of `useId()` calls (matching each file's fixed, hardcoded tile count — neither file maps over a dynamic list to render these) added at the **top** of the component function, alongside the existing `useState`/`useEffect` calls, **before** the `if (error) return ...` / `if (!data) return ...` early-return branches both files already have. This ordering is required, not stylistic: if the `useId()` calls were placed later (e.g. immediately before the metrics JSX, after the early returns), they would be skipped entirely on error/loading renders and called only on the loaded render — a hook-count mismatch across renders of the same mounted instance, which is exactly what React's Rules of Hooks forbid and would throw on ("Rendered fewer hooks than expected").

No refactor into a shared tile component for the two files that lack one — deliberately, per explicit scope decision: this stays a minimal, targeted accessibility fix, not a dedup pass.

## 4. Testing plan

For each of the 3 components' existing test files, add a test (or extend an existing rendering test) confirming, per tile:

- The wrapping element has `role="group"`.
- Its `aria-labelledby` attribute resolves to an element (via `getElementById` or Testing Library's `getByRole("group", { name: ... })`, whichever matches each file's existing query style) whose text content matches that tile's visible label.

All pre-existing tests in all 3 files and their siblings (`dashboard-listings-client.test.tsx`, `catalog-control-center.test.tsx`, `quality-summary-client.test.tsx`) must continue passing unmodified.

## 5. Explicitly out of scope

- Extracting a shared tile component for `dashboard-listings-client.tsx`/`quality-summary-client.tsx` (§3's explicit scope decision).
- Any change to the coarse strip-level `aria-label`s (`工作台摘要`, `內容品質統計`) — those remain as they are; they label the strip as a whole, which is a separate, already-adequate concern from per-tile grouping.
- Any other accessibility gap in these or other components not specifically about metric-tile value/label association.

## 6. Self-review

- **Placeholder scan:** none — every file, line range, and the exact hook-ordering constraint are specified concretely.
- **Internal consistency:** §3's fix for each file is consistent with §2's documented current structure (a per-instance component for one file, inline fixed-count blocks for the other two).
- **Scope check:** small and focused — 3 files, one mechanical pattern applied identically, no application logic or visual changes.
- **Ambiguity check:** the one point with more than one reasonable resolution (minimal inline fix vs. extract-a-shared-component) was resolved explicitly with the user before this document was written.
