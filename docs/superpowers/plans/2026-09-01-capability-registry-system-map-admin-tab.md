# Capability Registry, `/system-map`, `/admin` System-Truth Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared, hand-maintained capability registry, rendered identically by a new `/admin` tab (admin-gated) and a new `/system-map` page (open to any authenticated member).

**Architecture:** A static typed constant array (`CAPABILITY_REGISTRY`) feeds one shared, reusable panel component (`CapabilityRegistryPanel`) — not two separately-built renderers — so the "both surfaces show the same state" guarantee is structural (same component, same import), not just something a test happens to check. `admin-tabs.tsx` gets a 4th tab embedding that component; `/system-map` is a new page embedding the same component directly.

**Tech Stack:** Next.js App Router, React 19, Vitest, plain CSS (no Tailwind).

---

## Environment note for every `Run:` step

`pnpm` is not reliably on PATH in this environment. Prefix every command with `corepack`:

```powershell
corepack pnpm --filter @wukong/web test -- <file>
```

Do **not** use an `$env:PATH = "...scratchpad\bin..."` prefix — that shim directory is empty this session. `corepack pnpm` is the confirmed-working form. If `corepack pnpm typecheck`/`test` (turbo-orchestrated) hits `Unable to find package manager binary`, run `corepack enable --install-directory <a scratch dir>` and prepend that directory to PATH for the rest of that session's commands.

---

### Task 1: `capability-registry.ts` — the registry module

**Files:**

- Create: `apps/web/lib/capability-registry.ts`
- Create: `apps/web/lib/capability-registry.test.ts`

- [ ] **Step 1: Read the closest existing style precedent**

Read `packages/shopline/src/bulk-form.ts`'s `BULK_FORM_COLUMNS` constant (lines ~22 onward) and its own doc comment explaining provenance — this is the closest existing precedent in this codebase for a hand-written, doc-commented, canonical constant array. Match its spirit: real, specific entries with a comment explaining where each one's stated state comes from, not placeholder text.

- [ ] **Step 2: Write the failing test**

Create `apps/web/lib/capability-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  CAPABILITY_REGISTRY,
  type CapabilityState,
} from "./capability-registry.js";

const VALID_STATES: readonly CapabilityState[] = [
  "live",
  "pilot",
  "planned",
  "blocked",
];

describe("CAPABILITY_REGISTRY", () => {
  it("has at least the 6 grounded entries from the design spec", () => {
    const ids = CAPABILITY_REGISTRY.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "shopline-real-publish",
        "ai-listing-generation",
        "bulk-form-import-freshness-gate",
        "attended-enrichment-batches",
        "multi-product-export",
        "jobs-ledger",
      ]),
    );
  });

  it("has no duplicate ids", () => {
    const ids = CAPABILITY_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty label, description, and a valid state", () => {
    for (const entry of CAPABILITY_REGISTRY) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(VALID_STATES).toContain(entry.state);
    }
  });

  it("marks real SHOPLINE publishing as blocked", () => {
    const entry = CAPABILITY_REGISTRY.find(
      (candidate) => candidate.id === "shopline-real-publish",
    );
    expect(entry?.state).toBe("blocked");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- capability-registry.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/lib/capability-registry.ts`:

```ts
/**
 * The single source of truth for capability maturity, consumed by both the
 * /admin "System Truth" tab and /system-map -- see the design doc at
 * docs/superpowers/specs/2026-09-01-capability-registry-system-map-admin-tab-design.md
 * for why this is a static, hand-maintained list rather than a live
 * environment-variable check: the most safety-critical entry here
 * (shopline-real-publish) is gated by SHOPLINE_PUBLISH_ENABLED, which is
 * only ever read in apps/worker, never apps/web -- there is no live signal
 * this module could read without introducing a second, driftable copy of
 * that flag into the Vercel deployment. Update an entry's `state` in the
 * SAME pull request that changes the underlying capability's real state.
 */

export type CapabilityState = "live" | "pilot" | "planned" | "blocked";

export type CapabilityEntry = {
  id: string;
  label: string;
  description: string;
  state: CapabilityState;
};

export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = [
  {
    id: "shopline-real-publish",
    label: "SHOPLINE 正式發佈 / Real SHOPLINE publishing",
    description:
      "Production runs with SHOPLINE_ADAPTER=disabled and SHOPLINE_PUBLISH_ENABLED=false. Enabling real writes requires separate written authorization outside this plan.",
    state: "blocked",
  },
  {
    id: "ai-listing-generation",
    label: "AI 商品資訊生成 / AI-assisted listing generation",
    description:
      "Production runs AI_PROVIDER=openai against the real OpenAIListingProvider for listing content generation.",
    state: "live",
  },
  {
    id: "bulk-form-import-freshness-gate",
    label: "批次匯入與新鮮度檢查 / Bulk-form import + freshness gate",
    description:
      "Merchant-attested bulk-form catalog import, with the freshness gate validating source/version/digest before publish or export.",
    state: "live",
  },
  {
    id: "attended-enrichment-batches",
    label: "AI 批次強化 / Attended AI-enrichment batches",
    description:
      "Batch creation and wave advancement are live in production. The list/detail read UI for reviewing an existing batch is built but not yet merged to main.",
    state: "pilot",
  },
  {
    id: "multi-product-export",
    label: "多商品匯出 / Multi-product export",
    description:
      "Export multiple approved, freshness-checked listings as one SHOPLINE-importable workbook. Built, not yet merged to main.",
    state: "pilot",
  },
  {
    id: "jobs-ledger",
    label: "作業總覽 / Jobs ledger",
    description:
      "A read-only view of recent enrichment batches, publish jobs, AI pipeline runs, and exports in one time-sorted list. Built, not yet merged to main.",
    state: "pilot",
  },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- capability-registry.test.ts
```

Expected: PASS, all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/capability-registry.ts apps/web/lib/capability-registry.test.ts
git commit -m "feat: add the capability registry"
```

---

### Task 2: `CapabilityRegistryPanel` component and the `/admin` 4th tab

**Files:**

- Create: `apps/web/components/capability-registry-panel.tsx`
- Create: `apps/web/components/capability-registry-panel.test.tsx`
- Modify: `apps/web/components/admin-tabs.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Read the existing tab-panel pattern**

Read `apps/web/components/admin-tabs.tsx` in full (already known: `AdminTab` union, `TABS` array, `useState`, `role="tablist"`/`role="tab"`/`role="tabpanel"` markup, the conditional `{active === "x" ? <Panel/> : null}` chain) and `apps/web/components/admin-settings-panel.tsx` (the simplest existing panel, for general component-shape reference — this new panel is simpler still, since it has no fetch/mutation, just a static render). Also read `apps/web/app/globals.css`'s `.status-pending`/`.status-running`/`.status-succeeded`/`.status-failed`/`.status-cancelled` rules (added this session for the `/jobs` ledger) to reuse for the capability-state badges — do not invent new color classes.

- [ ] **Step 2: Write the failing test**

Create `apps/web/components/capability-registry-panel.test.tsx`. Cover: renders one row per `CAPABILITY_REGISTRY` entry, showing `label`, `description`, and a visible state indicator; every entry from the registry appears (assert the rendered row count equals `CAPABILITY_REGISTRY.length`, and that at least one row's text includes a known entry's label, e.g. "SHOPLINE 正式發佈").

- [ ] **Step 3: Run it to verify it fails**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- capability-registry-panel.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/components/capability-registry-panel.tsx`:

```tsx
import {
  CAPABILITY_REGISTRY,
  type CapabilityState,
} from "../lib/capability-registry.js";

const STATE_LABEL: Record<CapabilityState, string> = {
  live: "已上線 Live",
  pilot: "試行中 Pilot",
  planned: "規劃中 Planned",
  blocked: "已封鎖 Blocked",
};

// Reuses the /jobs ledger's existing 5-tone status-pill classes rather than
// inventing new ones -- capability states only need 4 of the 5 (cancelled
// is a /jobs-specific concept with no capability-registry equivalent).
const STATE_CLASS: Record<CapabilityState, string> = {
  live: "status-succeeded",
  pilot: "status-running",
  planned: "status-pending",
  blocked: "status-failed",
};

export function CapabilityRegistryPanel() {
  return (
    <ul className="flag-list capability-registry-list">
      {CAPABILITY_REGISTRY.map((entry) => (
        <li key={entry.id} className="flag-item capability-registry-item">
          <div className="jobs-row-header">
            <span className={`connection-status ${STATE_CLASS[entry.state]}`}>
              <span />
              {STATE_LABEL[entry.state]}
            </span>
            <strong>{entry.label}</strong>
          </div>
          <p className="jobs-row-meta">{entry.description}</p>
        </li>
      ))}
    </ul>
  );
}
```

Adjust the exact CSS class names/markup to whatever Step 1's read of `globals.css` and the `/jobs` ledger's own `jobs-ledger-client.tsx` actually established (the sketch above assumes the `.flag-list`/`.flag-item`/`.connection-status`/`.jobs-row-header`/`.jobs-row-meta` classes from this session's own prior work — confirm they exist with these exact names before reusing them, and if `globals.css` needs a small addition for this specific layout, add it there rather than inventing an entirely separate style system).

In `apps/web/components/admin-tabs.tsx`: extend `AdminTab` to `"members" | "connection" | "settings" | "capabilities"`, add `{ id: "capabilities", label: "系統真相 Capabilities" }` to `TABS`, add `{active === "capabilities" ? <CapabilityRegistryPanel /> : null}` to the tabpanel chain, import `CapabilityRegistryPanel`.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- capability-registry-panel.test.tsx
```

Expected: PASS, all tests. Also run the existing `admin-tabs.test.tsx` (if one exists — check during Step 1) to confirm the 4th tab doesn't break existing tab-switching tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/capability-registry-panel.tsx apps/web/components/capability-registry-panel.test.tsx apps/web/components/admin-tabs.tsx apps/web/app/globals.css
git commit -m "feat: add the CapabilityRegistryPanel and admin's 4th tab"
```

---

### Task 3: `/system-map` page and nav link

**Files:**

- Create: `apps/web/app/(app)/system-map/page.tsx`
- Create: `apps/web/app/(app)/system-map/page.test.tsx` (or colocated per whatever this codebase's convention for page-level tests actually is — check `apps/web/app/(app)/jobs/page.tsx` for whether it has its own test file at all before assuming one is needed; if the `/jobs` page itself has no dedicated test, matching that precedent for `/system-map` is acceptable — the underlying `CapabilityRegistryPanel` is already tested in Task 2)
- Create: `apps/web/lib/capability-registry-consistency.test.ts` (the design's explicit "both surfaces show the same state" acceptance criterion)
- Modify: `apps/web/app/(app)/layout.tsx`

- [ ] **Step 1: Read the `/jobs` page as the closest precedent**

Read `apps/web/app/(app)/jobs/page.tsx` in full (already known: no role gate, no `async`, plain server component rendering one client/shared component inside a `page-wrap`/`page-header` wrapper). `/system-map` follows the identical shape, with NO role gate (unlike `/admin`'s page, which redirects non-admins) — per the design's explicit decision that `/system-map` is open to any authenticated member.

- [ ] **Step 2: Write the failing test(s)**

Create `apps/web/lib/capability-registry-consistency.test.ts` — the structural "both surfaces render the same data" proof:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads the raw source of both files rather than importing/rendering them,
// so this test's guarantee doesn't depend on any bundler/JSX-transform
// detail: if either surface is ever changed to use a different or forked
// component, the shared import line disappears and this test fails.
function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("capability registry consistency", () => {
  it("admin-tabs.tsx and /system-map's page both import CapabilityRegistryPanel", () => {
    const adminTabsSource = readSource("../components/admin-tabs.tsx");
    const systemMapSource = readSource("../app/(app)/system-map/page.tsx");
    expect(adminTabsSource).toMatch(/CapabilityRegistryPanel/);
    expect(systemMapSource).toMatch(/CapabilityRegistryPanel/);
  });
});
```

Re-derive this test during implementation rather than trusting the sketch verbatim: confirm the relative paths from `apps/web/lib/` to `admin-tabs.tsx`/`system-map/page.tsx` are correct once the files actually exist, and confirm this genuinely fails if either file is edited to use a different component (e.g. temporarily rename the import in one file locally, confirm the test fails, then revert — the same load-bearing-test verification method used throughout this session).

Also create `apps/web/app/(app)/system-map/page.test.tsx` (or skip per Step 1's precedent-check) covering: the page renders `CapabilityRegistryPanel`'s content, and includes NO role/redirect logic (if `/jobs/page.tsx` has no test file, mirror that and skip this file, noting the decision).

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- capability-registry-consistency.test.ts
```

Expected: FAIL — `/system-map`'s page module does not exist yet.

- [ ] **Step 4: Implement it**

Create `apps/web/app/(app)/system-map/page.tsx`:

```tsx
import { CapabilityRegistryPanel } from "../../../components/capability-registry-panel";

export default function SystemMapPage() {
  return (
    <div className="page-wrap">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            System map <span>ECOMMERCE OS CONTROL PLANE</span>
          </p>
          <h1>系統能力現況，公開透明。</h1>
          <p className="lede">
            每項功能的真實狀態 -- 已上線、試行中、規劃中或已封鎖 -- 與 /admin
            的「系統真相」分頁完全一致，同一份資料來源。
          </p>
        </div>
      </div>
      <CapabilityRegistryPanel />
    </div>
  );
}
```

In `apps/web/app/(app)/layout.tsx`, add a new unconditional nav link (NOT inside the `isAdmin ? ... : null` block, since `/system-map` has no role gate) between `/jobs` and the `isAdmin` conditional:

```tsx
<Link href="/system-map">
  系統地圖 <span>System map</span>
</Link>
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```powershell
corepack pnpm --filter @wukong/web test -- capability-registry-consistency.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/system-map/page.tsx" apps/web/lib/capability-registry-consistency.test.ts "apps/web/app/(app)/layout.tsx"
git commit -m "feat: add the /system-map page and nav link"
```

---

### Task 4: Full-suite verification

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

**Spec coverage:** §2 (registry) → Task 1. §3 (admin tab) → Task 2. §4 (system-map) + §5's consistency test → Task 3.

**Placeholder scan:** Task 2's Step 4 and Task 3's Step 2 both explicitly flag a point needing the implementer's own verification against real code (exact CSS class names; confirming the consistency test genuinely fails if either surface diverges) rather than trusting the sketch verbatim — deliberate "read and confirm" instructions, not placeholders.

**Type consistency:** `CapabilityEntry`/`CapabilityState` (Task 1) are the exact types `CapabilityRegistryPanel` (Task 2) consumes, and the same component is reused verbatim by `/system-map` (Task 3) — no reshaping, no parallel type definitions.

**Scope check:** one small typed constant module, one shared component + a mechanical tab extension, one new page + nav link — the smallest package this session, matching the design's own estimate.
