import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => ({ value: "en" }) }),
}));

const pagePath = fileURLToPath(new URL("./page.tsx", import.meta.url));

describe("ResetPasswordPage", () => {
  it("renders the password form when a token is present", async () => {
    expect(existsSync(pagePath)).toBe(true);
    if (!existsSync(pagePath)) return;

    const { default: ResetPasswordPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await ResetPasswordPage({
        searchParams: Promise.resolve({ token: "safe-query-token" }),
      }),
    );

    expect(markup).toContain('name="password"');
    expect(markup).toContain("Choose a new password");
  });

  it("renders an expired-link state when Better Auth reports an invalid token", async () => {
    const { default: ResetPasswordPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await ResetPasswordPage({
        searchParams: Promise.resolve({ error: "INVALID_TOKEN" }),
      }),
    );

    expect(markup).not.toContain('name="password"');
    expect(markup).toMatch(/expired|過期/i);
  });

  it("renders an expired-link state when there is no token at all", async () => {
    const { default: ResetPasswordPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({}) }),
    );

    expect(markup).not.toContain('name="password"');
  });

  it("offers a self-service link back to forgot-password on the expired state", async () => {
    const { default: ResetPasswordPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({}) }),
    );

    expect(markup).toContain('href="/forgot-password"');
  });
});
