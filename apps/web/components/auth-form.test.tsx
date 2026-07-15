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

async function mount(
  mode: AuthFormMode,
  props: { callbackUrl?: string; token?: string } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AuthForm mode={mode} {...props} />);
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
    ["register", "/api/auth/register", { email: "admin@example.com" }],
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

  it("allows only safe relative callback paths", () => {
    expect(safeCallbackPath("/listings?filter=draft")).toBe(
      "/listings?filter=draft",
    );
    expect(safeCallbackPath("https://evil.example/steal")).toBe("/dashboard");
    expect(safeCallbackPath("//evil.example/steal")).toBe("/dashboard");
    expect(safeCallbackPath("javascript:alert(1)")).toBe("/dashboard");
  });

  it.each([
    ["password-signin", "/listings", "/listings"],
    ["password-signin", "//evil.example", "/dashboard"],
    ["set-password", undefined, "/signin?registered=1"],
    ["reset-password", undefined, "/signin?reset=1"],
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
});
