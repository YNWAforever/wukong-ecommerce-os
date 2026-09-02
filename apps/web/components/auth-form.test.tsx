// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
import { AuthForm, safeCallbackPath, type AuthFormMode } from "./auth-form";
import { type Locale } from "../lib/locale";

async function mount(
  mode: AuthFormMode,
  props: {
    callbackUrl?: string;
    token?: string;
    initialStatus?: string;
    locale?: Locale;
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

function fill(container: HTMLElement, name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    '[name="' + name + '"]',
  );
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("AuthForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        ),
    );
    push.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "password-signin",
      "/api/auth/password",
      {
        email: "admin@example.com",
        password: "correct horse battery",
        callbackURL: "/listings",
      },
    ],
    [
      "magic-link",
      "/api/auth/magic-link",
      { email: "admin@example.com", callbackURL: "/listings" },
    ],
    [
      "register",
      "/api/auth/register",
      {
        email: "admin@example.com",
        callbackURL: "/listings",
      },
    ],
    [
      "forgot-password",
      "/api/auth/forgot-password",
      { email: "admin@example.com", callbackURL: "/listings" },
    ],
    [
      "set-password",
      "/api/auth/reset-password",
      { newPassword: "correct horse battery", token: "safe-query-token" },
    ],
    [
      "reset-password",
      "/api/auth/reset-password",
      { newPassword: "correct horse battery", token: "safe-query-token" },
    ],
  ] as const)(
    "posts %s to its approved endpoint with credentials",
    async (mode, endpoint, body) => {
      const container = await mount(mode, {
        callbackUrl: "/listings",
        token: "safe-query-token",
      });
      if ("email" in body) fill(container, "email", body.email);
      if ("password" in body) fill(container, "password", body.password);
      if ("newPassword" in body) {
        fill(container, "password", body.newPassword);
        fill(container, "confirmPassword", body.newPassword);
      }
      await submit(container);
      expect(fetch).toHaveBeenCalledWith(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
    },
  );

  it.each([
    [
      "/listings?filter=draft&sort=recent",
      "/listings?filter=draft&sort=recent",
    ],
    ["/\t/evil.example", "/dashboard"],
    ["/\r/evil.example", "/dashboard"],
    ["/\n/evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["//evil.example", "/dashboard"],
    ["/%09/evil.example", "/dashboard"],
    ["/%0d%0a/evil.example", "/dashboard"],
    ["/%5c%5cevil.example", "/dashboard"],
    ["/%2f%2fevil.example", "/dashboard"],
    ["/%2509/evil.example", "/dashboard"],
    ["/%252f%252fevil.example", "/dashboard"],
    ["/%E0%A4%A", "/dashboard"],
    ["/\u00a0/evil.example", "/dashboard"],
    ["/%C2%A0/evil.example", "/dashboard"],
    ["/\u0085/evil.example", "/dashboard"],
    ["/%C2%85/evil.example", "/dashboard"],
    ["/\u200b/evil.example", "/dashboard"],
    ["/%E2%80%8B/evil.example", "/dashboard"],
    ["https://evil.example/steal", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
  ])("sanitizes callback %j to %s", (candidate, expected) => {
    expect(safeCallbackPath(candidate)).toBe(expected);
  });

  it.each([
    ["password-signin", "/listings", "/listings"],
    ["password-signin", "//evil.example", "/dashboard"],
    [
      "set-password",
      "/listings?filter=draft",
      "/signin?registered=1&callbackUrl=%2Flistings%3Ffilter%3Ddraft",
    ],
    [
      "reset-password",
      "/listings?filter=draft",
      "/signin?reset=1&callbackUrl=%2Flistings%3Ffilter%3Ddraft",
    ],
  ] as const)(
    "navigates after successful %s completion",
    async (mode, callbackUrl, destination) => {
      const container = await mount(mode, {
        callbackUrl,
        token: "safe-query-token",
      });
      if (mode === "password-signin") {
        fill(container, "email", "admin@example.com");
        fill(container, "password", "correct horse battery");
      } else {
        fill(container, "password", "correct horse battery");
        fill(container, "confirmPassword", "correct horse battery");
      }
      await submit(container);
      expect(push).toHaveBeenCalledWith(destination);
    },
  );

  it("does not navigate for successful email initiation flows", async () => {
    const container = await mount("register");
    fill(container, "email", "admin@example.com");
    await submit(container);
    expect(push).not.toHaveBeenCalled();
  });
  it("preserves the sanitized callback in sign-in account links and tabs", async () => {
    const container = await mount("password-signin", {
      callbackUrl: "/listings?filter=draft",
    });
    const hrefs = Array.from(container.querySelectorAll("a"), (link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toContain(
      "/forgot-password?callbackUrl=%2Flistings%3Ffilter%3Ddraft",
    );
    expect(hrefs).toContain(
      "/register?callbackUrl=%2Flistings%3Ffilter%3Ddraft",
    );

    const magicLinkTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Magic link",
    );
    await act(async () => magicLinkTab?.click());
    fill(container, "email", "admin@example.com");
    await submit(container);
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/magic-link",
      expect.objectContaining({
        body: JSON.stringify({
          email: "admin@example.com",
          callbackURL: "/listings?filter=draft",
        }),
      }),
    );
    expect(
      container.querySelector(
        'a[href="/register?callbackUrl=%2Flistings%3Ffilter%3Ddraft"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        'a[href="/forgot-password?callbackUrl=%2Flistings%3Ffilter%3Ddraft"]',
      ),
    ).not.toBeNull();
  });

  it("renders an accessible generic initial completion status", async () => {
    const container = await mount("password-signin", {
      initialStatus: "Your password is ready. Sign in to continue.",
    });
    const status = container.querySelector('[aria-live="polite"]');
    expect(status?.textContent).toBe(
      "Status: Your password is ready. Sign in to continue.",
    );
  });

  it.each([
    ["short", "short", "Password must be between 12 and 128 characters."],
    [
      "correct horse battery",
      "different password value",
      "Passwords must match.",
    ],
  ])(
    "validates password policy before requesting completion",
    async (password, confirmation, message) => {
      const container = await mount("reset-password", {
        token: "safe-query-token",
      });
      fill(container, "password", password);
      fill(container, "confirmPassword", confirmation);
      await submit(container);
      expect(fetch).not.toHaveBeenCalled();
      expect(container.textContent).toContain(message);
    },
  );

  it("shows only generic backend failure messaging", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Account exists; raw token abc and credential hash xyz",
        }),
        { status: 401 },
      ),
    );
    const container = await mount("register");
    fill(container, "email", "admin@example.com");
    await submit(container);
    expect(container.textContent).toContain("Unable to complete this request.");
    expect(container.textContent).not.toMatch(
      /account exists|raw token|credential|hash/i,
    );
  });

  it("disables submit while a request is pending", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const container = await mount("register");
    fill(container, "email", "admin@example.com");
    const submission = submit(container);
    await Promise.resolve();
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(true);
    finish(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await submission;
    expect(
      container.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(false);
  });

  it("renders zh-Hant copy when locale is zh-Hant", async () => {
    const container = await mount("password-signin", { locale: "zh-Hant" });
    expect(container.textContent).toContain("歡迎回來");
    expect(container.textContent).not.toContain("Welcome back");
  });

  it("renders English copy when locale is en", async () => {
    const container = await mount("password-signin", { locale: "en" });
    expect(container.textContent).toContain("Welcome back");
  });

  it.each([
    ["password-signin", "歡迎回來"],
    ["magic-link", "電郵登入"],
    ["register", "完成受邀登記"],
    ["set-password", "設定你的密碼"],
    ["forgot-password", "重設你的密碼"],
    ["reset-password", "選擇新密碼"],
  ] as const)("renders the zh-Hant heading for %s", async (mode, heading) => {
    const container = await mount(mode, {
      locale: "zh-Hant",
      token: "safe-query-token",
    });
    expect(container.textContent).toContain(heading);
  });
});
