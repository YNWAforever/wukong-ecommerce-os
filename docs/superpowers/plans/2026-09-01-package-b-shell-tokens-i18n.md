# Package B — Shell, Tokens, i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt the reference Site's confirmed design tokens, sidebar/bottom-nav/drawer shell structure, and a real shell-scoped locale toggle into the authenticated app shell, with zero behavior change to any existing route's actual functionality.

**Architecture:** `apps/web/app/layout.tsx` (root) and `apps/web/app/(app)/layout.tsx` (authenticated shell) stay Server Components — they resolve session, workspace profile, and the locale cookie, then hand a plain-data nav-items array to a new Client Component, `apps/web/components/app-shell-nav.tsx`, which owns all the interactive chrome (desktop sidebar, mobile bottom-nav, hamburger drawer with focus-trap, locale toggle). Two small new pure-function libraries (`apps/web/lib/locale.ts`, `apps/web/lib/formatting.ts`) back the locale cookie and the new HKD/timestamp formatters.

**Tech Stack:** Next.js App Router (Server + Client Components), TypeScript, Vitest, plain CSS via `app/globals.css` custom properties.

---

## Environment note for every `Run:` step

`pnpm` is not reliably on PATH in this environment. Prefix every command with `corepack`:

```powershell
corepack pnpm --filter @wukong/web test -- <file>
```

If `corepack pnpm typecheck`/`test` (turbo-orchestrated) hits `Unable to find package manager binary`, run `corepack enable --install-directory <a scratch dir>` and prepend that directory to PATH for the rest of that session's commands.

---

## Baseline facts confirmed during planning (read this before Task 1)

- **`apps/web/app/(app)/layout.tsx`'s real current content** (verified directly against `origin/main`, the actual base this branch is built from — a version read from a different, more-advanced branch during design was NOT representative):

```tsx
import Link from "next/link";

import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  const isAdmin = session ? requireWorkspaceRole("admin", session.role) : false;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容 <span>Skip to content</span>
      </a>
      <header className="topbar">
        <div className="brand-lockup">
          <Link
            className="brand-mark"
            href="/dashboard"
            aria-label="Wukong home"
          >
            W
          </Link>
          <div>
            <Link className="brand-name" href="/dashboard">
              Wukong
            </Link>
            <span className="brand-context">Opak Cellar</span>
          </div>
        </div>
        <nav aria-label="主要導覽">
          <Link href="/dashboard">
            工作台 <span>Workspace</span>
          </Link>
          <Link href="/catalog">
            商品中心 <span>Catalog</span>
          </Link>
          <Link href="/listings/new">
            建立草稿 <span>New listing</span>
          </Link>
          <Link href="/listings/import">
            SHOPLINE 匯入 <span>Bulk import</span>
          </Link>
          <Link href="/batches">
            批次 <span>Batches</span>
          </Link>
          {isAdmin ? (
            <Link href="/admin">
              管理 <span>Admin</span>
            </Link>
          ) : null}
        </nav>
        <div className="topbar-meta">
          <span className="pilot-badge">PILOT</span>
          <span className="operator-name">Opak operator</span>
        </div>
      </header>
      <main id="main-content" className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <span>Wukong Ecommerce OS</span>
        <span>Opak Cellar pilot · HKD · en / zh-Hant</span>
      </footer>
    </div>
  );
}
```

Note this already has a skip link (`#main-content`) — Package J's own audit item is already satisfied here, no work needed in this plan.

- **`apps/web/app/layout.tsx` (root)'s real current content:**

```tsx
import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Wukong · Opak Cellar",
  description: "Evidence-backed product listing operations for Opak Cellar.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
```

The `<html lang>` attribute lives here, not in `(app)/layout.tsx` — the locale mechanism (Task 5) touches both files. **Note:** `metadata.title` also hard-codes "Opak Cellar" — this is a real ADR-6-flavored gap, but it requires converting a static `metadata` export to a dynamic `generateMetadata()` function (a different mechanism than anything else in this plan) and was not named in the approved design's file list. **Out of scope for this plan** — flag it as a follow-up when reporting completion, don't fix it here.

- **`apps/web/app/globals.css`'s real current `:root` block** (lines 1–18):

```css
:root {
  --ink: #182432;
  --ink-soft: #506070;
  --muted: #7b8790;
  --navy: #17324d;
  --amber: #b36a24;
  --amber-dark: #8d4e17;
  --amber-soft: #fff2df;
  --stone: #f6f4ef;
  --stone-deep: #ebe8df;
  --surface: #fff;
  --line: #dfe2e1;
  --line-strong: #c7cfcd;
  --success: #2e6b58;
  --danger: #a53e35;
  --radius: 12px;
  --shadow: 0 10px 28px rgb(24 36 50 / 7%);
}
```

- **`packages/db/src/repositories/workspaces.ts`'s real current content** — a workspace-profile repository already exists and is already tested (`workspaces.integration.test.ts`), no new repository method or schema change is needed:

```ts
import { eq } from "drizzle-orm";
import { workspaceProfileSchema, type WorkspaceProfile } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { workspaces } from "../schema.js";

export type WorkspaceRepository = {
  requireProfile(): Promise<WorkspaceProfile>;
  updateProfile(profile: WorkspaceProfile): Promise<void>;
};
```

`WorkspaceProfile` (`packages/core/src/listing-schema.ts:53-68`) has a `name: z.string().min(1)` field — use `profile.name` directly for the brand-context/footer label. It has **no** operator-role-label field, and none should be added: "Opak operator" is not actually workspace-specific copy, it's a generic role-label for the current session's role (`session.role`, already resolved) — fix it with a small static bilingual role-label map, not a workspace-profile read.

- **Locale value spelling:** the codebase's own established convention (root `layout.tsx`'s `lang="zh-Hant"`, `packages/core/src/listing-schema.ts`'s `localizedTextSchema`/`WorkspaceProfile.locales: z.tuple([z.literal("en"), z.literal("zh-Hant")])`) uses `"zh-Hant"`, not `"zh-HK"`. Use `"zh-Hant"` / `"en"` as the two valid locale-cookie values, matching this precedent exactly — **not** `"zh-HK"` (a spelling that appears only in the master plan's prose, never in actual code). This is a distinct concept from the `Intl.DateTimeFormat`/`Intl.NumberFormat` locale argument used for number/date *formatting conventions* (Task 2), which correctly stays `"zh-HK"` (matching the one existing precedent, `dashboard-listings-client.tsx`'s `new Intl.DateTimeFormat("zh-HK", ...)`) — formatting-convention locale and content-language locale are different concerns and are not required to use the same tag.

- **Nav items this package actually ships** (verified against `origin/main`'s real routes — **not** the fuller 7-item list a different, more-advanced branch would have suggested): `/queue`, `/jobs`, `/system-map`, `/quality` do not exist on `main` yet. Sidebar ships with exactly the 5 routes that exist today, reusing their exact current bilingual labels: Overview/`/dashboard` (relabeled from "工作台/Workspace" to "總覽/Overview" per the approved design's explicit adoption of the Site's label), Catalog/`/catalog` ("商品中心/Catalog", unchanged), New listing/`/listings/new` ("建立草稿/New listing", unchanged), Bulk import/`/listings/import` ("SHOPLINE 匯入/Bulk import", unchanged), Batches/`/batches` ("批次/Batches", unchanged). Admin (`/admin`, "管理/Admin", unchanged) stays separately positioned, admin-gated. **No `/system-map` topbar link this round** — that route doesn't exist on this branch's base either.

---

### Task 1: Design tokens

**Files:**
- Modify: `apps/web/app/globals.css:1-18`

- [ ] **Step 1: Edit the `:root` block**

Change line 4 from:
```css
  --muted: #7b8790;
```
to:
```css
  --muted: #5f6e7b;
```

Add two new lines immediately after `--radius: 12px;` (line 16):
```css
  --radius: 12px;
  --radius-card: 16px;
  --nav-active-bg: #edf3f7;
```

The full `:root` block should now read:
```css
:root {
  --ink: #182432;
  --ink-soft: #506070;
  --muted: #5f6e7b;
  --navy: #17324d;
  --amber: #b36a24;
  --amber-dark: #8d4e17;
  --amber-soft: #fff2df;
  --stone: #f6f4ef;
  --stone-deep: #ebe8df;
  --surface: #fff;
  --line: #dfe2e1;
  --line-strong: #c7cfcd;
  --success: #2e6b58;
  --danger: #a53e35;
  --radius: 12px;
  --radius-card: 16px;
  --nav-active-bg: #edf3f7;
  --shadow: 0 10px 28px rgb(24 36 50 / 7%);
}
```

- [ ] **Step 2: Check formatting**

Run:
```powershell
corepack pnpm exec prettier --check apps/web/app/globals.css
```
Expected: PASS. If it fails, run `corepack pnpm exec prettier --write apps/web/app/globals.css` and re-check.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat: fix the --muted value and add --radius-card/--nav-active-bg tokens"
```

---

### Task 2: Formatting utilities

**Files:**
- Create: `apps/web/lib/formatting.ts`
- Create: `apps/web/lib/formatting.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/formatting.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatHkd, formatHkTimestamp } from "./formatting.js";

describe("formatHkd", () => {
  it("formats a whole-dollar amount with the HK$ symbol and no decimals when the amount is a whole number", () => {
    expect(formatHkd(288)).toBe("HK$288");
  });

  it("formats zero", () => {
    expect(formatHkd(0)).toBe("HK$0");
  });

  it("formats a large amount with thousands separators", () => {
    expect(formatHkd(1234567)).toBe("HK$1,234,567");
  });

  it("formats a fractional amount with exactly two decimal places", () => {
    expect(formatHkd(288.5)).toBe("HK$288.50");
  });
});

describe("formatHkTimestamp", () => {
  it("formats a known instant in the Asia/Hong_Kong timezone", () => {
    // 2026-01-15T04:30:00Z is 2026-01-15 12:30 in Asia/Hong_Kong (UTC+8, no DST).
    const result = formatHkTimestamp(new Date("2026-01-15T04:30:00Z"));
    expect(result).toContain("2026");
    expect(result).toContain("12:30");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- formatting.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/lib/formatting.ts`:

```ts
const HKD_WHOLE_FORMATTER = new Intl.NumberFormat("zh-HK", {
  style: "currency",
  currency: "HKD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const HKD_FRACTIONAL_FORMATTER = new Intl.NumberFormat("zh-HK", {
  style: "currency",
  currency: "HKD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const HK_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("zh-HK", {
  timeZone: "Asia/Hong_Kong",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatHkd(amountHkd: number): string {
  const isWholeNumber = Number.isInteger(amountHkd);
  const formatter = isWholeNumber ? HKD_WHOLE_FORMATTER : HKD_FRACTIONAL_FORMATTER;
  return formatter.format(amountHkd);
}

export function formatHkTimestamp(date: Date): string {
  return HK_TIMESTAMP_FORMATTER.format(date);
}
```

Re-derive the exact `formatHkd` output against the real `Intl.NumberFormat("zh-HK", {style: "currency", currency: "HKD", currencyDisplay: "narrowSymbol"})` behavior in your actual Node runtime before trusting the sketch verbatim — `currencyDisplay: "narrowSymbol"` should produce `HK$` for the HKD currency under the `zh-HK` locale, but Node's ICU data can vary by build; if the real output differs (e.g. `$` instead of `HK$`, or a different thousands-separator character), adjust the implementation to match reality and update the test's expected strings to match, rather than forcing a mismatch.

- [ ] **Step 4: Run the test, adjust to match real `Intl` output, and confirm it passes**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- formatting.test.ts
```
Expected: PASS, all 5 tests. If `formatHkd`'s exact symbol/spacing doesn't match on the first run, update both the implementation and the test's expected strings together based on what `Intl.NumberFormat` actually produces in this environment, then re-run until green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/formatting.ts apps/web/lib/formatting.test.ts
git commit -m "feat: add formatHkd/formatHkTimestamp formatting utilities"
```

---

### Task 3: Locale-cookie utility

**Files:**
- Create: `apps/web/lib/locale.ts`
- Create: `apps/web/lib/locale.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/locale.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { LOCALE_COOKIE_NAME, DEFAULT_LOCALE, resolveLocale } from "./locale.js";

describe("resolveLocale", () => {
  it("returns zh-Hant for a valid zh-Hant cookie value", () => {
    expect(resolveLocale("zh-Hant")).toBe("zh-Hant");
  });

  it("returns en for a valid en cookie value", () => {
    expect(resolveLocale("en")).toBe("en");
  });

  it("falls back to the default for an invalid value", () => {
    expect(resolveLocale("fr")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for undefined (no cookie set)", () => {
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for an empty string", () => {
    expect(resolveLocale("")).toBe(DEFAULT_LOCALE);
  });
});

describe("constants", () => {
  it("defaults to zh-Hant", () => {
    expect(DEFAULT_LOCALE).toBe("zh-Hant");
  });

  it("names a real cookie", () => {
    expect(LOCALE_COOKIE_NAME).toBe("locale");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- locale.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Create `apps/web/lib/locale.ts`:

```ts
export const LOCALE_COOKIE_NAME = "locale";
export const DEFAULT_LOCALE = "zh-Hant";

export type Locale = "zh-Hant" | "en";

const VALID_LOCALES: readonly Locale[] = ["zh-Hant", "en"];

export function resolveLocale(value: string | undefined): Locale {
  if (value && (VALID_LOCALES as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return DEFAULT_LOCALE;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- locale.test.ts
```
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/locale.ts apps/web/lib/locale.test.ts
git commit -m "feat: add the locale-cookie resolution utility"
```

---

### Task 4: `AppShellNav` client component

**Files:**
- Create: `apps/web/components/app-shell-nav.tsx`
- Create: `apps/web/components/app-shell-nav.test.tsx`

- [ ] **Step 1: Read the closest existing client-component pattern**

Read `apps/web/components/jobs-ledger-client.tsx` (or any other `"use client"` component in `apps/web/components/`) for this codebase's conventions: `"use client"` directive at the top, `useState`/`useEffect` usage style, no external UI library (plain JSX + CSS classes only — no Tailwind, no shadcn/ui, per this repo's CLAUDE.md).

- [ ] **Step 2: Write the failing tests**

Create `apps/web/components/app-shell-nav.test.tsx`:

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppShellNav, type NavItem } from "./app-shell-nav.js";

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "總覽", labelEn: "Overview" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/listings/new", labelZh: "建立草稿", labelEn: "New listing" },
  { href: "/listings/import", labelZh: "SHOPLINE 匯入", labelEn: "Bulk import" },
  { href: "/batches", labelZh: "批次", labelEn: "Batches" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("AppShellNav", () => {
  it("renders every nav item plus Admin when isAdmin is true", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={true}
        workspaceName="Opak Cellar"
        roleLabelZh="操作員"
        roleLabelEn="Operator"
        initialLocale="zh-Hant"
      />,
    );
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    for (const item of NAV_ITEMS) {
      expect(hrefs).toContain(item.href);
    }
    expect(hrefs).toContain("/admin");
  });

  it("omits Admin when isAdmin is false", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("/admin");
  });

  it("renders the workspace name from props, not a hard-coded string", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Distinct Test Workspace Name"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    expect(container.textContent).toContain("Distinct Test Workspace Name");
    expect(container.textContent).not.toContain("Opak Cellar");
  });

  it("opens the mobile drawer, traps focus inside it, and restores focus to the trigger on close", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-trigger"]',
    );
    expect(trigger).not.toBeNull();

    act(() => {
      trigger!.click();
    });

    const drawer = container.querySelector<HTMLElement>('[data-testid="drawer"]');
    expect(drawer).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(drawer!.contains(document.activeElement)).toBe(true);

    // Tab beyond the last focusable element inside the drawer must wrap back
    // to the first one, not escape the drawer.
    const focusable = drawer!.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    const last = focusable[focusable.length - 1]!;
    act(() => {
      last.focus();
    });
    act(() => {
      last.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(drawer!.contains(document.activeElement)).toBe(true);

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-close"]',
    );
    act(() => {
      closeButton!.click();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("sets the locale cookie and calls the onLocaleChange callback when the toggle is clicked", () => {
    let receivedLocale: string | null = null;
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
        onLocaleChange={(locale) => {
          receivedLocale = locale;
        }}
      />,
    );
    const enButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="locale-toggle-en"]',
    );
    act(() => {
      enButton!.click();
    });
    expect(receivedLocale).toBe("en");
    expect(document.cookie).toContain("locale=en");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- app-shell-nav.test.tsx
```
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

Create `apps/web/components/app-shell-nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type NavItem = {
  href: string;
  labelZh: string;
  labelEn: string;
};

export type Locale = "zh-Hant" | "en";

type AppShellNavProps = {
  navItems: NavItem[];
  isAdmin: boolean;
  workspaceName: string;
  roleLabelZh: string;
  roleLabelEn: string;
  initialLocale: Locale;
  onLocaleChange?: (locale: Locale) => void;
};

const MOBILE_NAV_COUNT = 4;
const LOCALE_COOKIE_NAME = "locale";
const ADMIN_ITEM: NavItem = { href: "/admin", labelZh: "管理", labelEn: "Admin" };

function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000`;
}

export function AppShellNav({
  navItems,
  isAdmin,
  workspaceName,
  roleLabelZh,
  roleLabelEn,
  initialLocale,
  onLocaleChange,
}: AppShellNavProps) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const fullNav = isAdmin ? [...navItems, ADMIN_ITEM] : navItems;
  const mobileNav = navItems.slice(0, MOBILE_NAV_COUNT);
  const label = (item: NavItem) =>
    locale === "zh-Hant" ? (
      <>
        {item.labelZh} <span>{item.labelEn}</span>
      </>
    ) : (
      <>{item.labelEn}</>
    );

  function changeLocale(next: Locale) {
    setLocale(next);
    setLocaleCookie(next);
    onLocaleChange?.(next);
  }

  function openDrawer() {
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const focusable = () =>
      Array.from(
        drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
      );

    focusable()[0]?.focus();

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    drawer.addEventListener("keydown", handleKeydown);
    return () => drawer.removeEventListener("keydown", handleKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

  return (
    <>
      <div className="brand-lockup">
        <Link className="brand-mark" href="/dashboard" aria-label="Wukong home">
          W
        </Link>
        <div>
          <Link className="brand-name" href="/dashboard">
            Wukong
          </Link>
          <span className="brand-context">{workspaceName}</span>
        </div>
      </div>

      <nav className="app-sidebar" aria-label="主要導覽">
        {navItems.map((item) => (
          <Link key={item.href} href={item.href}>
            {label(item)}
          </Link>
        ))}
      </nav>

      {isAdmin ? (
        <div className="app-sidebar-admin">
          <Link href="/admin">{label(ADMIN_ITEM)}</Link>
        </div>
      ) : null}

      <div className="locale-toggle" role="group" aria-label="介面語言">
        <button
          type="button"
          data-testid="locale-toggle-zh"
          aria-pressed={locale === "zh-Hant"}
          onClick={() => changeLocale("zh-Hant")}
        >
          繁中
        </button>
        <button
          type="button"
          data-testid="locale-toggle-en"
          aria-pressed={locale === "en"}
          onClick={() => changeLocale("en")}
        >
          EN
        </button>
      </div>

      <nav className="app-bottom-nav" aria-label="流動版主要導覽">
        {mobileNav.map((item) => (
          <Link key={item.href} href={item.href}>
            {label(item)}
          </Link>
        ))}
        <button
          type="button"
          ref={triggerRef}
          data-testid="drawer-trigger"
          aria-expanded={drawerOpen}
          onClick={openDrawer}
        >
          {locale === "zh-Hant" ? (
            <>開啟導覽 <span>Open navigation</span></>
          ) : (
            "Open navigation"
          )}
        </button>
      </nav>

      {drawerOpen ? (
        <div className="app-drawer" data-testid="drawer" ref={drawerRef} role="dialog" aria-modal="true">
          <button type="button" data-testid="drawer-close" onClick={closeDrawer}>
            {locale === "zh-Hant" ? (
              <>關閉 <span>Close</span></>
            ) : (
              "Close"
            )}
          </button>
          <nav aria-label="流動版完整導覽">
            {fullNav.map((item) => (
              <Link key={item.href} href={item.href} onClick={closeDrawer}>
                {label(item)}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}

      <div className="topbar-meta">
        <span className="pilot-badge">PILOT</span>
        <span className="operator-name">
          {locale === "zh-Hant" ? (
            <>{roleLabelZh} <span>{roleLabelEn}</span></>
          ) : (
            roleLabelEn
          )}
        </span>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Run the tests and iterate until they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- app-shell-nav.test.tsx
```
Expected: PASS, all 5 tests. The focus-trap test is the one most likely to need real debugging against actual DOM/focus behavior in the test environment (jsdom) — don't weaken the assertions to make it pass; fix the implementation until the real behavior (focus moves into the drawer on open, `Tab` wraps within the drawer, closing restores focus to the trigger) is genuinely correct.

- [ ] **Step 6: Verify the focus-trap test is genuinely load-bearing**

Temporarily comment out the `handleKeydown` function's `Tab`-wrapping logic (the `if (event.shiftKey && ...) ... else if (!event.shiftKey && ...) ...` block) inside the `useEffect`, leaving only the `Escape` handling. Re-run the test file and confirm the "traps focus inside it" test now FAILS. Restore the code and confirm the test passes again. This proves the test actually catches a broken focus trap, not just a coincidentally-passing assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/app-shell-nav.tsx apps/web/components/app-shell-nav.test.tsx
git commit -m "feat: add the AppShellNav client component (sidebar, bottom-nav, drawer, locale toggle)"
```

---

### Task 5: Wire the shell together

**Files:**
- Modify: `apps/web/app/(app)/layout.tsx` (full content shown in "Baseline facts" above)
- Modify: `apps/web/app/layout.tsx` (full content shown in "Baseline facts" above)
- Create: `apps/web/app/(app)/layout.test.tsx`

- [ ] **Step 1: Write the failing shell-render test**

Create `apps/web/app/(app)/layout.test.tsx`. This test can't easily render the full async Server Component tree with real `cookies()`/session resolution in a unit test, so it tests the pure nav-item-construction logic as an exported, separately-testable function rather than the page component itself — read `apps/web/lib/session-context.ts` first to confirm the exact `WorkspaceRole` union (`"viewer" | "operator" | "reviewer" | "admin" | "owner"`) before writing this test.

```tsx
import { describe, expect, it } from "vitest";

import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items.js";

describe("SHELL_NAV_ITEMS", () => {
  it("has exactly the 5 routes that exist on this branch, in the Site's confirmed order", () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/catalog",
      "/listings/new",
      "/listings/import",
      "/batches",
    ]);
  });

  it("does not include /queue, /jobs, /system-map, or /quality", () => {
    const hrefs = SHELL_NAV_ITEMS.map((item) => item.href);
    expect(hrefs).not.toContain("/queue");
    expect(hrefs).not.toContain("/jobs");
    expect(hrefs).not.toContain("/system-map");
    expect(hrefs).not.toContain("/quality");
  });
});

describe("ROLE_LABELS", () => {
  it("has a bilingual label for every WorkspaceRole", () => {
    for (const role of ["viewer", "operator", "reviewer", "admin", "owner"] as const) {
      expect(ROLE_LABELS[role].zh).toBeTruthy();
      expect(ROLE_LABELS[role].en).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- "apps/web/app/(app)/layout.test.tsx"
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `shell-nav-items.ts`**

Create `apps/web/app/(app)/shell-nav-items.ts`:

```ts
import type { NavItem } from "../../components/app-shell-nav.js";
import type { WorkspaceRole } from "../../lib/session-context.js";

export const SHELL_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "總覽", labelEn: "Overview" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/listings/new", labelZh: "建立草稿", labelEn: "New listing" },
  { href: "/listings/import", labelZh: "SHOPLINE 匯入", labelEn: "Bulk import" },
  { href: "/batches", labelZh: "批次", labelEn: "Batches" },
];

export const ROLE_LABELS: Record<WorkspaceRole, { zh: string; en: string }> = {
  viewer: { zh: "檢視者", en: "Viewer" },
  operator: { zh: "操作員", en: "Operator" },
  reviewer: { zh: "審閱者", en: "Reviewer" },
  admin: { zh: "管理員", en: "Admin" },
  owner: { zh: "擁有者", en: "Owner" },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```powershell
corepack pnpm --filter @wukong/web test -- "apps/web/app/(app)/layout.test.tsx"
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Rewrite `apps/web/app/(app)/layout.tsx`**

Replace the full file with:

```tsx
import { cookies } from "next/headers";

import { AppShellNav } from "../../components/app-shell-nav";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";
import { getDatabase } from "../../lib/intake-runtime";
import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  const isAdmin = session ? requireWorkspaceRole("admin", session.role) : false;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  const workspaceName = session
    ? await getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.workspaces.requireProfile(),
        )
        .then((profile) => profile.name)
    : "Wukong";

  const roleLabel = session ? ROLE_LABELS[session.role] : ROLE_LABELS.viewer;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容 <span>Skip to content</span>
      </a>
      <header className="topbar">
        <AppShellNav
          navItems={SHELL_NAV_ITEMS}
          isAdmin={isAdmin}
          workspaceName={workspaceName}
          roleLabelZh={roleLabel.zh}
          roleLabelEn={roleLabel.en}
          initialLocale={locale}
        />
      </header>
      <main id="main-content" className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <span>Wukong Ecommerce OS</span>
        <span>{workspaceName} pilot · HKD · en / zh-Hant</span>
      </footer>
    </div>
  );
}
```

Read `apps/web/lib/intake-runtime.ts` first to confirm `getDatabase()`'s real export name and signature match this usage (it's already used this way by other routes, e.g. `apps/web/app/api/quality/route.ts` — cross-check against that file's exact import/call pattern) before trusting this sketch verbatim; adjust the import path/call shape if it differs.

- [ ] **Step 6: Rewrite `apps/web/app/layout.tsx`**

Replace the full file with:

```tsx
import { cookies } from "next/headers";
import type { Metadata } from "next";

import "./globals.css";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../lib/locale";

export const metadata: Metadata = {
  title: "Wukong · Opak Cellar",
  description: "Evidence-backed product listing operations for Opak Cellar.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
```

`metadata.title` stays hard-coded (see the "Baseline facts" section's explicit note — out of scope for this plan).

- [ ] **Step 7: Typecheck**

Run:
```powershell
corepack pnpm --filter @wukong/web exec tsc --noEmit
```
Expected: PASS. Fix any type errors surfaced by the real `WorkspaceRole`/`NavItem`/`getDatabase()` shapes before proceeding — the sketches above may need small adjustments once checked against the real types.

- [ ] **Step 8: Run the full `@wukong/web` test suite**

Run:
```powershell
corepack pnpm --filter @wukong/web test
```
Expected: PASS, including every test written in Tasks 2-5. Fix any test broken by the shell rewrite (e.g. an existing test that renders `(app)/layout.tsx` or asserts on the old "Opak Cellar"/"Opak operator" strings) — search first: `corepack pnpm --filter @wukong/web exec vitest run --reporter=verbose 2>&1 | grep -i "opak\|layout"` to find any such test before assuming none exist.

- [ ] **Step 9: Format check**

Run:
```powershell
corepack pnpm exec prettier --check "apps/web/app/(app)/layout.tsx" apps/web/app/layout.tsx "apps/web/app/(app)/shell-nav-items.ts" "apps/web/app/(app)/layout.test.tsx"
```
Expected: PASS, or fix with `--write` and re-check.

- [ ] **Step 10: Commit**

```bash
git add "apps/web/app/(app)/layout.tsx" apps/web/app/layout.tsx "apps/web/app/(app)/shell-nav-items.ts" "apps/web/app/(app)/layout.test.tsx"
git commit -m "feat: wire the sidebar shell, locale mechanism, and workspace-derived labels into the app layout"
```

---

### Task 6: Full-suite verification

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
This package adds no database schema changes — no new integration tests are expected, but run this to confirm no regression. If Postgres is unreachable, state that explicitly rather than reporting this step as passed.

- [ ] **Step 5: `pnpm runtime:forbidden:check`**

Run:
```powershell
corepack pnpm runtime:forbidden:check
```
Expected: PASS.

- [ ] **Step 6: Manual smoke check**

Start the dev server (`corepack pnpm --filter @wukong/web dev`) and visually confirm in a browser: the sidebar renders with exactly 5 items + Admin (if signed in as admin), the mobile viewport (375px) shows a bottom-nav with 4 items and a working hamburger drawer, the locale toggle switches the shell's nav/footer/topbar text between Chinese and English, and no page's own content (dashboard, catalog, etc.) changed. This is a manual acceptance step per the design's own scope — no automated visual-regression test is required by this plan.

---

## Self-Review

**Spec coverage:** §2 (tokens) → Task 1. §3 (shell structure, including the nav-completeness correction found during planning) → Tasks 4-5. §4 (locale, shell-only) → Tasks 3, 5. §5 (workspace-derived labels) → Task 5. §6 (formatting utilities) → Task 2.

**Placeholder scan:** Task 2's Step 3 explicitly flags the exact currency-symbol string as something to verify against real `Intl` output rather than trust blindly — a deliberate "verify and adjust" instruction with a concrete fallback path, not an unresolved TBD. Task 5's Step 5 similarly flags `getDatabase()`'s exact signature as something to cross-check against a real, already-existing call site.

**Type consistency:** `NavItem` (Task 4) is imported and reused unchanged by `shell-nav-items.ts` (Task 5). `Locale` (Tasks 3 and 4) both resolve to the same `"zh-Hant" | "en"` union — Task 4's own `Locale` type alias should be checked for consistency with Task 3's `locale.ts` export during implementation (consider importing Task 3's `Locale` type directly into `app-shell-nav.tsx` rather than redeclaring it, if that turns out cleaner).

**Scope check:** six tasks, five of them touching a distinct, focused file (or file pair); only Task 5 touches multiple files, and all of them are the shell's own wiring — comparable in size to this session's other M-sized packages (`/jobs` ledger, capability registry).
