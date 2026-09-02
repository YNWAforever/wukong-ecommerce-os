# Package C — Public Entry and Auth Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/`, `/signin`, `/register`, `/register/set-password`, `/forgot-password`, `/reset-password` adopt the Site's two-panel visual layout and full bilingual copy, with zero change to existing authentication behavior, plus a small real fix (a proactive invalid/expired-link state) and a documentation-only resolution of the CSRF/cookie question (G10).

**Architecture:** A new `(auth)` route group (mirroring the existing `(app)` group's convention exactly) hosts the 5 auth pages under a shared `layout.tsx` that renders a new client component, `AuthShell` — the two-panel brand/card structure. `AuthForm` gains a `locale` prop and bilingual copy, reusing Package B's existing `resolveLocale`/cookie infrastructure (each page independently resolves locale server-side, matching the established precedent of `(app)/layout.tsx` and `dashboard/page.tsx` both independently resolving their own session/locale rather than threading props through the file-based routing boundary). The invalid-token state is a pure read of a query parameter Better Auth's own token-validation redirect already sets — no new server-side validation logic.

**Tech Stack:** Next.js App Router, TypeScript, React 19, plain CSS, Vitest + happy-dom.

---

## Environment note for every `Run:` step

`pnpm` is not reliably on PATH in this environment. Prefix every command with `corepack`:

```powershell
corepack pnpm --filter @wukong/web test -- <file>
```

If `corepack pnpm typecheck` (turbo-orchestrated) hits `Unable to find package manager binary`, run `corepack enable --install-directory <a scratch dir>` and prepend that directory to PATH for the rest of that session's commands.

---

## Baseline facts confirmed during planning (read this before Task 1)

- **All 5 auth pages today share an identical, duplicated structure** (confirmed by reading all 5 files in full):

```tsx
// apps/web/app/signin/page.tsx (representative of all 5 — register, register/set-password,
// forgot-password, reset-password all follow the exact same signin-shell/signin-card/
// signin-brand/eyebrow pattern, differing only in the aria-label string and the AuthForm mode/props)
import { AuthForm } from "../../components/auth-form";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = (await searchParams) ?? {};
  const value = params.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;

  const initialStatus =
    params.registered === "1"
      ? "Your password is ready. Sign in to continue."
      : params.reset === "1"
        ? "Your password has been reset. Sign in to continue."
        : "";
  return (
    <main className="signin-shell">
      <section className="signin-card" aria-label="Opak Cellar sign in">
        <div className="signin-brand" aria-hidden="true">
          W
        </div>
        <p className="eyebrow">Wukong / Opak Cellar</p>
        <AuthForm
          mode="password-signin"
          callbackUrl={callbackUrl}
          initialStatus={initialStatus}
        />
      </section>
    </main>
  );
}
```

- **`apps/web/components/auth-form.tsx`'s real, current, full content** — already 100% English, `modeCopy(mode)` returns `{heading, intro, submit}` per mode, `isPasswordMode`/`isCompletionMode` helpers, `handleSubmit` posts to one of 5 API routes depending on mode, renders `auth-tabs` (signin-mode only)/`auth-heading`/`auth-form`/`auth-links`. This is the file already shown in full during design research — read it again directly before editing (`apps/web/components/auth-form.tsx`), since this plan's later steps quote specific line-level replacements that must match the real current file exactly.
- **`apps/web/components/auth-form.test.tsx`'s real, current tests hard-code English strings that will break if `AuthForm` defaults to a different locale once bilingual support is added** — confirmed by reading the file in full. Specifically: line ~205-207 finds a button by `button.textContent === "Magic link"`; line ~259 checks `container.textContent).toContain("Password must be between 12 and 128 characters.")`; line ~275 checks for `"Unable to complete this request."`. None of these tests currently pass a `locale` prop to `mount()` (there is no such prop today). **Task 2 below must update this test file's `mount()` helper to default to `locale: "en"`** so all these existing assertions keep passing unchanged, and add new, separate tests for zh-Hant rendering. This is a real, load-bearing detail discovered by reading the test file directly, not a hypothetical risk.
- **The CSS `.auth-status::before { content: "Status: "; }` rule** (`apps/web/app/globals.css`, in the auth CSS block starting around line 1321) hard-codes an English label via CSS generated content — this must move into real, locale-aware JSX text as part of making the status region bilingual (Task 2), since a CSS `content:` string cannot be conditionally translated per-locale without a `[lang]`-attribute selector hack, which is more fragile than just rendering real text.
- **Package B's real locale infrastructure** (`apps/web/lib/locale.ts`, unchanged by this plan except Task 1's extraction): `LOCALE_COOKIE_NAME = "locale"`, `DEFAULT_LOCALE = "zh-Hant"`, `type Locale = "zh-Hant" | "en"`, `resolveLocale(value): Locale`. The root layout (`apps/web/app/layout.tsx`) already resolves this server-side for `<html lang>` on every route, auth pages included — confirmed by reading the file:

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

- **Package B's real locale-toggle pattern** (`apps/web/components/app-shell-nav.tsx`), confirmed by reading it: a plain `document.cookie` write with a 1-year max-age, client-side `useState` for immediate reactivity, and **no** `router.refresh()` call anywhere — switching locale changes only the client-rendered labels immediately and persists via the cookie for the _next_ navigation/reload; it does not force other already-rendered server content to re-render. This plan's `AuthShell` toggle follows the identical pattern, not a new one:

```ts
function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000`;
}
```

- **The established "each page independently resolves its own session-derived data" precedent**: Package D's code-quality review explicitly noted `apps/web/app/(app)/dashboard/page.tsx` re-resolving session/workspace data that `apps/web/app/(app)/layout.tsx` already resolved, and accepted it as "consistent with existing convention" rather than a bug — matching Next.js App Router's real constraint that a `layout.tsx` cannot pass arbitrary props down to a `page.tsx` child (only `children`, `params`, `searchParams` cross that boundary). This plan's 5 auth pages each independently call `cookies()` + `resolveLocale()` themselves (in addition to `(auth)/layout.tsx` doing the same for the brand panel), rather than inventing a new prop-threading mechanism.
- **The real Better Auth 1.5.5 invalid-token mechanism**, confirmed by reading the installed package's source (`node_modules/.pnpm/better-auth@1.5.5.../dist/api/routes/password.mjs`): both the invite flow (`requestEnrollment` in `apps/web/lib/auth-flow.ts` calls Better Auth's own `POST /api/auth/request-password-reset`) and the forgot-password flow use the identical underlying token type. The email link in both cases points at Better Auth's own `GET /api/auth/reset-password/:token`, which validates the token **before the user ever reaches our page** and redirects to our `callbackURL` with either `?token=<value>` (valid) or `?error=INVALID_TOKEN` (missing/unknown/expired) — no `token` param in the error case. Today, both `apps/web/app/register/set-password/page.tsx` and `apps/web/app/reset-password/page.tsx` read `token`/`callbackUrl` from `searchParams` but never read `error`, so an expired-link visit silently renders the full form anyway.
- **No other source file imports any of the 5 auth page files by path** (confirmed via repo-wide grep, excluding the auto-regenerated `.next/types/validator.ts` build artifact) — moving them into a new `(auth)` route group is safe.
- **`apps/web/middleware.ts` references these routes only as literal URL-path strings** (`"/signin"`, `"/register"`, etc.), never as file-system import paths — confirmed by reading it. Route groups (`(auth)`) never appear in the actual URL, so middleware behavior is unaffected by the file move in Task 4.
- **The Site's real, confirmed `/signin` copy** (browsed directly, both via screenshot and `get_page_text`, desktop 1280px and mobile 375px):

```
WK Wukong / CATALOG OPERATIONS OS   [繁中] [EN]

Evidence-first 商品目錄營運
先核實證據，再批准內容。
Wukong 將來源檔、AI 建議、人手審批及 SHOPLINE 匯入證明分開管理，避免把已產生檔案誤當成已完成更新。

71 SHOPLINE 範本欄位   8 可修改內容欄位   0 直接 SHOPLINE 寫入

存取原則
✓ 邀請制帳戶及工作區成員資格
✓ 角色權限必須由後端強制執行
✓ 所有輸出保留人工審批關卡
✓ 正式環境直接寫入維持停用

[card:]
歡迎回來
登入 Wukong 工作區
使用已獲邀請及由工作區管理員核准的帳戶登入。
工作電郵 / 密碼 / 忘記密碼？
```

On mobile (375px, confirmed via screenshot), the brand panel collapses to just the top navy bar (logo + locale toggle) — the tagline/stats/principles content does not render below ~1024px.

---

### Task 1: Extract the locale-cookie helper into a shared module

**Files:**

- Modify: `apps/web/lib/locale.ts`
- Modify: `apps/web/lib/locale.test.ts`
- Modify: `apps/web/components/app-shell-nav.tsx`

- [ ] **Step 1: Read the current `apps/web/lib/locale.ts` and `apps/web/lib/locale.test.ts` in full**

Confirm the exact current exports and test conventions before editing.

- [ ] **Step 2: Write the failing test**

Add to `apps/web/lib/locale.test.ts`:

```ts
it("writes a one-year, root-path locale cookie", () => {
  const original = document.cookie;
  try {
    document.cookie = "locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    setLocaleCookie("en");
    expect(document.cookie).toContain("locale=en");
  } finally {
    document.cookie = original;
  }
});
```

Add the import at the top of the test file: `import { ..., setLocaleCookie } from "./locale";` (merge into whatever import statement already exists).

Note: this test needs a DOM (`document`) — check the file's existing `// @vitest-environment` pragma; if it currently runs under the default `node` environment (no DOM), add `// @vitest-environment happy-dom` as the very first line of the file (before any imports), matching the pragma style used in `apps/web/components/auth-form.test.tsx`.

- [ ] **Step 3: Run it, confirm it fails**

```
corepack pnpm --filter @wukong/web exec vitest run lib/locale.test.ts
```

Expected: FAIL — `setLocaleCookie is not exported` (or not defined).

- [ ] **Step 4: Add `setLocaleCookie` to `apps/web/lib/locale.ts`**

```ts
export function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000`;
}
```

- [ ] **Step 5: Run the test, confirm it passes**

```
corepack pnpm --filter @wukong/web exec vitest run lib/locale.test.ts
```

- [ ] **Step 6: Update `apps/web/components/app-shell-nav.tsx` to import the shared helper**

Remove its local `setLocaleCookie` function definition:

```ts
function setLocaleCookie(locale: Locale) {
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=31536000`;
}
```

Add `setLocaleCookie` to its existing `import { LOCALE_COOKIE_NAME, type Locale } from "../lib/locale";` line (becomes `import { LOCALE_COOKIE_NAME, setLocaleCookie, type Locale } from "../lib/locale";`) — drop `LOCALE_COOKIE_NAME` from this import if nothing else in the file uses it directly after removing the local function (check first; if `LOCALE_COOKIE_NAME` is now unused in this file, remove it from the import to avoid an unused-import lint/type error).

- [ ] **Step 7: Run the full existing shell-nav test suite, confirm no regression**

```
corepack pnpm --filter @wukong/web exec vitest run components/app-shell-nav.test.tsx
```

- [ ] **Step 8: Typecheck**

```
corepack pnpm --filter @wukong/web exec tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/locale.ts apps/web/lib/locale.test.ts apps/web/components/app-shell-nav.tsx
git commit -m "$(cat <<'EOF'
refactor: share the locale-cookie writer between the shell nav and the new auth layout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Make `AuthForm` locale-aware

**Files:**

- Modify: `apps/web/components/auth-form.tsx`
- Modify: `apps/web/components/auth-form.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Read `apps/web/components/auth-form.tsx` and `apps/web/components/auth-form.test.tsx` in full**

Confirm the exact current content before editing — this plan's snippets below must be applied against the real current file, not a paraphrase.

- [ ] **Step 2: Update `auth-form.test.tsx`'s `mount()` helper to default to English, preserving every existing assertion**

Change:

```ts
async function mount(
  mode: AuthFormMode,
  props: { callbackUrl?: string; token?: string; initialStatus?: string } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AuthForm mode={mode} {...props} />);
  });
  return container;
}
```

to:

```ts
async function mount(
  mode: AuthFormMode,
  props: {
    callbackUrl?: string;
    token?: string;
    initialStatus?: string;
    locale?: "zh-Hant" | "en";
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { locale = "en", ...rest } = props;
  await act(async () => {
    root.render(<AuthForm mode={mode} locale={locale} {...rest} />);
  });
  return container;
}
```

This makes every existing call site (none of which pass `locale`) keep rendering English copy exactly as before — no other line in the existing test file needs to change.

- [ ] **Step 3: Add new zh-Hant rendering tests**

Append to the `describe("AuthForm", ...)` block:

```ts
it("renders zh-Hant copy when locale is zh-Hant", async () => {
  const container = await mount("password-signin", { locale: "zh-Hant" });
  expect(container.textContent).toContain("登入");
  expect(container.textContent).not.toContain("Welcome back");
});

it("renders English copy when locale is en", async () => {
  const container = await mount("password-signin", { locale: "en" });
  expect(container.textContent).toContain("Welcome back");
});
```

(Exact expected zh-Hant substring must match whatever string Step 5 below actually assigns for `password-signin`'s heading — write this test AFTER Step 5, or adjust the asserted substring to match once Step 5's real copy is written; do not leave a guessed string unverified.)

- [ ] **Step 4: Run the tests, confirm the new ones fail and all old ones still pass their CURRENT (pre-Step-5) assertions**

```
corepack pnpm --filter @wukong/web exec vitest run components/auth-form.test.tsx
```

Expected: the 2 new tests FAIL (`locale` prop not yet accepted/used by `AuthForm`); every pre-existing test still PASSES (since `AuthForm` doesn't yet require or read a `locale` prop — an extra unused prop is harmless to a component that doesn't destructure it yet).

- [ ] **Step 5: Add bilingual copy to `auth-form.tsx`**

Add `Locale` to the imports: `import { type Locale } from "../lib/locale";` (merge with any existing import from this path if one exists — check first; there is likely none yet in this file, so add a new import line).

Change `AuthFormProps` to require `locale`:

```ts
type AuthFormProps = {
  mode: AuthFormMode;
  locale: Locale;
  callbackUrl?: string;
  initialStatus?: string;
  token?: string;
};
```

Replace the module-level English constants with locale-aware functions:

```ts
function genericError(locale: Locale): string {
  return locale === "zh-Hant"
    ? "無法完成此請求。"
    : "Unable to complete this request.";
}
function emailSuccess(locale: Locale): string {
  return locale === "zh-Hant"
    ? "如此地址符合資格，郵件將於稍後送達。"
    : "If this address is eligible, an email will arrive shortly.";
}
```

(Remove the old `const GENERIC_ERROR = "...";` and `const EMAIL_SUCCESS = "...";` module-level constants entirely — every call site below uses the function form instead, parameterized by `locale`.)

Replace `modeCopy`:

```ts
function modeCopy(mode: AuthFormMode, locale: Locale) {
  if (locale === "zh-Hant") {
    switch (mode) {
      case "password-signin":
        return {
          heading: "歡迎回來",
          intro: "登入以管理商品上架內容。",
          submit: "使用密碼登入",
        };
      case "magic-link":
        return {
          heading: "電郵登入",
          intro: "請求一個安全登入連結寄至你的收件匣。",
          submit: "傳送登入連結給我",
        };
      case "register":
        return {
          heading: "完成受邀登記",
          intro: "請使用邀請電郵內的連結建立帳戶。",
          submit: "傳送登記電郵",
        };
      case "set-password":
        return {
          heading: "設定你的密碼",
          intro: "完成已驗證的登記，設定一組安全密碼。",
          submit: "建立密碼",
        };
      case "forgot-password":
        return {
          heading: "重設你的密碼",
          intro: "請求一封安全的密碼重設電郵。",
          submit: "傳送重設電郵",
        };
      case "reset-password":
        return {
          heading: "選擇新密碼",
          intro: "輸入並確認你的新密碼。",
          submit: "重設密碼",
        };
    }
  }
  switch (mode) {
    case "password-signin":
      return {
        heading: "Welcome back",
        intro: "Sign in to manage Opak Cellar listings.",
        submit: "Sign in with password",
      };
    case "magic-link":
      return {
        heading: "Email sign-in",
        intro: "Request a secure sign-in link for your inbox.",
        submit: "Email me a magic link",
      };
    case "register":
      return {
        heading: "Request admin access",
        intro: "Use the invited email address to begin registration.",
        submit: "Send registration email",
      };
    case "set-password":
      return {
        heading: "Create your password",
        intro: "Finish your verified registration with a secure password.",
        submit: "Create password",
      };
    case "forgot-password":
      return {
        heading: "Reset your password",
        intro: "Request a secure password reset email.",
        submit: "Send reset email",
      };
    case "reset-password":
      return {
        heading: "Choose a new password",
        intro: "Enter and confirm your new password.",
        submit: "Reset password",
      };
  }
}
```

Update the `AuthForm` function signature to accept and use `locale`:

```ts
export function AuthForm({
  mode,
  locale,
  callbackUrl,
  token,
  initialStatus = "",
}: AuthFormProps) {
```

Update every call site that used `modeCopy(activeMode)` to `modeCopy(activeMode, locale)`, every `GENERIC_ERROR` reference to `genericError(locale)`, every `EMAIL_SUCCESS` reference to `emailSuccess(locale)`.

Bilingual the remaining static JSX strings (labels, buttons, links) using the same `locale === "zh-Hant" ? "..." : "..."` inline pattern already established by `AppShellNav`'s own `label()` helper — apply it to:

- The `auth-tabs` buttons: `"Password"` → zh-Hant `"密碼"`; `"Magic link"` → zh-Hant `"連結登入"`.
- `"Email address"` label → zh-Hant `"工作電郵"`.
- `"Password"` / `"New password"` labels → zh-Hant `"密碼"` / `"新密碼"`.
- `"Use 12 to 128 characters."` → zh-Hant `"長度需為 12 至 128 個字元。"`.
- `"Confirm new password"` → zh-Hant `"確認新密碼"`.
- `{isPending ? "Please wait..." : copy.submit}` → zh-Hant `"處理中..."` for the pending state.
- `"Forgot password?"` → zh-Hant `"忘記密碼？"`.
- `"Register with an invitation"` → zh-Hant `"已收到邀請？設定帳戶"`.
- `"Back to sign in"` → zh-Hant `"返回登入"`.
- The two inline password-policy validation messages in `handleSubmit` (`"Password must be between 12 and 128 characters."` and `"Passwords must match."`) → zh-Hant `"密碼長度須為 12 至 128 個字元。"` / `"兩次輸入的密碼不一致。"`.

- [ ] **Step 6: Move the "Status:" prefix out of CSS and into JSX**

In `apps/web/app/globals.css`, remove the `.auth-status::before` rule entirely:

```css
.auth-status::before {
  content: "Status: ";
  font-weight: 700;
}
```

In `auth-form.tsx`, change the status paragraph to render the label as real, locale-aware text plus a bold inline element for the same visual weight the CSS previously provided:

```tsx
<p className="auth-status" role="status" aria-live="polite">
  <strong>{locale === "zh-Hant" ? "狀態：" : "Status: "}</strong>
  {status || " "}
</p>
```

Add a small CSS rule for the new `<strong>` in place of the removed `::before` (same visual weight, in the same `.auth-status` block in `globals.css`):

```css
.auth-status strong {
  font-weight: 700;
}
```

- [ ] **Step 7: Finish Step 3's zh-Hant test assertion**

Confirm the exact zh-Hant heading string for `password-signin` written in Step 5 (`"歡迎回來"`) matches what Step 3's test asserts — adjust the test's asserted substring if it doesn't match exactly.

- [ ] **Step 8: Run the tests, iterate until they pass**

```
corepack pnpm --filter @wukong/web exec vitest run components/auth-form.test.tsx
```

Expected: ALL tests pass — every pre-existing assertion (now exercised with the explicit `locale: "en"` default from Step 2) plus the 2 new zh-Hant/en tests.

- [ ] **Step 9: Typecheck and format**

```
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check apps/web/components/auth-form.tsx apps/web/components/auth-form.test.tsx apps/web/app/globals.css
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/components/auth-form.tsx apps/web/components/auth-form.test.tsx apps/web/app/globals.css
git commit -m "$(cat <<'EOF'
feat: make AuthForm bilingual (zh-Hant/en), closing a real English-only gap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Build the shared two-panel `AuthShell` component

**Files:**

- Create: `apps/web/components/auth-shell.tsx`
- Create: `apps/web/components/auth-shell.test.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/auth-shell.test.tsx`, matching `apps/web/components/app-shell-nav.test.tsx`'s established DOM-testing conventions (read that file first for its exact `mount`/`act`/`happy-dom` pattern). Cover, as separate focused tests:

```tsx
// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { AuthShell } from "./auth-shell";

async function mount(initialLocale: "zh-Hant" | "en") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthShell initialLocale={initialLocale}>
        <div data-testid="card-content">card</div>
      </AuthShell>,
    );
  });
  return container;
}

describe("AuthShell", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the brand panel's stat tiles and access principles in zh-Hant", async () => {
    const container = await mount("zh-Hant");
    expect(container.textContent).toContain("71");
    expect(container.textContent).toContain("SHOPLINE 範本欄位");
    expect(container.textContent).toContain("存取原則");
  });

  it("renders the brand panel in English", async () => {
    const container = await mount("en");
    expect(container.textContent).toContain("SHOPLINE template fields");
  });

  it("renders the card content passed as children", async () => {
    const container = await mount("zh-Hant");
    expect(
      container.querySelector('[data-testid="card-content"]'),
    ).not.toBeNull();
  });

  it("toggling the locale button updates the rendered language and writes the cookie", async () => {
    const container = await mount("en");
    const zhButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="locale-toggle-zh"]',
    );
    expect(zhButton).not.toBeNull();
    await act(async () => zhButton!.click());
    expect(container.textContent).toContain("存取原則");
    expect(document.cookie).toContain("locale=zh-Hant");
  });

  it("omits any /pilot link", async () => {
    const container = await mount("zh-Hant");
    const hrefs = Array.from(container.querySelectorAll("a"), (a) =>
      a.getAttribute("href"),
    );
    expect(hrefs.some((href) => href?.includes("/pilot"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```
corepack pnpm --filter @wukong/web exec vitest run components/auth-shell.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `apps/web/components/auth-shell.tsx`**

```tsx
"use client";

import { useState, type ReactNode } from "react";

import { setLocaleCookie, type Locale } from "../lib/locale";

type AuthShellProps = {
  initialLocale: Locale;
  children: ReactNode;
};

const PRINCIPLES: { zh: string; en: string }[] = [
  {
    zh: "邀請制帳戶及工作區成員資格",
    en: "Invite-only accounts and workspace membership",
  },
  {
    zh: "角色權限必須由後端強制執行",
    en: "Role permissions are enforced server-side",
  },
  {
    zh: "所有輸出保留人工審批關卡",
    en: "Every output keeps a human approval gate",
  },
  {
    zh: "正式環境直接寫入維持停用",
    en: "Direct production writes stay disabled",
  },
];

export function AuthShell({ initialLocale, children }: AuthShellProps) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const isZh = locale === "zh-Hant";

  function changeLocale(next: Locale) {
    setLocale(next);
    setLocaleCookie(next);
  }

  return (
    <div className="auth-shell">
      <aside
        className="auth-shell-brand"
        aria-label="Wukong Catalog Operations OS"
      >
        <div className="auth-shell-brand-header">
          <div className="auth-shell-logo" aria-hidden="true">
            WK
          </div>
          <div>
            <p className="auth-shell-wordmark">Wukong</p>
            <p className="auth-shell-tagline-small">CATALOG OPERATIONS OS</p>
          </div>
          <div className="locale-toggle" role="group" aria-label="介面語言">
            <button
              type="button"
              data-testid="locale-toggle-zh"
              aria-pressed={isZh}
              onClick={() => changeLocale("zh-Hant")}
            >
              繁中
            </button>
            <button
              type="button"
              data-testid="locale-toggle-en"
              aria-pressed={!isZh}
              onClick={() => changeLocale("en")}
            >
              EN
            </button>
          </div>
        </div>
        <div className="auth-shell-brand-body">
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
          <div className="auth-shell-stats">
            <div>
              <strong>71</strong>
              <span>
                {isZh ? "SHOPLINE 範本欄位" : "SHOPLINE template fields"}
              </span>
            </div>
            <div>
              <strong>8</strong>
              <span>{isZh ? "可修改內容欄位" : "editable content fields"}</span>
            </div>
            <div>
              <strong>0</strong>
              <span>
                {isZh ? "直接 SHOPLINE 寫入" : "direct SHOPLINE writes"}
              </span>
            </div>
          </div>
          <div className="auth-shell-principles">
            <p>{isZh ? "存取原則" : "Access principles"}</p>
            <ul>
              {PRINCIPLES.map((principle) => (
                <li key={principle.en}>{isZh ? principle.zh : principle.en}</li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
      <main className="auth-shell-card-wrap">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS**

Add to `apps/web/app/globals.css`, near the existing `.signin-*`/`.auth-*` block (read the surrounding rules first to match indentation/quoting conventions exactly):

```css
.auth-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(320px, 420px) 1fr;
}
.auth-shell-brand {
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 32px;
  color: white;
  background: var(--navy);
}
.auth-shell-brand-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.auth-shell-logo {
  width: 44px;
  height: 44px;
  display: grid;
  flex-shrink: 0;
  place-items: center;
  background: rgb(255 255 255 / 12%);
  border-radius: 10px;
  font-weight: 700;
}
.auth-shell-wordmark {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.auth-shell-tagline-small {
  margin: 0;
  color: rgb(255 255 255 / 65%);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.auth-shell-brand-header .locale-toggle {
  margin-left: auto;
}
.auth-shell-brand-body {
  display: none;
}
.auth-shell-eyebrow {
  display: inline-block;
  margin: 0 0 12px;
  padding: 4px 10px;
  background: rgb(255 255 255 / 10%);
  border-radius: 999px;
  font-size: 12px;
}
.auth-shell-brand-body h1 {
  margin: 0 0 12px;
  font-size: clamp(24px, 3vw, 32px);
  line-height: 1.2;
}
.auth-shell-brand-body > p {
  color: rgb(255 255 255 / 80%);
  font-size: 14px;
}
.auth-shell-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 24px 0;
}
.auth-shell-stats > div {
  padding: 14px;
  background: rgb(255 255 255 / 6%);
  border-radius: 10px;
}
.auth-shell-stats strong {
  display: block;
  font-size: 22px;
}
.auth-shell-stats span {
  color: rgb(255 255 255 / 70%);
  font-size: 12px;
}
.auth-shell-principles > p {
  margin: 0 0 10px;
  font-weight: 700;
}
.auth-shell-principles ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
  font-size: 13px;
  color: rgb(255 255 255 / 85%);
}
.auth-shell-card-wrap {
  display: grid;
  place-items: center;
  padding: 32px 20px;
  background: linear-gradient(145deg, #f6f4ef 0%, #eee8dc 100%);
}
@media (min-width: 1024px) {
  .auth-shell-brand-body {
    display: block;
  }
}
```

The `.auth-shell-brand-body { display: none; }` default plus the `min-width: 1024px` override is what produces the confirmed Site behavior (§ baseline facts): the tagline/stats/principles content only renders on wide viewports, leaving just the logo/wordmark/locale-toggle header bar below that breakpoint.

- [ ] **Step 5: Run the tests, iterate until they pass**

```
corepack pnpm --filter @wukong/web exec vitest run components/auth-shell.test.tsx
```

- [ ] **Step 6: Typecheck and format**

```
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check apps/web/components/auth-shell.tsx apps/web/components/auth-shell.test.tsx apps/web/app/globals.css
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/auth-shell.tsx apps/web/components/auth-shell.test.tsx apps/web/app/globals.css
git commit -m "$(cat <<'EOF'
feat: add the two-panel AuthShell brand/card layout component

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Move the 5 auth pages into a new `(auth)` route group wired to `AuthShell`

**Files:**

- Create: `apps/web/app/(auth)/layout.tsx`
- Create: `apps/web/app/(auth)/signin/page.tsx` (moved from `apps/web/app/signin/page.tsx`)
- Create: `apps/web/app/(auth)/register/page.tsx` (moved from `apps/web/app/register/page.tsx`)
- Create: `apps/web/app/(auth)/register/set-password/page.tsx` (moved from `apps/web/app/register/set-password/page.tsx`)
- Create: `apps/web/app/(auth)/forgot-password/page.tsx` (moved from `apps/web/app/forgot-password/page.tsx`)
- Create: `apps/web/app/(auth)/reset-password/page.tsx` (moved from `apps/web/app/reset-password/page.tsx`)
- Delete: the 5 original files at their old (non-grouped) paths
- Modify: `apps/web/app/globals.css` (remove now-superseded `.signin-shell`/`.signin-card`/`.signin-brand` rules if nothing else references them — verify first)

This task moves files and changes markup; there is no new pure-logic unit to TDD in isolation, so this task is verified by the existing `flow-routes.test.ts`/`auth-flow.test.ts` (which exercise the API routes these pages call, unaffected by this move) plus a manual reading pass and the full build in Task 7. Still follow red-green discipline where a real assertion is possible (Step 6 below).

- [ ] **Step 1: Read the current content of all 5 page files one more time to confirm nothing changed since planning**

`apps/web/app/signin/page.tsx`, `apps/web/app/register/page.tsx`, `apps/web/app/register/set-password/page.tsx`, `apps/web/app/forgot-password/page.tsx`, `apps/web/app/reset-password/page.tsx`.

- [ ] **Step 2: Create `apps/web/app/(auth)/layout.tsx`**

```tsx
import { cookies } from "next/headers";

import { AuthShell } from "../../components/auth-shell";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../lib/locale";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return <AuthShell initialLocale={locale}>{children}</AuthShell>;
}
```

- [ ] **Step 3: Create `apps/web/app/(auth)/signin/page.tsx`**

```tsx
import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = (await searchParams) ?? {};
  const value = params.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  const initialStatus =
    params.registered === "1"
      ? isZh
        ? "你的密碼已就緒。請登入以繼續。"
        : "Your password is ready. Sign in to continue."
      : params.reset === "1"
        ? isZh
          ? "你的密碼已重設。請登入以繼續。"
          : "Your password has been reset. Sign in to continue."
        : "";
  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 登入" : "Wukong sign in"}
    >
      <p className="auth-card-eyebrow">{isZh ? "歡迎回來" : "Welcome back"}</p>
      <AuthForm
        mode="password-signin"
        locale={locale}
        callbackUrl={callbackUrl}
        initialStatus={initialStatus}
      />
    </section>
  );
}
```

- [ ] **Step 4: Create the remaining 4 pages, following the same pattern**

`apps/web/app/(auth)/register/page.tsx`:

```tsx
import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RegisterPage({ searchParams }: PageProps) {
  const value = (await searchParams)?.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 登記" : "Wukong registration"}
    >
      <p className="auth-card-eyebrow">
        {isZh ? "只限受邀帳戶" : "Invited accounts only"}
      </p>
      <AuthForm mode="register" locale={locale} callbackUrl={callbackUrl} />
    </section>
  );
}
```

`apps/web/app/(auth)/forgot-password/page.tsx`:

```tsx
import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ForgotPasswordPage({ searchParams }: PageProps) {
  const value = (await searchParams)?.callbackUrl;
  const callbackUrl = Array.isArray(value) ? value[0] : value;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 密碼復原" : "Wukong password recovery"}
    >
      <AuthForm
        mode="forgot-password"
        locale={locale}
        callbackUrl={callbackUrl}
      />
    </section>
  );
}
```

`apps/web/app/(auth)/register/set-password/page.tsx` and `apps/web/app/(auth)/reset-password/page.tsx` are built in Task 5 (they need the new invalid-token branch, not just a locale-aware copy of today's behavior) — do not create bare copies of them here; Task 5 creates them directly.

- [ ] **Step 5: Delete the 5 original, now-superseded page files**

```bash
git rm apps/web/app/signin/page.tsx
git rm apps/web/app/register/page.tsx
git rm apps/web/app/forgot-password/page.tsx
```

(`apps/web/app/register/set-password/page.tsx` and `apps/web/app/reset-password/page.tsx` are removed in Task 5, alongside their replacements being created there.)

- [ ] **Step 6: Add CSS for the new `.auth-card`/`.auth-card-eyebrow` classes, remove now-dead `.signin-shell`/`.signin-card`/`.signin-brand`**

Run `grep -rn "signin-shell\|signin-card\|signin-brand" apps/web` first to confirm these classes have no other consumer (they shouldn't, since only the 5 pages just deleted used them) — if confirmed unused, remove the `.signin-shell`, `.signin-card`, `.signin-brand`, `.signin-card h1`, `.signin-intro`, `.signin-action`, `.signin-note` rules and their `@media (max-width: 560px)` overrides from `apps/web/app/globals.css` entirely (dead CSS, don't leave it behind). Add in their place:

```css
.auth-card {
  width: 100%;
  max-width: 440px;
  padding: clamp(28px, 5vw, 44px);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow);
}
.auth-card-eyebrow {
  margin: 0 0 8px;
  color: var(--amber-dark);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
```

- [ ] **Step 7: Run the full existing auth-related test suites, confirm no regression**

```
corepack pnpm --filter @wukong/web exec vitest run auth.test.ts lib/auth-flow.test.ts "app/api/auth/flow-routes.test.ts" components/auth-form.test.tsx
```

- [ ] **Step 8: Typecheck and format**

```
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check "apps/web/app/(auth)" apps/web/app/globals.css
```

- [ ] **Step 9: Commit**

```bash
git add "apps/web/app/(auth)" apps/web/app/globals.css
git commit -m "$(cat <<'EOF'
feat: move signin/register/forgot-password onto the shared AuthShell layout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Add the invalid/expired-link state to the two token-based pages

**Files:**

- Create: `apps/web/app/(auth)/register/set-password/page.tsx`
- Create: `apps/web/app/(auth)/reset-password/page.tsx`
- Create: `apps/web/app/(auth)/register/set-password/page.test.tsx`
- Create: `apps/web/app/(auth)/reset-password/page.test.tsx`
- Delete: `apps/web/app/register/set-password/page.tsx`, `apps/web/app/reset-password/page.tsx`

- [ ] **Step 1: Read the current `apps/web/app/register/set-password/page.tsx` and `apps/web/app/reset-password/page.tsx` in full**

Confirm their exact current content (both already shown in full during design research) before building their replacements.

- [ ] **Step 2: Check whether this codebase already has a Server Component page-rendering test convention**

Run `find apps/web/app -iname "*.test.tsx" | head -5` — Server Components using `async function` can't always be unit-rendered the same way client components are. If no existing precedent renders an async Server Component directly in a Vitest test, write these two new tests against the page's exported function called directly (it's just an async function returning JSX — call it with a constructed `searchParams` promise and inspect the returned React element tree with `react-test-renderer` or by rendering the resolved element via `createRoot`, matching whatever pattern an existing async-page test in this repo already uses; if truly none exists, render the resolved JSX result directly):

```tsx
// apps/web/app/(auth)/reset-password/page.test.tsx
// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import ResetPasswordPage from "./page";

async function mount(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const element = await ResetPasswordPage({
    searchParams: Promise.resolve(searchParams),
  });
  await act(async () => {
    root.render(element);
  });
  return container;
}

describe("ResetPasswordPage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the password form when a token is present", async () => {
    const container = await mount({ token: "safe-query-token" });
    expect(container.querySelector('input[name="password"]')).not.toBeNull();
  });

  it("renders an expired-link state when Better Auth reports an invalid token", async () => {
    const container = await mount({ error: "INVALID_TOKEN" });
    expect(container.querySelector('input[name="password"]')).toBeNull();
    expect(container.textContent).toMatch(/expired|過期/i);
  });

  it("renders an expired-link state when there is no token at all", async () => {
    const container = await mount({});
    expect(container.querySelector('input[name="password"]')).toBeNull();
  });
});
```

Write the equivalent for `apps/web/app/(auth)/register/set-password/page.test.tsx`, importing `SetPasswordPage` instead and checking for invite-specific expired-link copy instead of a password-reset one.

- [ ] **Step 3: Run these tests, confirm they fail**

```
corepack pnpm --filter @wukong/web exec vitest run "app/(auth)/reset-password/page.test.tsx" "app/(auth)/register/set-password/page.test.tsx"
```

Expected: FAIL — modules don't exist yet.

- [ ] **Step 4: Create `apps/web/app/(auth)/reset-password/page.tsx`**

```tsx
import Link from "next/link";
import { cookies } from "next/headers";

import { AuthForm } from "../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const callbackUrl = Array.isArray(params.callbackUrl)
    ? params.callbackUrl[0]
    : params.callbackUrl;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  if (!token) {
    return (
      <section
        className="auth-card"
        aria-label={isZh ? "連結已失效" : "Link no longer valid"}
      >
        <p className="auth-card-eyebrow">
          {isZh ? "連結已過期" : "Link expired"}
        </p>
        <h1>
          {isZh
            ? "這個密碼重設連結已失效"
            : "This password reset link is no longer valid"}
        </h1>
        <p>
          {isZh
            ? "重設連結只在短時間內有效。請重新申請一個新的重設連結。"
            : "Reset links are only valid for a short time. Request a new one to continue."}
        </p>
        <Link className="primary-button" href="/forgot-password">
          {isZh ? "重新申請重設連結" : "Request a new reset link"}
        </Link>
      </section>
    );
  }

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 密碼重設" : "Wukong password reset"}
    >
      <AuthForm
        mode="reset-password"
        locale={locale}
        token={token}
        callbackUrl={callbackUrl}
      />
    </section>
  );
}
```

- [ ] **Step 5: Create `apps/web/app/(auth)/register/set-password/page.tsx`**

```tsx
import Link from "next/link";
import { cookies } from "next/headers";

import { AuthForm } from "../../../../components/auth-form";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SetPasswordPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const callbackUrl = Array.isArray(params.callbackUrl)
    ? params.callbackUrl[0]
    : params.callbackUrl;
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const isZh = locale === "zh-Hant";

  if (!token) {
    return (
      <section
        className="auth-card"
        aria-label={isZh ? "邀請連結已失效" : "Invitation link no longer valid"}
      >
        <p className="auth-card-eyebrow">
          {isZh ? "邀請連結已過期" : "Invitation link expired"}
        </p>
        <h1>
          {isZh
            ? "這個邀請連結已失效"
            : "This invitation link is no longer valid"}
        </h1>
        <p>
          {isZh
            ? "請聯絡你的工作區管理員，請求一個新的邀請。"
            : "Contact your workspace administrator to request a new invitation."}
        </p>
        <Link className="primary-button" href="/signin">
          {isZh ? "返回登入" : "Back to sign in"}
        </Link>
      </section>
    );
  }

  return (
    <section
      className="auth-card"
      aria-label={isZh ? "Wukong 密碼設定" : "Wukong password setup"}
    >
      <AuthForm
        mode="set-password"
        locale={locale}
        token={token}
        callbackUrl={callbackUrl}
      />
    </section>
  );
}
```

Note the deliberate copy difference from `reset-password`'s expired state: this one has no self-service "request a new link" action (invites are admin-issued, per ADR-6/G9 — there is no self-service resend), so it directs the user back to sign-in with instructions to contact their administrator instead.

- [ ] **Step 6: Delete the old, now-superseded files**

```bash
git rm apps/web/app/register/set-password/page.tsx
git rm apps/web/app/reset-password/page.tsx
```

- [ ] **Step 7: Run the tests, iterate until they pass**

```
corepack pnpm --filter @wukong/web exec vitest run "app/(auth)/reset-password/page.test.tsx" "app/(auth)/register/set-password/page.test.tsx"
```

- [ ] **Step 8: Run the full existing auth suites again to confirm no regression**

```
corepack pnpm --filter @wukong/web exec vitest run auth.test.ts lib/auth-flow.test.ts "app/api/auth/flow-routes.test.ts" components/auth-form.test.tsx
```

- [ ] **Step 9: Typecheck and format**

```
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check "apps/web/app/(auth)"
```

- [ ] **Step 10: Commit**

```bash
git add "apps/web/app/(auth)/register/set-password" "apps/web/app/(auth)/reset-password"
git commit -m "$(cat <<'EOF'
feat: show a distinct expired-link state instead of a silently-doomed form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Document the verified CSRF/cookie defaults (G10)

**Files:**

- Modify: `apps/web/auth.ts`

- [ ] **Step 1: Read `apps/web/auth.ts` in full**

Confirm the current `buildAuthOptions` function's exact shape before adding a comment.

- [ ] **Step 2: Add a comment recording the verified defaults, directly above `return {` in `buildAuthOptions`**

```ts
  // CSRF/secure-cookie defaults verified directly against the installed
  // better-auth@1.5.5 source (docs/superpowers/specs/2026-09-02-package-c-
  // public-entry-auth-layout-design.md §5), not assumed: cookies are always
  // httpOnly; sameSite defaults to "lax"; `secure` auto-resolves from
  // whether `baseURL` is https (true in prod/preview via BETTER_AUTH_URL/
  // VERCEL_URL, false for local http dev); `trustedOrigins` defaults to
  // exactly this app's own computed baseURL origin, recomputed per Vercel
  // deployment -- never wildcarded. Correct as-is for this single-origin
  // deployment; no explicit `trustedOrigins`/cookie-attribute override
  // is needed.
  return {
```

This is the only change in this task — no logic, no new config, no test to write (nothing observable changed).

- [ ] **Step 3: Run the existing `auth.test.ts` suite, confirm it's unaffected**

```
corepack pnpm --filter @wukong/web exec vitest run auth.test.ts
```

- [ ] **Step 4: Typecheck and format**

```
corepack pnpm --filter @wukong/web exec tsc --noEmit
corepack pnpm exec prettier --check apps/web/auth.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/auth.ts
git commit -m "$(cat <<'EOF'
docs: record the verified Better Auth CSRF/cookie defaults (resolves G10)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Delete stale `.next` cache, then typecheck everything**

```powershell
rm -rf apps/web/.next
corepack pnpm typecheck
```

Expected: PASS across every package.

- [ ] **Step 2: Format check**

```powershell
corepack pnpm format:runtime:check
```

Expected: PASS, or fix flagged files with `corepack pnpm exec prettier --write <files>` and re-check.

- [ ] **Step 3: Full unit suite**

```powershell
corepack pnpm test
```

Expected: PASS, all packages, including every file touched in Tasks 1-6.

- [ ] **Step 4: `pnpm runtime:forbidden:check`**

```powershell
corepack pnpm runtime:forbidden:check
```

Expected: PASS.

- [ ] **Step 5: Verify the real Turbopack production build**

This session found real Vercel deployment failures (twice) that only `next build --turbopack` catches, not `tsc --noEmit` or Vitest. Run the actual build:

```powershell
corepack pnpm --filter @wukong/web exec next build --turbopack
```

Expected: completes and prints the full route table with `/signin`, `/register`, `/register/set-password`, `/forgot-password`, `/reset-password` all present (route groups like `(auth)` never appear in the printed path), zero "Module not found" errors. If any new file uses a `.js`-suffixed relative import for a real value import, drop the extension per this codebase's established convention.

- [ ] **Step 6: Manual smoke check**

Start the dev server (`corepack pnpm --filter @wukong/web dev`) and confirm: `/signin` shows the two-panel layout with the brand panel visible at desktop width and collapsed at mobile width; the 繁中/EN toggle switches all visible copy including the brand panel; `/register`, `/forgot-password` render correctly; visiting `/reset-password` and `/register/set-password` with no `token` query param shows the expired-link state (not the form); visiting either with a real `token` from a real request-reset/invite flow shows the working form; no visible text anywhere reads "Opak Cellar"; no link points at `/pilot`.

---

## Self-Review

**Spec coverage:** §2 (two-panel layout, no pilot links, no demo-access/remember-device) → Tasks 3-4. §3 (per-page bilingual content, no hardcoded "Opak Cellar") → Tasks 2, 4, 5. §4 (invalid/expired-token state) → Task 5. §5 (CSRF/cookie documentation) → Task 6. §6 (testing) → each task's own test steps plus Task 7's full-suite pass. §7's out-of-scope items (`/pilot`, demo access, remember-device, Better-Auth config changes, other authenticated routes) are not touched by any task.

**Placeholder scan:** Task 2's Step 3 explicitly defers finalizing one test assertion until Step 5's real copy is written (an intentional "verify against what you just wrote" instruction, not an unresolved requirement); Task 5's Step 2 explicitly says to check for or establish an async-Server-Component test convention before assuming the sketch is idiomatic, since this plan's own research didn't find an existing precedent to copy verbatim.

**Type consistency:** `AuthFormProps`'s new `locale: Locale` field (Task 2) is the same type used by `AuthShellProps.initialLocale` (Task 3) and every page's own `resolveLocale(...)` call (Tasks 4-5) — one `Locale` type from `apps/web/lib/locale.ts`, never redefined. `setLocaleCookie` (Task 1) is defined once and imported identically by both `AppShellNav` (existing) and `AuthShell` (new, Task 3).

**Scope check:** seven tasks — one small shared-helper extraction, one component's bilingual-copy conversion, one new shared layout component, one file-move-and-rewire task, one small new feature (invalid-token state) touching two pages, one documentation-only task, one verification pass. Comparable in shape to this session's other M-sized packages, with the file-move task (4) being the largest single unit of mechanical change.
