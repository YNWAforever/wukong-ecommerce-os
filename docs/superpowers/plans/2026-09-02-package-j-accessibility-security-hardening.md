# Package J — Accessibility, Responsive, Security and Performance Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 10 confirmed, real gaps from `docs/superpowers/specs/2026-09-02-package-j-accessibility-security-hardening-design.md`: 7 accessibility fixes, 1 security bound on XLSX decompression, and new per-listing activity traceability + observability metrics built on the existing audit event log.

**Architecture:** Small, independent edits to existing components/CSS for the accessibility group (Tasks 1-7). One new bounded-total-size check inside `packages/shopline`'s existing zip reader for the security group (Task 8). For observability (Tasks 9-18): a new read method on the audit repository (`findRelatedToListing`) plus two small per-listing lookups on the enrichment-batch and export-attempt repositories, composed by a new `apps/web/lib/listing-activity-service.ts` and surfaced as an "Activity" section on the existing `/listings/[id]` review page; two new `listing.review_conflict` audit-write call sites (the approve route's three rejection branches, and the export route's freshness-exclusion loop); one new aggregate audit write on bulk-form import completion; and two new aggregate query methods on the audit repository, surfaced as metric tiles on `/jobs`.

**Tech Stack:** Next.js 16 App Router (React 19), Drizzle ORM + `postgres` driver, Vitest (unit + `*.integration.test.ts` against live Postgres), plain CSS custom properties.

**Live-code discipline:** every file:line reference below was re-verified against the live checkout immediately before this plan was written (a 9-agent parallel re-verification pass, run after the design was finalized). Even so, **each task's first step is always "read the current file"** — treat the quoted code as a starting point to diff against, not a guarantee, since this is a long-running branch and other commits may land on it.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for every command, e.g. `corepack pnpm --filter @wukong/web test -- <file>`. Filter by package: `--filter @wukong/web` (apps/web), `--filter @wukong/db` (packages/db), `--filter @wukong/shopline` (packages/shopline). Integration tests (`*.integration.test.ts`) need live Postgres (`docker compose up -d postgres`) — if unavailable when a task reaches that step, say so explicitly rather than silently skipping it.

---

## Task 1: Skip link on auth routes

**Files:**
- Modify: `apps/web/components/auth-shell.tsx`
- Test: `apps/web/components/auth-shell.test.tsx`

- [ ] **Step 1: Read the current file**

Read `apps/web/components/auth-shell.tsx` in full and confirm the `<main>` element is still `<main className="auth-shell-card-wrap">{children}</main>` (currently line 117) with no preceding skip-link anchor.

- [ ] **Step 2: Write the failing test**

Add to `apps/web/components/auth-shell.test.tsx` (create the file if it doesn't already exist — check first; if it exists, add this as a new test alongside the existing ones and keep existing imports):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuthShell } from "./auth-shell";

describe("AuthShell skip link", () => {
  it("renders a skip link pointing at the main content region", () => {
    render(
      <AuthShell locale="en">
        <p>card content</p>
      </AuthShell>,
    );
    const skipLink = screen.getByRole("link", { name: /skip to content/i });
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(document.getElementById("main-content")).not.toBeNull();
  });
});
```

(If `AuthShell`'s real prop name for locale differs from `locale="en"` — check the top of `auth-shell.tsx` for its actual props type before writing this test, and match it exactly.)

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- auth-shell.test.tsx`
Expected: FAIL — no element with role "link" named /skip to content/i.

- [ ] **Step 4: Add the skip link and `id="main-content"`**

In `apps/web/components/auth-shell.tsx`, add the skip link as the first child inside the root `<div className="auth-shell">` (immediately before the `<aside>` that currently opens the file's markup), reusing the exact bilingual copy and class from `apps/web/app/(app)/layout.tsx:23-25`:

```tsx
<a className="skip-link" href="#main-content">
  跳到主要內容 <span>Skip to content</span>
</a>
```

Then change line 117 from:

```tsx
<main className="auth-shell-card-wrap">{children}</main>
```

to:

```tsx
<main id="main-content" className="auth-shell-card-wrap">
  {children}
</main>
```

No new CSS is needed — `.skip-link` and `.skip-link:focus` already exist at `apps/web/app/globals.css:71-84` and are shared globally.

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- auth-shell.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/auth-shell.tsx apps/web/components/auth-shell.test.tsx
git commit -m "feat: add a skip link to the auth shell"
```

---

## Task 2: Demote the auth-shell tagline from `<h1>` to `<p>`

**Files:**
- Modify: `apps/web/components/auth-shell.tsx`
- Test: `apps/web/components/auth-shell.test.tsx`

- [ ] **Step 1: Read the current file**

Confirm the tagline block still matches (currently `auth-shell.tsx:74-88`):

```tsx
<p className="auth-shell-eyebrow">
  {isZh
    ? "Evidence-first 商品目錄營運"
    : "Evidence-first catalog operations"}
</p>
<h1>
  {isZh
    ? "先核實證據，再批准內容。"
    : "Verify the evidence before approving the content."}
</h1>
<p>
  {isZh
    ? "Wukong 將來源檔、AI 建議、人手審批及 SHOPLINE 匯入證明分開管理，避免把已產生檔案誤當成已完成更新。"
    : "Wukong keeps source files, AI suggestions, human approval, and SHOPLINE import proof separate, so a generated file is never mistaken for a completed update."}
</p>
```

- [ ] **Step 2: Write the failing test**

Add to `apps/web/components/auth-shell.test.tsx`:

```tsx
describe("AuthShell heading structure", () => {
  it("renders exactly one h1, and it is the AuthForm heading passed as children, not the tagline", () => {
    render(
      <AuthShell locale="en">
        <h1 id="auth-title">Sign in</h1>
      </AuthShell>,
    );
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAttribute("id", "auth-title");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- auth-shell.test.tsx`
Expected: FAIL — 2 headings found (the tagline `<h1>` and the passed-in child `<h1 id="auth-title">`).

- [ ] **Step 4: Change the tagline element from `<h1>` to `<p>`**

Change:

```tsx
<h1>
  {isZh
    ? "先核實證據，再批准內容。"
    : "Verify the evidence before approving the content."}
</h1>
```

to:

```tsx
<p className="auth-shell-tagline">
  {isZh
    ? "先核實證據，再批准內容。"
    : "Verify the evidence before approving the content."}
</p>
```

Add a `.auth-shell-tagline` rule to `apps/web/app/globals.css`, immediately after the existing `.auth-shell-eyebrow` rule (`globals.css:1455-1462`), giving it the visual weight a demoted-from-h1 tagline needs (bold, larger than body text, since it previously inherited default `<h1>` styling):

```css
.auth-shell-tagline {
  margin: 0 0 16px;
  font-family: Georgia, serif;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.25;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- auth-shell.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/auth-shell.tsx apps/web/components/auth-shell.test.tsx apps/web/app/globals.css
git commit -m "fix: demote the auth-shell tagline from h1 to p so each auth page has one h1"
```

---

## Task 3: Associate the password hint with its input via `aria-describedby`

**Files:**
- Modify: `apps/web/components/auth-form.tsx`
- Test: `apps/web/components/auth-form.test.tsx`

- [ ] **Step 1: Read the current file**

Confirm the password field block still matches (currently `auth-form.tsx:331-362`):

```tsx
{isPasswordMode(activeMode) ? (
  <div className="auth-field">
    <label htmlFor={"auth-password-" + activeMode}>
      {locale === "zh-Hant"
        ? isCompletionMode(activeMode)
          ? "新密碼"
          : "密碼"
        : isCompletionMode(activeMode)
          ? "New password"
          : "Password"}
    </label>
    <input
      id={"auth-password-" + activeMode}
      name="password"
      type="password"
      autoComplete={
        isCompletionMode(activeMode)
          ? "new-password"
          : "current-password"
      }
      minLength={PASSWORD_MIN}
      maxLength={PASSWORD_MAX}
      required
      disabled={isPending}
    />
    <small>
      {locale === "zh-Hant"
        ? "長度需為 12 至 128 個字元。"
        : "Use 12 to 128 characters."}
    </small>
  </div>
) : null}
```

- [ ] **Step 2: Write the failing test**

Add to `apps/web/components/auth-form.test.tsx` (check the file's existing imports/render helper first and match its conventions — it already has an `it.each` covering all 6 modes per the Package C work, so add this alongside):

```tsx
it("associates the password hint with the password input via aria-describedby", () => {
  render(<AuthForm mode="signin" locale="en" />);
  const passwordInput = screen.getByLabelText("Password");
  const describedBy = passwordInput.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toMatch(
    /12 to 128 characters/,
  );
});
```

(Confirm `AuthForm`'s real prop names — `mode`/`locale` — against the file's actual type before finalizing; adjust the render call to match.)

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- auth-form.test.tsx`
Expected: FAIL — `passwordInput.getAttribute("aria-describedby")` is `null`.

- [ ] **Step 4: Add the id and aria-describedby**

Change the `<small>` to carry an id, and the `<input>` to reference it:

```tsx
<input
  id={"auth-password-" + activeMode}
  name="password"
  type="password"
  autoComplete={
    isCompletionMode(activeMode)
      ? "new-password"
      : "current-password"
  }
  minLength={PASSWORD_MIN}
  maxLength={PASSWORD_MAX}
  required
  disabled={isPending}
  aria-describedby={"auth-password-hint-" + activeMode}
/>
<small id={"auth-password-hint-" + activeMode}>
  {locale === "zh-Hant"
    ? "長度需為 12 至 128 個字元。"
    : "Use 12 to 128 characters."}
</small>
```

(The id is suffixed with `activeMode`, matching the existing `id={"auth-password-" + activeMode}` convention on the same input, so it stays unique if the component ever renders more than one mode's fields at once.)

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- auth-form.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/auth-form.tsx apps/web/components/auth-form.test.tsx
git commit -m "fix: associate the auth password hint with its input via aria-describedby"
```

---

## Task 4: Disabled queue checkbox label includes the listing title

**Files:**
- Modify: `apps/web/components/listing-queue.tsx`
- Test: `apps/web/components/listing-queue.test.tsx`

- [ ] **Step 1: Read the current file**

Confirm the checkbox block still matches (currently `listing-queue.tsx:76-91`):

```tsx
<input
  type="checkbox"
  checked={selected.has(item.id)}
  disabled={!eligible}
  aria-label={
    eligible
      ? `選取 ${item.title}`
      : `${item.openBlockingFlagCount} 個未解決的合規標記`
  }
  title={
    eligible
      ? undefined
      : `${item.openBlockingFlagCount} 個未解決的合規標記 · ${item.openBlockingFlagCount} unresolved compliance flags`
  }
  onChange={() => onToggle(item.id)}
/>
```

- [ ] **Step 2: Write the failing test**

Add to `apps/web/components/listing-queue.test.tsx` (read the file first for its existing fixture-building helper and match it — it already has a case rendering a disabled/ineligible row):

```tsx
it("includes the listing title in a disabled checkbox's accessible label", () => {
  const item = buildQueueItem({
    id: "item_1",
    title: "Opak Cabernet 2024",
    eligible: false,
    openBlockingFlagCount: 2,
  });
  render(<ListingQueue items={[item]} selected={new Set()} onToggle={() => {}} />);
  const checkbox = screen.getByRole("checkbox");
  expect(checkbox).toHaveAccessibleName(/Opak Cabernet 2024/);
  expect(checkbox.getAttribute("title")).toMatch(/Opak Cabernet 2024/);
});
```

(Use whatever fixture-builder function and component props the existing test file actually uses — read it first and match its exact helper name and `ListingQueue` prop shape rather than the illustrative names above.)

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- listing-queue.test.tsx`
Expected: FAIL — accessible name is `"2 個未解決的合規標記"`, doesn't match `/Opak Cabernet 2024/`.

- [ ] **Step 4: Prepend `item.title` to the disabled branch**

```tsx
<input
  type="checkbox"
  checked={selected.has(item.id)}
  disabled={!eligible}
  aria-label={
    eligible
      ? `選取 ${item.title}`
      : `${item.title} · ${item.openBlockingFlagCount} 個未解決的合規標記`
  }
  title={
    eligible
      ? undefined
      : `${item.title} · ${item.openBlockingFlagCount} 個未解決的合規標記 · ${item.openBlockingFlagCount} unresolved compliance flags`
  }
  onChange={() => onToggle(item.id)}
/>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- listing-queue.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/listing-queue.tsx apps/web/components/listing-queue.test.tsx
git commit -m "fix: include the listing title in a disabled queue checkbox's accessible label"
```

---

## Task 5: `aria-label` directly on the catalog control center's table

**Files:**
- Modify: `apps/web/components/catalog-control-center.tsx`
- Test: `apps/web/components/catalog-control-center.test.tsx`

- [ ] **Step 1: Read the current file**

Confirm `catalog-control-center.tsx:170` is still `<table className={styles.table}>` and its ancestor `<section aria-label="商品控制中心">` is still at line 113.

- [ ] **Step 2: Write the failing test**

Add to `apps/web/components/catalog-control-center.test.tsx` (read the file first to match its existing render/fixture setup):

```tsx
it("gives the product table its own accessible name", () => {
  render(<CatalogControlCenter /* existing required props */ />);
  expect(screen.getByRole("table", { name: "商品控制中心" })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- catalog-control-center.test.tsx`
Expected: FAIL — no table has an accessible name (it only inherits one from the ancestor `<section>`, and `getByRole("table", {name: ...})` requires the name on the table itself or a labelling relationship, not ancestor inheritance).

- [ ] **Step 4: Add the `aria-label`**

Change line 170 from:

```tsx
<table className={styles.table}>
```

to:

```tsx
<table className={styles.table} aria-label="商品控制中心">
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- catalog-control-center.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/catalog-control-center.tsx apps/web/components/catalog-control-center.test.tsx
git commit -m "fix: give the catalog control center's table its own aria-label"
```

---

## Task 6: Touch-target CSS fixes

**Files:**
- Modify: `apps/web/app/globals.css`

Per the design's own §6 testing guidance, a CSS-only value change isn't meaningfully TDD-able in this stack (no computed-style assertion tooling exists here) — verify by reading the rule directly plus a manual browser check, as the design specifies. No test file for this task.

- [ ] **Step 1: Read the current rules**

Confirm `apps/web/app/globals.css:655-660` (`.queue-action`) and `apps/web/app/globals.css:204-210` (`.locale-toggle button`) still match:

```css
.queue-action {
  flex: 0 0 auto;
  min-height: 42px;
  padding: 8px 11px;
  font-size: 12px;
}
```

```css
.locale-toggle button {
  padding: 6px 14px;
  color: var(--ink-soft);
  font-size: 13px;
  background: var(--surface);
  border: none;
}
```

- [ ] **Step 2: Fix `.queue-action`**

Change `min-height: 42px;` to `min-height: 44px;` (line 657).

- [ ] **Step 3: Fix `.locale-toggle button`**

Add `min-height: 44px;` to the `.locale-toggle button` rule:

```css
.locale-toggle button {
  min-height: 44px;
  padding: 6px 14px;
  color: var(--ink-soft);
  font-size: 13px;
  background: var(--surface);
  border: none;
}
```

- [ ] **Step 4: Verify by reading the file back**

Run: `corepack pnpm exec grep -n "min-height: 44px" apps/web/app/globals.css`
Expected: both new lines appear in the output.

- [ ] **Step 5: Manual browser check**

Start the dev server (`.claude/launch.json`'s `wukong-web-start` config against a built app, or `wukong-web-dev`) and visually confirm, at both the mobile (<1024px) and desktop breakpoints, that queue action buttons and the locale toggle buttons are visibly no smaller than before (44px is a 2px change from 42px and imperceptible to the eye, but confirm no layout regression — e.g. the locale toggle not overflowing its container now that its buttons are 44px tall).

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "fix: raise .queue-action and .locale-toggle button to the 44px touch-target minimum"
```

---

## Task 7: `loading.tsx` on every route

**Files:**
- Create: `apps/web/components/route-loading.tsx`
- Test: `apps/web/components/route-loading.test.tsx`
- Create: 13 `loading.tsx` files (listed in Step 5)

- [ ] **Step 1: Write the failing test for the shared component**

Create `apps/web/components/route-loading.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RouteLoading } from "./route-loading";

describe("RouteLoading", () => {
  it("renders a bilingual status region", () => {
    render(<RouteLoading />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/載入中/);
    expect(status).toHaveTextContent(/Loading/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- route-loading.test.tsx`
Expected: FAIL — cannot find module `./route-loading`.

- [ ] **Step 3: Create the shared component**

Create `apps/web/components/route-loading.tsx`, reusing the exact `role="status"` + `.helper-copy` convention already used by `apps/web/components/jobs-ledger-client.tsx`'s own loading state (`<p className="helper-copy" role="status">正在載入作業記錄… Loading jobs ledger…</p>`) rather than inventing new markup or CSS:

```tsx
export function RouteLoading() {
  return (
    <p className="helper-copy" role="status">
      載入中… <span>Loading…</span>
    </p>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- route-loading.test.tsx`
Expected: PASS

- [ ] **Step 5: Create the 13 `loading.tsx` files**

Each file is a two-line re-export. The relative import path depends on nesting depth — confirmed via Glob against the live route tree (18 total `page.tsx` files, 12 under `(app)`, 5 under `(auth)`, 1 root; zero existing `loading.tsx` anywhere):

Depth-3 routes (`apps/web/app/(app)/<segment>/loading.tsx`, import is `../../../components/route-loading`) — create each with this exact content:

`apps/web/app/(app)/dashboard/loading.tsx`, `apps/web/app/(app)/catalog/loading.tsx`, `apps/web/app/(app)/queue/loading.tsx`, `apps/web/app/(app)/batches/loading.tsx`, `apps/web/app/(app)/admin/loading.tsx`, `apps/web/app/(app)/jobs/loading.tsx`, `apps/web/app/(app)/quality/loading.tsx`, `apps/web/app/(app)/system-map/loading.tsx`:

```tsx
import { RouteLoading } from "../../../components/route-loading";

export default function Loading() {
  return <RouteLoading />;
}
```

Depth-4 routes (`apps/web/app/(app)/<segment>/<sub>/loading.tsx`, import is `../../../../components/route-loading`) — create each with this exact content:

`apps/web/app/(app)/batches/[id]/loading.tsx`, `apps/web/app/(app)/listings/new/loading.tsx`, `apps/web/app/(app)/listings/import/loading.tsx`, `apps/web/app/(app)/listings/[id]/loading.tsx`:

```tsx
import { RouteLoading } from "../../../../components/route-loading";

export default function Loading() {
  return <RouteLoading />;
}
```

Shared auth-group loading (covers all 5 pages under `(auth)`, import is `../../components/route-loading`):

`apps/web/app/(auth)/loading.tsx`:

```tsx
import { RouteLoading } from "../../components/route-loading";

export default function Loading() {
  return <RouteLoading />;
}
```

Do not add a `loading.tsx` for the root `apps/web/app/page.tsx` — it's outside every route group and outside this package's design scope (§2 of the design names only the 12 `(app)` routes plus the shared `(auth)` group).

- [ ] **Step 6: Verify the build picks them up**

Run: `corepack pnpm --filter @wukong/web build`
Expected: exit 0, and the route manifest output lists a loading boundary for each of the 13 segments (Next.js prints `ƒ /dashboard` etc. either way, but no build error/warning about an unused or malformed `loading.tsx`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/route-loading.tsx apps/web/components/route-loading.test.tsx "apps/web/app/(app)" "apps/web/app/(auth)/loading.tsx"
git commit -m "feat: add a loading.tsx to every route using a shared RouteLoading component"
```

---

## Task 8: XLSX total decompressed-size bound

**Files:**
- Modify: `packages/shopline/src/bulk-form-xlsx.ts`
- Test: `packages/shopline/src/bulk-form-xlsx.test.ts`

- [ ] **Step 1: Read the current file**

Confirm `packages/shopline/src/bulk-form-xlsx.ts:32` is still `const MAX_INFLATED_BYTES = 64 * 1024 * 1024;`, and that `readZipEntries` (lines 41-104) still enforces the cap only per-entry via `maxOutputLength` inside the loop, with no running total. Also confirm `packages/shopline/src/bulk-form-xlsx.test.ts`'s `zipOf` fixture builder (lines 22-90), `MINIMAL_PARTS` (lines 92-97), and the existing per-entry-cap test (lines 269-279) still match:

```ts
it("rejects a zip entry that inflates beyond the supported size", () => {
  const bomb = deflateRawSync(Buffer.alloc(80 * 1024 * 1024, 0x61));

  const bytes = zipOf([
    ...MINIMAL_PARTS,
    { name: "xl/worksheets/sheet1.xml", raw: new Uint8Array(bomb) },
  ]);

  expect(bytes.byteLength).toBeLessThan(200 * 1024);
  expect(() => readBulkFormSheet(bytes)).toThrow(/inflates beyond/);
});
```

- [ ] **Step 2: Write the failing test**

Add to `packages/shopline/src/bulk-form-xlsx.test.ts`, immediately after the existing per-entry-cap test, following the identical pattern (two entries, each individually under the 64MB per-entry cap, summing past a new 96MB total cap):

```ts
it("rejects an archive whose total decompressed size exceeds the combined bound, even though every individual entry stays under the per-entry cap", () => {
  const first = deflateRawSync(Buffer.alloc(50 * 1024 * 1024, 0x61));
  const second = deflateRawSync(Buffer.alloc(50 * 1024 * 1024, 0x62));

  const bytes = zipOf([
    ...MINIMAL_PARTS,
    { name: "xl/worksheets/sheet1.xml", raw: new Uint8Array(first) },
    { name: "xl/worksheets/sheet2.xml", raw: new Uint8Array(second) },
  ]);

  expect(bytes.byteLength).toBeLessThan(400 * 1024);
  expect(() => readBulkFormSheet(bytes)).toThrow(/total decompressed size/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/shopline test -- bulk-form-xlsx.test.ts`
Expected: FAIL — no error thrown (each 50MB entry is individually under the 64MB per-entry `MAX_INFLATED_BYTES`, and nothing in `readZipEntries` sums across entries today).

- [ ] **Step 4: Add the running-total check**

In `packages/shopline/src/bulk-form-xlsx.ts`, add the new constant immediately after `MAX_INFLATED_BYTES` (line 32):

```ts
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
// 1.5x the per-entry cap: generous for a legitimate multi-sheet/multi-part
// workbook (the real Opak workbook this system targets is 182KB compressed,
// orders of magnitude under this), while still bounding a pathological
// many-small-entries archive that the per-entry cap alone doesn't catch.
const MAX_TOTAL_INFLATED_BYTES = 96 * 1024 * 1024;
```

Then modify `readZipEntries` to track a running total across the loop. The current body (lines 41-104):

```ts
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === ZIP_EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new BulkFormWorkbookError("file is not a zip container");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();

  for (let n = 0; n < entryCount; n += 1) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) {
      throw new BulkFormWorkbookError("malformed zip central directory");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );

    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER) {
      throw new BulkFormWorkbookError(`malformed local header for ${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);

    if (method === 0) entries.set(name, raw);
    else if (method === 8) {
      let inflated;
      try {
        inflated = inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        throw new BulkFormWorkbookError(
          `zip entry ${name} inflates beyond the supported size`,
        );
      }
      entries.set(name, new Uint8Array(inflated));
    } else
      throw new BulkFormWorkbookError(
        `unsupported zip compression method ${method} for ${name}`,
      );

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
```

Replace the body of the `for` loop's method-8 branch with a version that accumulates a running total and throws once it would exceed `MAX_TOTAL_INFLATED_BYTES`. Add `let totalInflatedBytes = 0;` right before the `for` loop (next to `const entries = new Map...`), and change the method-8 branch to:

```ts
    if (method === 0) entries.set(name, raw);
    else if (method === 8) {
      let inflated;
      try {
        inflated = inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        throw new BulkFormWorkbookError(
          `zip entry ${name} inflates beyond the supported size`,
        );
      }
      totalInflatedBytes += inflated.byteLength;
      if (totalInflatedBytes > MAX_TOTAL_INFLATED_BYTES) {
        throw new BulkFormWorkbookError(
          "zip archive's total decompressed size exceeds the supported bound",
        );
      }
      entries.set(name, new Uint8Array(inflated));
    } else
```

(The stored-uncompressed branch, `method === 0`, is left uncounted — `raw` there is a subarray view directly into the caller-supplied `bytes`, whose overall size is already bounded upstream by the request body limit, and it never goes through `inflateRawSync`, so it can't itself be a decompression-bomb vector the way a deflated entry can.)

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/shopline test -- bulk-form-xlsx.test.ts`
Expected: PASS, and confirm the pre-existing per-entry-cap test (Step 1) still passes too (same command runs the whole file).

- [ ] **Step 6: Commit**

```bash
git add packages/shopline/src/bulk-form-xlsx.ts packages/shopline/src/bulk-form-xlsx.test.ts
git commit -m "feat: bound the total decompressed size of a bulk-form XLSX archive, not just each entry"
```

---

## Task 9: `findRelatedToListing` on the audit repository

**Files:**
- Modify: `packages/db/src/repositories/audit.ts`
- Test: `packages/db/src/repositories/audit.integration.test.ts` (new)

- [ ] **Step 1: Read the current file**

Confirm `packages/db/src/repositories/audit.ts` still matches (32 lines, write-only):

```ts
import type { AuditWriter, DomainAuditEvent } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { auditEvents } from "../schema.js";

export type WorkspaceAuditWriter = AuditWriter;

export function createAuditWriter(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceAuditWriter {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  return {
    async write(event: DomainAuditEvent): Promise<void> {
      scope.assertOpen();
      if (event.workspaceId !== workspaceId) {
        throw new Error("audit event workspace does not match transaction workspace");
      }
      await transaction.insert(auditEvents).values({
        workspaceId,
        actorId: event.actorId,
        entityId: event.entityId,
        action: event.action,
        metadata: event.metadata,
      });
    },
  };
}
```

Also confirm `packages/db/src/client.ts:90` (`audit: WorkspaceAuditWriter;`) and `packages/db/src/client.ts:219` (`audit: createAuditWriter(transaction, workspaceId, scope),`) still reference this same type/factory — this task widens `WorkspaceAuditWriter` in place, so `client.ts` needs no edit.

- [ ] **Step 2: Write the failing test**

Create `packages/db/src/repositories/audit.integration.test.ts`, following the exact harness convention from `packages/db/src/repositories/export-attempts.integration.test.ts` (live Postgres, `createDatabase`, admin-seeded workspaces):

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

const workspaceId = "ws_audit_repo";
const otherWorkspaceId = "ws_audit_repo_other";

describe("audit repository — findRelatedToListing", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: ignoreNotice, prepare: false });
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
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("returns only this workspace's audit events for the given listing, newest first", async () => {
    const listingId = await database.forWorkspace(workspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: "test draft",
      });
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.imported",
        metadata: { remoteProductId: "sku_1" },
      });
      await repositories.audit.write({
        workspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.approved",
        metadata: {},
      });
      return draft.id;
    });

    await database.forWorkspace(otherWorkspaceId, async (repositories) => {
      const otherDraft = await repositories.listings.create({
        target: "shopline",
        note: "other workspace draft",
      });
      await repositories.audit.write({
        workspaceId: otherWorkspaceId,
        actorId: "user_2",
        entityId: otherDraft.id,
        action: "listing.imported",
        metadata: {},
      });
    });

    await database.forWorkspace(workspaceId, async (repositories) => {
      const events = await repositories.audit.findRelatedToListing(listingId);
      expect(events.map((event) => event.action)).toEqual([
        "listing.approved",
        "listing.imported",
      ]);
      expect(events.every((event) => event.entityId === listingId)).toBe(true);
    });
  });

  it("never returns another workspace's audit events even for the same listing id", async () => {
    await database.forWorkspace(workspaceId, async (repositories) => {
      const events = await repositories.audit.findRelatedToListing(
        "00000000-0000-4000-8000-000000000000",
      );
      expect(events).toEqual([]);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/db test -- audit.integration.test.ts`
Expected: FAIL — `repositories.audit.findRelatedToListing is not a function`.

- [ ] **Step 4: Implement `findRelatedToListing`**

Rewrite `packages/db/src/repositories/audit.ts` to widen `WorkspaceAuditWriter` into a repository type with both the existing write and the new read method:

```ts
import { and, desc, eq } from "drizzle-orm";

import type { AuditWriter, DomainAuditEvent } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { auditEvents } from "../schema.js";

export type AuditEventRecord = {
  id: string;
  actorId: string;
  entityId: string;
  action: string;
  metadata: unknown;
  createdAt: Date;
};

export type WorkspaceAuditWriter = AuditWriter & {
  findRelatedToListing(listingId: string): Promise<AuditEventRecord[]>;
};

export function createAuditWriter(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceAuditWriter {
  if (workspaceId.trim().length === 0) {
    throw new Error("workspaceId must not be empty");
  }

  return {
    async write(event: DomainAuditEvent): Promise<void> {
      scope.assertOpen();
      if (event.workspaceId !== workspaceId) {
        throw new Error("audit event workspace does not match transaction workspace");
      }
      await transaction.insert(auditEvents).values({
        workspaceId,
        actorId: event.actorId,
        entityId: event.entityId,
        action: event.action,
        metadata: event.metadata,
      });
    },

    async findRelatedToListing(listingId: string): Promise<AuditEventRecord[]> {
      scope.assertOpen();
      const rows = await transaction
        .select({
          id: auditEvents.id,
          actorId: auditEvents.actorId,
          entityId: auditEvents.entityId,
          action: auditEvents.action,
          metadata: auditEvents.metadata,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.entityId, listingId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));
      return rows;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/db test -- audit.integration.test.ts`
Expected: PASS (skip and report explicitly if Postgres is unavailable — do not silently skip).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/audit.ts packages/db/src/repositories/audit.integration.test.ts
git commit -m "feat: add findRelatedToListing to the audit repository"
```

---

## Task 10: `listBatchesForListing` on the enrichment-batch repository

**Files:**
- Modify: `packages/db/src/repositories/enrichment-batches.ts`
- Test: `packages/db/src/repositories/enrichment-batches.integration.test.ts` (add to existing file — read it first to match its harness setup, which follows the same `export-attempts.integration.test.ts` convention)

- [ ] **Step 1: Read the current file**

Confirm `packages/db/src/repositories/enrichment-batches.ts` still has the `itemsOfBatch(batchId)` closure (lines 91-95) and the `listItemsByStatus` method (lines 151-161) as the pattern to copy, and that `enrichment_batch_items_workspace_listing_idx` still exists on `(workspaceId, listingId)` in `packages/db/src/schema.ts` (lines 931-934).

- [ ] **Step 2: Write the failing test**

Add to `packages/db/src/repositories/enrichment-batches.integration.test.ts` (read the file's existing `beforeAll`/workspace-seeding setup first and reuse it rather than duplicating a second harness):

```ts
it("lists the batches a given listing belongs to, newest first, workspace-isolated", async () => {
  await database.forWorkspace(workspaceId, async (repositories) => {
    const draft = await repositories.listings.create({
      target: "shopline",
      note: "test draft",
    });
    const batchA = await repositories.enrichmentBatches.create({
      label: "Batch A",
      budgetUsd: 5,
      waveSize: 10,
      createdBy: "user_1",
      listingIds: [draft.id],
    });
    const batchB = await repositories.enrichmentBatches.create({
      label: "Batch B",
      budgetUsd: 5,
      waveSize: 10,
      createdBy: "user_1",
      listingIds: [draft.id],
    });

    const related = await repositories.enrichmentBatches.listBatchesForListing(
      draft.id,
    );
    expect(related.map((batch) => batch.batchId).sort()).toEqual(
      [batchA.id, batchB.id].sort(),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/db test -- enrichment-batches.integration.test.ts`
Expected: FAIL — `repositories.enrichmentBatches.listBatchesForListing is not a function`.

- [ ] **Step 4: Implement `listBatchesForListing`**

Add to the `EnrichmentBatchRepository` type in `packages/db/src/repositories/enrichment-batches.ts` (after `listItemsByStatus`'s signature):

```ts
  listBatchesForListing(listingId: string): Promise<
    Array<{
      batchId: string;
      label: string;
      status: EnrichmentBatchStatus;
      createdAt: Date;
    }>
  >;
```

Add the implementation inside `createEnrichmentBatchRepository`'s returned object (after `listItemsByStatus`):

```ts
    async listBatchesForListing(listingId) {
      scope.assertOpen();
      const rows = await transaction
        .select({
          batchId: enrichmentBatchItems.batchId,
          label: enrichmentBatches.label,
          status: enrichmentBatches.status,
          createdAt: enrichmentBatches.createdAt,
        })
        .from(enrichmentBatchItems)
        .innerJoin(
          enrichmentBatches,
          and(
            eq(enrichmentBatches.workspaceId, enrichmentBatchItems.workspaceId),
            eq(enrichmentBatches.id, enrichmentBatchItems.batchId),
          ),
        )
        .where(
          and(
            eq(enrichmentBatchItems.workspaceId, workspaceId),
            eq(enrichmentBatchItems.listingId, listingId),
          ),
        )
        .orderBy(desc(enrichmentBatches.createdAt), desc(enrichmentBatches.id));
      return rows;
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/db test -- enrichment-batches.integration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/enrichment-batches.ts packages/db/src/repositories/enrichment-batches.integration.test.ts
git commit -m "feat: add listBatchesForListing to the enrichment-batch repository"
```

---

## Task 11: `listContainingListing` on the export-attempts repository

**Files:**
- Modify: `packages/db/src/repositories/export-attempts.ts`
- Test: `packages/db/src/repositories/export-attempts.integration.test.ts`

- [ ] **Step 1: Read the current file**

Confirm `packages/db/src/repositories/export-attempts.ts` still matches the version quoted in this plan's research (imports `and, desc, eq` from `drizzle-orm`; `manifest` is `jsonb` typed `Array<{listingId, versionId, outcome, reason?}>`, no FK to listings — any per-listing lookup must filter on the jsonb content).

- [ ] **Step 2: Write the failing test**

Add to `packages/db/src/repositories/export-attempts.integration.test.ts`, reusing the file's existing `manifest` fixture and `workspaceId`/`admin`/`database` setup already in scope:

```ts
it("lists export attempts whose manifest contains the given listing id", async () => {
  const targetListingId = "44444444-4444-4444-8444-444444444444";
  const manifestContainingTarget = [
    ...manifest,
    {
      listingId: targetListingId,
      versionId: "55555555-5555-4555-8555-555555555555",
      outcome: "excluded_stale" as const,
      reason: "row_digest_mismatch",
    },
  ];

  const attemptId = await database.forWorkspace(workspaceId, async (repositories) => {
    const attempt = await repositories.exportAttempts.ensure({
      idempotencyKey: "key_contains_target",
      requestedBy: "user_1",
      manifest: manifestContainingTarget,
      rowCount: 1,
      specVersion: "bulk-form-v1",
    });
    return attempt.id;
  });

  await database.forWorkspace(workspaceId, async (repositories) => {
    const containing = await repositories.exportAttempts.listContainingListing(
      targetListingId,
    );
    expect(containing.map((entry) => entry.id)).toEqual([attemptId]);
    expect(containing[0]?.outcome).toBe("excluded_stale");
    expect(containing[0]?.reason).toBe("row_digest_mismatch");

    const notContaining = await repositories.exportAttempts.listContainingListing(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(notContaining).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/db test -- export-attempts.integration.test.ts`
Expected: FAIL — `repositories.exportAttempts.listContainingListing is not a function`.

- [ ] **Step 4: Implement `listContainingListing`**

Add `sql` to the existing `drizzle-orm` import in `packages/db/src/repositories/export-attempts.ts`:

```ts
import { and, desc, eq, sql } from "drizzle-orm";
```

Add to the `ExportAttemptRepository` type:

```ts
  /** Every export attempt whose manifest contains an entry for this listing,
   * newest first. Uses a jsonb containment check since `manifest` carries no
   * foreign key to listings (see the type comment above). */
  listContainingListing(listingId: string): Promise<
    Array<{
      id: string;
      outcome: ExportManifestOutcome;
      reason?: string;
      createdAt: Date;
    }>
  >;
```

Add the implementation inside `createExportAttemptRepository`'s returned object (after `getById`, before `listForWorkspace`):

```ts
    async listContainingListing(listingId) {
      scope.assertOpen();
      const containment = JSON.stringify([{ listingId }]);
      const rows = await transaction
        .select({
          id: exportAttempts.id,
          manifest: exportAttempts.manifest,
          createdAt: exportAttempts.createdAt,
        })
        .from(exportAttempts)
        .where(
          and(
            eq(exportAttempts.workspaceId, workspaceId),
            sql`${exportAttempts.manifest} @> ${containment}::jsonb`,
          ),
        )
        .orderBy(desc(exportAttempts.createdAt), desc(exportAttempts.id));
      return rows.map((row) => {
        const entry = row.manifest.find(
          (item) => item.listingId === listingId,
        );
        return {
          id: row.id,
          outcome: entry?.outcome ?? "listing_not_found",
          reason: entry?.reason,
          createdAt: row.createdAt,
        };
      });
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/db test -- export-attempts.integration.test.ts`
Expected: PASS, and confirm every pre-existing test in this file still passes (same command runs the whole file).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/export-attempts.ts packages/db/src/repositories/export-attempts.integration.test.ts
git commit -m "feat: add listContainingListing to the export-attempts repository"
```

---

## Task 12: `listing-activity-service.ts` + extend `GET /api/listings/[id]`

**Files:**
- Create: `apps/web/lib/listing-activity-service.ts`
- Test: `apps/web/lib/listing-activity-service.test.ts`
- Modify: `apps/web/app/api/listings/[id]/route.ts`
- Test: `apps/web/app/api/listings/[id]/route.test.ts` (add to existing file)

- [ ] **Step 1: Read the current files**

Read `apps/web/app/api/listings/[id]/route.ts` in full (confirm the `createListingViewHandler` function's `db.forWorkspace` callback still assembles and returns the `ListingViewResponse`-shaped object ending in `permissions: listingPermissions(session.role),`) and `apps/web/app/api/listings/[id]/route.test.ts` for its existing fake-repository test conventions.

- [ ] **Step 2: Write the failing test for the service**

Create `apps/web/lib/listing-activity-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getListingActivity } from "./listing-activity-service";

describe("getListingActivity", () => {
  it("merges audit events, batch membership, and export-manifest membership, sorted newest first", async () => {
    const listingId = "listing_1";
    const repositories = {
      audit: {
        findRelatedToListing: async () => [
          {
            id: "audit_1",
            actorId: "user_1",
            entityId: listingId,
            action: "listing.approved",
            metadata: {},
            createdAt: new Date("2026-09-01T10:00:00Z"),
          },
        ],
      },
      enrichmentBatches: {
        listBatchesForListing: async () => [
          {
            batchId: "batch_1",
            label: "Batch A",
            status: "completed" as const,
            createdAt: new Date("2026-09-02T10:00:00Z"),
          },
        ],
      },
      exportAttempts: {
        listContainingListing: async () => [
          {
            id: "export_1",
            outcome: "included" as const,
            reason: undefined,
            createdAt: new Date("2026-09-01T15:00:00Z"),
          },
        ],
      },
    };

    const activity = await getListingActivity(repositories, listingId);

    expect(activity.map((entry) => entry.kind)).toEqual([
      "batch",
      "export",
      "audit",
    ]);
    expect(activity[0]).toMatchObject({ kind: "batch", id: "batch_1" });
    expect(activity[1]).toMatchObject({ kind: "export", id: "export_1" });
    expect(activity[2]).toMatchObject({ kind: "audit", id: "audit_1" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- listing-activity-service.test.ts`
Expected: FAIL — cannot find module `./listing-activity-service`.

- [ ] **Step 4: Implement the service**

Create `apps/web/lib/listing-activity-service.ts`:

```ts
export type ListingActivityAuditEntry = {
  kind: "audit";
  id: string;
  action: string;
  metadata: unknown;
  createdAt: Date;
};

export type ListingActivityBatchEntry = {
  kind: "batch";
  id: string;
  label: string;
  status: string;
  createdAt: Date;
};

export type ListingActivityExportEntry = {
  kind: "export";
  id: string;
  outcome: string;
  reason?: string;
  createdAt: Date;
};

export type ListingActivityEntry =
  | ListingActivityAuditEntry
  | ListingActivityBatchEntry
  | ListingActivityExportEntry;

export type ListingActivityRepositories = {
  audit: {
    findRelatedToListing(listingId: string): Promise<
      Array<{
        id: string;
        actorId: string;
        entityId: string;
        action: string;
        metadata: unknown;
        createdAt: Date;
      }>
    >;
  };
  enrichmentBatches: {
    listBatchesForListing(listingId: string): Promise<
      Array<{ batchId: string; label: string; status: string; createdAt: Date }>
    >;
  };
  exportAttempts: {
    listContainingListing(listingId: string): Promise<
      Array<{ id: string; outcome: string; reason?: string; createdAt: Date }>
    >;
  };
};

/**
 * Merges the three sources of per-listing traceability this codebase has —
 * audit events keyed directly by entityId, batch membership via
 * enrichment_batch_items, and export-manifest membership via a jsonb
 * containment lookup — into one newest-first feed. Mirrors how
 * `buildJobsLedger` (apps/web/lib/jobs-ledger.ts) merges its own 4 sources.
 */
export async function getListingActivity(
  repositories: ListingActivityRepositories,
  listingId: string,
): Promise<ListingActivityEntry[]> {
  const [auditEvents, batches, exportAttempts] = await Promise.all([
    repositories.audit.findRelatedToListing(listingId),
    repositories.enrichmentBatches.listBatchesForListing(listingId),
    repositories.exportAttempts.listContainingListing(listingId),
  ]);

  const entries: ListingActivityEntry[] = [
    ...auditEvents.map(
      (event): ListingActivityAuditEntry => ({
        kind: "audit",
        id: event.id,
        action: event.action,
        metadata: event.metadata,
        createdAt: event.createdAt,
      }),
    ),
    ...batches.map(
      (batch): ListingActivityBatchEntry => ({
        kind: "batch",
        id: batch.batchId,
        label: batch.label,
        status: batch.status,
        createdAt: batch.createdAt,
      }),
    ),
    ...exportAttempts.map(
      (attempt): ListingActivityExportEntry => ({
        kind: "export",
        id: attempt.id,
        outcome: attempt.outcome,
        reason: attempt.reason,
        createdAt: attempt.createdAt,
      }),
    ),
  ];

  entries.sort((a, b) => {
    const byCreatedAt = b.createdAt.getTime() - a.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });
  return entries;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- listing-activity-service.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing test for the route extension**

Add to `apps/web/app/api/listings/[id]/route.test.ts` (read the file's existing fake-`repositories` test setup and extend the same fake object with `audit.findRelatedToListing`, `enrichmentBatches.listBatchesForListing`, `exportAttempts.listContainingListing` stubs, matching whatever pattern the file already uses for `repositories.listings`/`repositories.platformProducts`):

```ts
it("includes the listing's activity feed in the response", async () => {
  // Extend this test file's existing fake repositories object/factory with:
  //   audit: { findRelatedToListing: async () => [] },
  //   enrichmentBatches: { listBatchesForListing: async () => [] },
  //   exportAttempts: { listContainingListing: async () => [] },
  // (or non-empty fixtures, matching the file's existing fixture style)
  // then assert the JSON response has an `activity` array field:
  const response = await handler(request, context);
  const body = await response.json();
  expect(Array.isArray(body.activity)).toBe(true);
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/route.test.ts"`
Expected: FAIL — `body.activity` is `undefined`.

- [ ] **Step 8: Extend the route**

In `apps/web/app/api/listings/[id]/route.ts`, add the import:

```ts
import { getListingActivity } from "../../../../lib/listing-activity-service";
```

Inside the `db.forWorkspace` callback, after `const listingAssets = await repositories.sourceAssets.listForListing(id);` (or anywhere after `repositories` is in scope), add:

```ts
          const activity = await getListingActivity(repositories, id);
```

And add `activity,` to the returned object, e.g. immediately after `permissions: listingPermissions(session.role),`:

```ts
            permissions: listingPermissions(session.role),
            activity,
          };
```

Also add `activity: ListingActivityEntry[];` to the `ListingViewResponse` type in `apps/web/components/listing-review-client.tsx` (import `type { ListingActivityEntry } from "../lib/listing-activity-service";` at the top of that file) — this is prep for Task 13's panel, but the type needs to exist now for the route's return type to typecheck cleanly end-to-end.

- [ ] **Step 9: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/route.test.ts"`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/web/lib/listing-activity-service.ts apps/web/lib/listing-activity-service.test.ts apps/web/app/api/listings/[id]/route.ts "apps/web/app/api/listings/[id]/route.test.ts" apps/web/components/listing-review-client.tsx
git commit -m "feat: compose per-listing activity and surface it from GET /api/listings/[id]"
```

---

## Task 13: `ActivityPanel` component wired into the review page

**Files:**
- Create: `apps/web/components/activity-panel.tsx`
- Test: `apps/web/components/activity-panel.test.tsx`
- Modify: `apps/web/components/listing-review-client.tsx`

- [ ] **Step 1: Read the current file**

Read `apps/web/components/compliance-flags.tsx` and `apps/web/components/delivery-panel.tsx` in full for the exact `<section className="..." aria-labelledby="...">` + `section-heading compact` + eyebrow/`<h2>` convention to copy, and confirm `apps/web/components/listing-review-client.tsx`'s `<div className="review-content">` block still ends with `<DeliveryPanel .../>` as its last child (around lines 786-792).

- [ ] **Step 2: Write the failing test**

Create `apps/web/components/activity-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityPanel } from "./activity-panel";
import type { ListingActivityEntry } from "../lib/listing-activity-service";

describe("ActivityPanel", () => {
  it("renders one item per activity entry, newest first as given, with a heading", () => {
    const entries: ListingActivityEntry[] = [
      {
        kind: "audit",
        id: "audit_1",
        action: "listing.approved",
        metadata: {},
        createdAt: new Date("2026-09-02T10:00:00Z"),
      },
      {
        kind: "batch",
        id: "batch_1",
        label: "Batch A",
        status: "completed",
        createdAt: new Date("2026-09-01T10:00:00Z"),
      },
    ];
    render(<ActivityPanel entries={entries} />);
    expect(
      screen.getByRole("heading", { name: /活動記錄|Activity/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders an empty state when there is no activity yet", () => {
    render(<ActivityPanel entries={[]} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- activity-panel.test.tsx`
Expected: FAIL — cannot find module `./activity-panel`.

- [ ] **Step 4: Implement the component**

Create `apps/web/components/activity-panel.tsx`, matching `compliance-flags.tsx`/`delivery-panel.tsx`'s exact section convention and reusing the existing `.flag-list`/`.flag-item` list classes already used by `jobs-ledger-client.tsx` for a near-identical "list of dated events" rendering:

```tsx
import type { ListingActivityEntry } from "../lib/listing-activity-service";

function summarize(entry: ListingActivityEntry): string {
  switch (entry.kind) {
    case "audit":
      return entry.action;
    case "batch":
      return `批次 Batch: ${entry.label} (${entry.status})`;
    case "export":
      return entry.reason
        ? `匯出 Export: ${entry.outcome} (${entry.reason})`
        : `匯出 Export: ${entry.outcome}`;
  }
}

export function ActivityPanel({
  entries,
}: {
  entries: ListingActivityEntry[];
}) {
  return (
    <section className="activity-panel" aria-labelledby="activity-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">
            活動記錄 <span>ACTIVITY</span>
          </p>
          <h2 id="activity-heading">此商品的完整記錄 / Activity</h2>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="helper-copy">
          尚無活動記錄。 <span>No activity yet.</span>
        </p>
      ) : (
        <ul className="flag-list">
          {entries.map((entry) => (
            <li className="flag-item" key={`${entry.kind}:${entry.id}`}>
              <div className="flag-content">
                <p>{summarize(entry)}</p>
                <div className="jobs-row-meta">
                  <time dateTime={entry.createdAt.toISOString()}>
                    {entry.createdAt.toISOString()}
                  </time>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- activity-panel.test.tsx`
Expected: PASS

- [ ] **Step 6: Wire it into the review page**

In `apps/web/components/listing-review-client.tsx`, add the import:

```tsx
import { ActivityPanel } from "./activity-panel";
```

Add `<ActivityPanel entries={snapshot.activity} />` as the last child inside `<div className="review-content">`, immediately after the existing `<DeliveryPanel .../>` call:

```tsx
    <DeliveryPanel
      model={{ ...delivery, canReview: delivery.canReview && !busy }}
      sku={content?.sku ?? null}
      onCsv={exportCsv}
      onPublish={publish}
    />
    <ActivityPanel entries={snapshot.activity} />
  </div>
</div>
```

(Confirm the exact variable holding the fetched `ListingViewResponse` in this file — the plan assumes it's `snapshot` per the `useState<ListingViewResponse | null>` declared around line 457; adjust if the live code names it differently.)

- [ ] **Step 7: Run the full component test suite for this file**

Run: `corepack pnpm --filter @wukong/web test -- listing-review-client.test.tsx`
Expected: PASS (no regression from the added panel — if this file's existing tests snapshot the full rendered tree or count child sections, update that expectation to include the new Activity section, since that's a genuine, intended change, not a regression to work around).

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/activity-panel.tsx apps/web/components/activity-panel.test.tsx apps/web/components/listing-review-client.tsx
git commit -m "feat: add an Activity panel to the listing review page"
```

---

## Task 14: `listing.review_conflict` audit writes in the approve route

**Files:**
- Modify: `apps/web/app/api/listings/[id]/approve/route.ts`
- Test: `apps/web/app/api/listings/[id]/approve/route.test.ts` (add to existing file)

**Design decision, made here since the design doc left it open:** one action, `listing.review_conflict`, with `metadata: { reason: string }` — covering all three Phase-0 rejection branches (version conflict, confirmation-ledger-stale, and the freshness gate), not two separate action types. This matches the schema-less-JSONB-metadata precedent already used elsewhere (`listing.publish_failed`'s `{versionId, errorCode}`), and keeps the Task 17 aggregate query a single `group by metadata->>'reason'` rather than needing to union two action types.

- [ ] **Step 1: Read the current file**

Confirm the three rejection branches inside `db.forWorkspace(session.workspaceId, async (repositories) => {...})` (currently lines 92-174) still match the version quoted in this plan's research: `version_conflict` (97-103), `confirmation_ledger_stale` (109-118), and the freshness-gate `if (!result.ok)` block (166-172).

- [ ] **Step 2: Write the failing tests**

Add to `apps/web/app/api/listings/[id]/approve/route.test.ts` (read the file's existing fake-repositories test setup first — it must already include a fake `repositories.audit` since `approveOne`'s Phase 3 write depends on it; extend that same fake with a spy, matching whatever assertion style the file already uses, e.g. `vi.fn()` or a plain array the fake pushes into):

```ts
it("writes a listing.review_conflict audit event when the version has changed", async () => {
  // Arrange a snapshot whose activeVersion.id differs from the request's
  // expectedVersionId, using this file's existing fake-repository builder.
  const response = await handler(requestWithStaleVersion, context);
  expect(response.status).toBe(409);
  expect(auditWrites).toContainEqual(
    expect.objectContaining({
      action: "listing.review_conflict",
      entityId: listingId,
      metadata: { reason: "version_conflict" },
    }),
  );
});

it("writes a listing.review_conflict audit event when the confirmation ledger is stale", async () => {
  const response = await handler(requestWithStaleConfirmationRevision, context);
  expect(response.status).toBe(409);
  expect(auditWrites).toContainEqual(
    expect.objectContaining({
      action: "listing.review_conflict",
      metadata: { reason: "confirmation_ledger_stale" },
    }),
  );
});

it("writes a listing.review_conflict audit event when the freshness gate rejects", async () => {
  const response = await handler(requestWithStaleSourceDigest, context);
  expect(response.status).toBe(409);
  expect(auditWrites).toContainEqual(
    expect.objectContaining({
      action: "listing.review_conflict",
      metadata: { reason: expect.any(String) },
    }),
  );
});
```

(Build `requestWithStaleVersion`/`requestWithStaleConfirmationRevision`/`requestWithStaleSourceDigest` from whatever request/fake-snapshot builders this test file already has for its existing 3 rejection-branch tests — those tests already exist to check the 409 status; this task adds the audit assertion alongside them rather than duplicating the whole fixture.)

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/approve/route.test.ts"`
Expected: FAIL — `auditWrites` is empty for all three cases (no `audit.write` call exists on any Phase-0 branch today).

- [ ] **Step 4: Add the three audit writes**

In `apps/web/app/api/listings/[id]/approve/route.ts`, inside the Phase 0 `db.forWorkspace` callback, change each of the three branches:

```ts
        if (snapshot.activeVersion.id !== parsedBody.expectedVersionId) {
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "listing.review_conflict",
            metadata: { reason: "version_conflict" },
          });
          throw new ApiError(
            409,
            "version_conflict",
            "This listing has changed since you started reviewing it.",
          );
        }
```

```ts
        if (
          (confirmation?.revision ?? -1) !==
          parsedBody.confirmationLedgerRevision
        ) {
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "listing.review_conflict",
            metadata: { reason: "confirmation_ledger_stale" },
          });
          throw new ApiError(
            409,
            "confirmation_ledger_stale",
            "The confirmation checklist has changed since you loaded it.",
          );
        }
```

```ts
          if (!result.ok) {
            await repositories.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: id,
              action: "listing.review_conflict",
              metadata: { reason: result.reason },
            });
            throw new ApiError(
              409,
              result.reason,
              "This listing's source data no longer matches what was reviewed.",
            );
          }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/listings/[id]/approve/route.test.ts"`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/[id]/approve/route.ts" "apps/web/app/api/listings/[id]/approve/route.test.ts"
git commit -m "feat: audit listing.review_conflict on approve-route version/confirmation/freshness rejections"
```

---

## Task 15: `listing.review_conflict` audit writes in the export route

**Files:**
- Modify: `apps/web/app/api/listings/export/route.ts`
- Test: `apps/web/app/api/listings/export/route.test.ts` (add to existing file)

**Design correction made here:** the design doc said to add this write "at the freshness-gate rejection call site... in `bulk-export-service.ts`" — but `bulk-export-service.ts`'s `createBulkExport` is a deliberately pure function (its own doc comment: "No database or HTTP here — every read comes through `deps`"), with no audit writer among its `deps` and no HTTP/DB access at all. Adding a side-effecting write there would break that architecture for no benefit. The export **route** (`apps/web/app/api/listings/export/route.ts`) already has `repositories.audit` in scope and already writes one audit event (`listing.bulk_export_created`) right after calling `createBulkExport` — this task adds a loop there, over the returned `manifest`'s `excluded_stale` entries, gated on the same `ensured.wasCreated` flag the existing write already uses (so a repeat/idempotent request doesn't duplicate these events either). `createBulkExport`/`bulk-export-service.ts` itself needs **no code change**.

- [ ] **Step 1: Read the current file**

Confirm `apps/web/app/api/listings/export/route.ts` still has the `if (ensured.wasCreated) { await repositories.audit.write({...action: "listing.bulk_export_created"...}); }` block (currently lines 172-194) as the insertion point.

- [ ] **Step 2: Write the failing test**

Add to `apps/web/app/api/listings/export/route.test.ts` (read the file's existing fake-repositories/fixture setup first, in particular however it currently arranges a `createBulkExport`/manifest fixture with an `excluded_stale` entry — reuse it):

```ts
it("writes a listing.review_conflict audit event for each excluded_stale entry in a newly created export attempt", async () => {
  // Arrange createBulkExport's fake dependency to return a manifest with one
  // "excluded_stale" entry (reason: "row_digest_mismatch") among the survivors,
  // matching this file's existing manifest-fixture conventions.
  const response = await handler(request);
  expect(response.status).toBe(200);
  expect(auditWrites).toContainEqual(
    expect.objectContaining({
      action: "listing.review_conflict",
      entityId: staleListingId,
      metadata: { reason: "row_digest_mismatch" },
    }),
  );
});

it("does not duplicate review_conflict audit events on a repeat request with the same idempotency key", async () => {
  await handler(request);
  auditWrites.length = 0; // reset the spy between calls, matching this file's existing repeat-request test pattern
  const repeat = await handler(request);
  expect(repeat.status).toBe(200);
  expect(auditWrites).toEqual([]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/listings/export/route.test.ts"`
Expected: FAIL — no `listing.review_conflict` write exists yet.

- [ ] **Step 4: Add the loop**

In `apps/web/app/api/listings/export/route.ts`, immediately after the existing `if (ensured.wasCreated) { ... }` block's `listing.bulk_export_created` write (inside the same `if`, after that `await repositories.audit.write({...})` call, before the block's closing brace):

```ts
            if (ensured.wasCreated) {
              await repositories.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: ensured.id,
                action: "listing.bulk_export_created",
                metadata: {
                  exportAttemptId: ensured.id,
                  includedListingIds: ensured.manifest
                    .filter(
                      (entry: ExportManifestEntry) =>
                        entry.outcome === "included",
                    )
                    .map((entry: ExportManifestEntry) => entry.listingId),
                  excludedListingIds: ensured.manifest
                    .filter(
                      (entry: ExportManifestEntry) =>
                        entry.outcome !== "included",
                    )
                    .map((entry: ExportManifestEntry) => entry.listingId),
                },
              });
              for (const entry of ensured.manifest) {
                if (entry.outcome === "excluded_stale" && entry.reason) {
                  await repositories.audit.write({
                    workspaceId: session.workspaceId,
                    actorId: session.actorId,
                    entityId: entry.listingId,
                    action: "listing.review_conflict",
                    metadata: { reason: entry.reason },
                  });
                }
              }
            }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/listings/export/route.test.ts"`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/listings/export/route.ts" "apps/web/app/api/listings/export/route.test.ts"
git commit -m "feat: audit listing.review_conflict for each freshness-excluded listing in a bulk export"
```

---

## Task 16: Aggregate audit write on bulk-form import completion

**Files:**
- Modify: `apps/web/lib/bulk-form-import.ts`
- Test: `apps/web/lib/bulk-form-import.test.ts` (add to existing file)

- [ ] **Step 1: Read the current file**

Confirm `apps/web/lib/bulk-form-import.ts`'s `createBulkFormImporter`'s returned `importBulkForm` function still creates `sourceImport` via `repositories.sourceImports.create({...})` (currently lines 126-136), accumulates `createdDrafts`/`refreshedProducts` across the `for` loop, calls `repositories.platformProducts.upsertMany(mirrors)` (line 224), and returns `{specVersion, parsedRows, createdDrafts, refreshedProducts, issues}` (lines 226-232) — with no aggregate-level audit write anywhere in the function (only the existing per-row `listing.imported`/`listing.import_refreshed` writes at lines 191-204).

- [ ] **Step 2: Write the failing test**

Add to `apps/web/lib/bulk-form-import.test.ts` (read the file's existing fake-`repositories`/fixture setup first, in particular however it currently spies on `repositories.audit.write` for the per-row assertions, and reuse that same spy):

```ts
it("writes one aggregate listing.bulk_form_import_completed audit event per import, entityId'd to the source import", async () => {
  const result = await importBulkForm(input); // matches this file's existing call convention
  expect(auditWrites).toContainEqual(
    expect.objectContaining({
      action: "listing.bulk_form_import_completed",
      metadata: {
        parsedRows: result.parsedRows,
        createdDrafts: result.createdDrafts,
        refreshedProducts: result.refreshedProducts,
        issueCount: result.issues.length,
      },
    }),
  );
  // entityId must be the created sourceImport row's own id, not a listing id --
  // confirm against whatever this file's fake repositories.sourceImports.create
  // stub returns as its `id`.
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- bulk-form-import.test.ts`
Expected: FAIL — no `listing.bulk_form_import_completed` write exists yet.

- [ ] **Step 4: Add the write**

In `apps/web/lib/bulk-form-import.ts`, after `await repositories.platformProducts.upsertMany(mirrors);` (line 224) and before the `return { ... }` statement, add:

```ts
        // One aggregate event per import call, entityId'd to the sourceImport
        // row -- not to any one listing, since this event summarizes the
        // whole batch. Mirrors enrichment_batch.created's own per-batch
        // (not per-listing) entityId convention.
        await repositories.audit.write({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          entityId: sourceImport.id,
          action: "listing.bulk_form_import_completed",
          metadata: {
            parsedRows: parsed.rows.length,
            createdDrafts,
            refreshedProducts,
            issueCount: parsed.issues.length,
          },
        });

        return {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- bulk-form-import.test.ts`
Expected: PASS, and confirm every pre-existing test in this file still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/bulk-form-import.ts apps/web/lib/bulk-form-import.test.ts
git commit -m "feat: write an aggregate listing.bulk_form_import_completed audit event per import"
```

---

## Task 17: Aggregate query methods on the audit repository

**Files:**
- Modify: `packages/db/src/repositories/audit.ts`
- Test: `packages/db/src/repositories/audit.integration.test.ts`

- [ ] **Step 1: Read the current file**

Re-read `packages/db/src/repositories/audit.ts` as it stands after Task 9 (with `findRelatedToListing` already added).

- [ ] **Step 2: Write the failing tests**

Add to `packages/db/src/repositories/audit.integration.test.ts`, in a new `describe` block:

```ts
describe("audit repository — aggregate queries", () => {
  const metricsWorkspaceId = "ws_audit_metrics";

  beforeAll(async () => {
    await admin.unsafe(`
      INSERT INTO workspaces (id, name, profile) VALUES
        ('${metricsWorkspaceId}', '${metricsWorkspaceId}', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  it("counts audit events by action within a time window", async () => {
    const since = new Date(Date.now() - 60_000);
    await database.forWorkspace(metricsWorkspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: "test draft",
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.publish_failed",
        metadata: { versionId: "v1", errorCode: "shopline_5xx" },
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.publish_failed",
        metadata: { versionId: "v1", errorCode: "shopline_5xx" },
      });

      const count = await repositories.audit.countByActionSince(
        "listing.publish_failed",
        since,
      );
      expect(count).toBe(2);
    });
  });

  it("groups review_conflict counts by reason within a time window", async () => {
    const since = new Date(Date.now() - 60_000);
    await database.forWorkspace(metricsWorkspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: "test draft 2",
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.review_conflict",
        metadata: { reason: "version_conflict" },
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.review_conflict",
        metadata: { reason: "row_digest_mismatch" },
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.review_conflict",
        metadata: { reason: "row_digest_mismatch" },
      });

      const grouped = await repositories.audit.countByActionAndMetadataKeySince(
        "listing.review_conflict",
        "reason",
        since,
      );
      expect(new Map(grouped.map((row) => [row.value, row.count]))).toEqual(
        new Map([
          ["version_conflict", 1],
          ["row_digest_mismatch", 2],
        ]),
      );
    });
  });

  it("sums bulk-form import metrics within a time window", async () => {
    const since = new Date(Date.now() - 60_000);
    await database.forWorkspace(metricsWorkspaceId, async (repositories) => {
      const draft = await repositories.listings.create({
        target: "shopline",
        note: "test draft 3",
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.bulk_form_import_completed",
        metadata: {
          parsedRows: 10,
          createdDrafts: 3,
          refreshedProducts: 2,
          issueCount: 1,
        },
      });
      await repositories.audit.write({
        workspaceId: metricsWorkspaceId,
        actorId: "user_1",
        entityId: draft.id,
        action: "listing.bulk_form_import_completed",
        metadata: {
          parsedRows: 5,
          createdDrafts: 1,
          refreshedProducts: 0,
          issueCount: 0,
        },
      });

      const summed = await repositories.audit.sumImportMetricsSince(since);
      expect(summed).toEqual({
        parsedRows: 15,
        createdDrafts: 4,
        refreshedProducts: 2,
        issueCount: 1,
      });
    });
  });

  it("does not count events from before the given window", async () => {
    const future = new Date(Date.now() + 60_000);
    await database.forWorkspace(metricsWorkspaceId, async (repositories) => {
      const count = await repositories.audit.countByActionSince(
        "listing.publish_failed",
        future,
      );
      expect(count).toBe(0);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/db test -- audit.integration.test.ts`
Expected: FAIL — `countByActionSince`/`countByActionAndMetadataKeySince`/`sumImportMetricsSince` are not functions.

- [ ] **Step 4: Implement the three methods**

In `packages/db/src/repositories/audit.ts`, add `gte` to the `drizzle-orm` import:

```ts
import { and, desc, eq, gte, sql } from "drizzle-orm";
```

Add to the `WorkspaceAuditWriter` type:

```ts
export type WorkspaceAuditWriter = AuditWriter & {
  findRelatedToListing(listingId: string): Promise<AuditEventRecord[]>;
  countByActionSince(action: string, since: Date): Promise<number>;
  countByActionAndMetadataKeySince(
    action: string,
    metadataKey: string,
    since: Date,
  ): Promise<Array<{ value: string | null; count: number }>>;
  sumImportMetricsSince(since: Date): Promise<{
    parsedRows: number;
    createdDrafts: number;
    refreshedProducts: number;
    issueCount: number;
  }>;
};
```

Add the three implementations inside the returned object (after `findRelatedToListing`):

```ts
    async countByActionSince(action, since) {
      scope.assertOpen();
      const [row] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.action, action),
            gte(auditEvents.createdAt, since),
          ),
        );
      return row?.count ?? 0;
    },

    async countByActionAndMetadataKeySince(action, metadataKey, since) {
      scope.assertOpen();
      const rows = await transaction
        .select({
          value: sql<string | null>`${auditEvents.metadata}->>${metadataKey}`,
          count: sql<number>`count(*)::int`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.action, action),
            gte(auditEvents.createdAt, since),
          ),
        )
        .groupBy(sql`${auditEvents.metadata}->>${metadataKey}`);
      return rows;
    },

    async sumImportMetricsSince(since) {
      scope.assertOpen();
      const [row] = await transaction
        .select({
          parsedRows: sql<number>`coalesce(sum((${auditEvents.metadata}->>'parsedRows')::int), 0)::int`,
          createdDrafts: sql<number>`coalesce(sum((${auditEvents.metadata}->>'createdDrafts')::int), 0)::int`,
          refreshedProducts: sql<number>`coalesce(sum((${auditEvents.metadata}->>'refreshedProducts')::int), 0)::int`,
          issueCount: sql<number>`coalesce(sum((${auditEvents.metadata}->>'issueCount')::int), 0)::int`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, workspaceId),
            eq(auditEvents.action, "listing.bulk_form_import_completed"),
            gte(auditEvents.createdAt, since),
          ),
        );
      return (
        row ?? {
          parsedRows: 0,
          createdDrafts: 0,
          refreshedProducts: 0,
          issueCount: 0,
        }
      );
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/db test -- audit.integration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/audit.ts packages/db/src/repositories/audit.integration.test.ts
git commit -m "feat: add aggregate count/sum queries to the audit repository"
```

---

## Task 18: Metric tiles on `/jobs`

**Files:**
- Modify: `apps/web/app/api/jobs/route.ts`
- Modify: `apps/web/components/jobs-ledger-client.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/app/api/jobs/route.test.ts` (add to existing file)
- Test: `apps/web/components/jobs-ledger-client.test.tsx` (add to existing file, if one exists — check first)

**Design correction made here:** the design doc said these tiles should match "`/jobs`'s existing per-lane count-badge pattern" — re-verification found `/jobs` has no such pattern today (it only has filter tabs and per-row status pills). The real existing metric-tile pattern in this codebase is `quality-summary-client.tsx`'s `.metric-strip`/`.metric-value`/`.metric-label` global CSS classes (`globals.css:533-570`), which this task copies instead.

- [ ] **Step 1: Read the current files**

Read `apps/web/app/api/jobs/route.ts` in full (confirm `createJobsHandler`'s `db.forWorkspace` callback still fetches the 4 ledger sources via `Promise.all` and returns `{ entries }` via `jsonResponse(200, { entries })`), `apps/web/components/quality-summary-client.tsx` lines 88-118 for the exact `.metric-strip` JSX to copy, and `apps/web/app/globals.css:533-570` for the exact CSS to extend.

- [ ] **Step 2: Write the failing test for the route**

Add to `apps/web/app/api/jobs/route.test.ts` (read the file's existing fake-repositories setup first and extend it with `repositories.audit.countByActionSince`/`countByActionAndMetadataKeySince`/`sumImportMetricsSince` stubs):

```ts
it("includes a metrics summary alongside the ledger entries", async () => {
  const response = await jobsHandler();
  const body = await response.json();
  expect(body.metrics).toEqual({
    publishRetries: expect.any(Number),
    versionConflicts: expect.any(Number),
    staleSourceRejections: expect.any(Number),
    importedRows: expect.any(Number),
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/jobs/route.test.ts"`
Expected: FAIL — `body.metrics` is `undefined`.

- [ ] **Step 4: Extend the route**

In `apps/web/app/api/jobs/route.ts`, add a `METRICS_WINDOW_MS` constant and a reason-bucketing helper, then extend the handler:

```ts
// 30 days: long enough to be a meaningful trend line on a page checked
// periodically, short enough that the aggregate queries stay cheap without
// their own dedicated index (see Task 17 -- these queries scan
// audit_events_workspace_created_idx and filter by action/metadata after).
const METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// review_conflict's `reason` values come from two different sources -- the
// approve route's own literals ("version_conflict", "confirmation_ledger_stale")
// and assertApprovalFreshness/assertExportFreshness's FreshnessFailureReason
// union ("not_attested" | "no_remote_link" | "source_import_mismatch" |
// "row_digest_mismatch" | "version_mismatch" | "header_contract_stale") --
// bucketed here into the 2 metrics the design names, rather than a 8-way
// breakdown no tile could usefully show.
const VERSION_CONFLICT_REASONS = new Set([
  "version_conflict",
  "confirmation_ledger_stale",
]);

export function createJobsHandler(deps: JobsRouteDeps) {
  return async function jobs(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const since = new Date(Date.now() - METRICS_WINDOW_MS);
      const { entries, metrics } = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const [batches, publishJobs, pipelineRuns, exports] =
            await Promise.all([
              repositories.enrichmentBatches.listForWorkspace(
                SOURCE_FETCH_LIMIT,
              ),
              repositories.publishJobs.listForWorkspace(SOURCE_FETCH_LIMIT),
              repositories.pipelineRuns.listForWorkspace(SOURCE_FETCH_LIMIT),
              repositories.exportAttempts.listForWorkspace(SOURCE_FETCH_LIMIT),
            ]);

          const [publishRetries, reviewConflictsByReason, importSums] =
            await Promise.all([
              repositories.audit.countByActionSince(
                "listing.publish_failed",
                since,
              ),
              repositories.audit.countByActionAndMetadataKeySince(
                "listing.review_conflict",
                "reason",
                since,
              ),
              repositories.audit.sumImportMetricsSince(since),
            ]);

          let versionConflicts = 0;
          let staleSourceRejections = 0;
          for (const row of reviewConflictsByReason) {
            if (row.value && VERSION_CONFLICT_REASONS.has(row.value)) {
              versionConflicts += row.count;
            } else {
              staleSourceRejections += row.count;
            }
          }

          return {
            entries: buildJobsLedger(
              { batches, publishJobs, pipelineRuns, exports },
              LEDGER_DISPLAY_LIMIT,
            ),
            metrics: {
              publishRetries,
              versionConflicts,
              staleSourceRejections,
              importedRows: importSums.parsedRows,
            },
          };
        });

      return jsonResponse(200, { entries, metrics });
    });
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- "apps/web/app/api/jobs/route.test.ts"`
Expected: PASS

- [ ] **Step 6: Write the failing test for the tiles**

Add to `apps/web/components/jobs-ledger-client.test.tsx` (create the file if it doesn't exist, matching this component's `fetch("/api/jobs")` mocking convention used elsewhere in this codebase's client-component tests):

```tsx
it("renders a metric tile for each of the 4 new observability metrics", async () => {
  // Mock fetch("/api/jobs") to resolve with:
  // { entries: [], metrics: { publishRetries: 3, versionConflicts: 1, staleSourceRejections: 2, importedRows: 120 } }
  render(<JobsLedgerClient />);
  await screen.findByText("3");
  expect(screen.getByText("120")).toBeInTheDocument();
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `corepack pnpm --filter @wukong/web test -- jobs-ledger-client.test.tsx`
Expected: FAIL — no metric tiles rendered yet.

- [ ] **Step 8: Add the tiles**

In `apps/web/components/jobs-ledger-client.tsx`, extend `JobsResponse` and render a `.metric-strip` block. Change:

```tsx
type JobsResponse = {
  entries: WireLedgerEntry[];
};
```

to:

```tsx
type JobsMetrics = {
  publishRetries: number;
  versionConflicts: number;
  staleSourceRejections: number;
  importedRows: number;
};

type JobsResponse = {
  entries: WireLedgerEntry[];
  metrics: JobsMetrics;
};
```

Update `EMPTY_RESPONSE` to include a zeroed `metrics` object:

```tsx
const EMPTY_RESPONSE: JobsResponse = {
  entries: [],
  metrics: {
    publishRetries: 0,
    versionConflicts: 0,
    staleSourceRejections: 0,
    importedRows: 0,
  },
};
```

Add the tile strip as the first child of the returned `<section aria-label="作業記錄">`, before the existing `<div className="admin-tab-list" ...>`:

```tsx
      <div
        className="metric-strip jobs-metric-strip"
        aria-label="作業指標統計"
      >
        <div>
          <span className="metric-value">{response.metrics.publishRetries}</span>
          <span className="metric-label">
            發佈重試 <small>Publish retries</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{response.metrics.versionConflicts}</span>
          <span className="metric-label">
            版本衝突 <small>Version conflicts</small>
          </span>
        </div>
        <div>
          <span className="metric-value">
            {response.metrics.staleSourceRejections}
          </span>
          <span className="metric-label">
            來源已過時 <small>Stale-source rejections</small>
          </span>
        </div>
        <div>
          <span className="metric-value">{response.metrics.importedRows}</span>
          <span className="metric-label">
            近期匯入列數 <small>Recent imported rows</small>
          </span>
        </div>
      </div>
```

Add the 4-column modifier to `apps/web/app/globals.css`, immediately after the existing `.quality-metric-strip` rule (`globals.css:568-570`):

```css
.jobs-metric-strip {
  grid-template-columns: repeat(4, 1fr);
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `corepack pnpm --filter @wukong/web test -- jobs-ledger-client.test.tsx`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/web/app/api/jobs/route.ts apps/web/components/jobs-ledger-client.tsx apps/web/app/globals.css "apps/web/app/api/jobs/route.test.ts" apps/web/components/jobs-ledger-client.test.tsx
git commit -m "feat: surface publish-retry, review-conflict, and import-volume metric tiles on /jobs"
```

---

## Task 19: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `corepack pnpm typecheck`
Expected: exit 0, no errors — pay particular attention to `apps/web/components/listing-review-client.tsx`'s `ListingViewResponse.activity` field (Task 12) and every new repository method's return type flowing through `packages/db`'s public exports.

- [ ] **Step 2: Format check**

Run: `corepack pnpm exec prettier --check .`
Expected: exit 0. If it fails on any file this plan touched, run `corepack pnpm exec prettier --write <file>` and make a new small `style:` commit for the formatting fixes rather than amending a prior task's commit.

- [ ] **Step 3: Unit tests**

Run: `corepack pnpm test`
Expected: exit 0, all suites green, including every new/modified test file from Tasks 1-18.

- [ ] **Step 4: Integration tests**

Run: `docker compose up -d postgres` (if not already running), then `corepack pnpm test:integration`.
Expected: exit 0, including `audit.integration.test.ts` (Tasks 9, 17), `enrichment-batches.integration.test.ts` (Task 10), `export-attempts.integration.test.ts` (Task 11). If Postgres is genuinely unreachable, report that explicitly rather than silently treating this step as passed.

- [ ] **Step 5: Runtime-forbidden-content check**

Run: `corepack pnpm --filter @wukong/web run runtime:forbidden:check` (or the repo-root equivalent script named in `package.json` — confirm the exact script name first, since this plan's other references to it come from earlier session summaries, not a re-verified command).
Expected: exit 0 — no credentials, signed URLs, prompts, model output, or customer content in any new `console.info`/log call this plan added (Task 18's route has none; Task 16's new audit write only logs identifiers/counts, never merchant content, matching the existing per-row writes' own convention).

- [ ] **Step 6: Production build**

Run: `corepack pnpm --filter @wukong/web build`
Expected: exit 0, and the route manifest lists all 13 new `loading.tsx` boundaries (Task 7) with no warnings.

- [ ] **Step 7: Manual browser verification**

Using `.claude/launch.json`'s `wukong-web-start` config (against the build from Step 6) or `wukong-web-dev`:
- Confirm the skip link appears on Tab-focus on any `/signin`/`/register` page and jumps focus into the card (Task 1).
- Confirm each auth page has exactly one visible `<h1>` (Task 2) via the accessibility tree, not just the test.
- Confirm a `/listings/[id]` review page renders a new "Activity" section listing at least the listing's own `listing.imported` event (Tasks 9-13).
- Confirm `/jobs` renders the 4 new metric tiles above the existing filter tabs (Task 18).
- Confirm queue-action buttons and the locale toggle visually still look correct at both breakpoints (Task 6).

Report the outcome of each check explicitly — this step cannot be automated further in this stack, per the design's own §6 guidance, so a plain PASS/FAIL per bullet with a one-line note is the expected output, not a blanket "looks fine."

- [ ] **Step 8: Report status**

Do not push or open a pull request — stop here and report back with the full verification checklist's results (Steps 1-7), matching how every prior package this session was handed back for the user's own review/merge.
