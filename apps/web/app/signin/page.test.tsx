import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const pagePath = fileURLToPath(new URL("./page.tsx", import.meta.url));

describe("SignInPage", () => {
  it("renders password, magic-link, registration, and recovery access", async () => {
    expect(existsSync(pagePath)).toBe(true);
    if (!existsSync(pagePath)) return;

    const { default: SignInPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await SignInPage({
        searchParams: Promise.resolve({ callbackUrl: "/dashboard" }),
      }),
    );

    expect(markup).toContain("Opak Cellar");
    expect(markup).toContain("invitation");
    expect(markup).toContain('type="email"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Sign in with password");
    expect(markup).toContain("Magic link");
    expect(markup).toContain('href="/register?callbackUrl=%2Fdashboard"');
    expect(markup).toContain(
      'href="/forgot-password?callbackUrl=%2Fdashboard"',
    );
    expect(markup).not.toContain("/api/auth/signin");
  });

  it.each([
    ["registered", "Your password is ready. Sign in to continue."],
    ["reset", "Your password has been reset. Sign in to continue."],
  ])("shows only recognized %s completion status", async (flag, message) => {
    const { default: SignInPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await SignInPage({
        searchParams: Promise.resolve({
          [flag]: "1",
          callbackUrl: "/listings?filter=draft",
          detail: "raw token and credential hash",
        }),
      }),
    );
    expect(markup).toContain(message);
    expect(markup).toContain(
      'name="callbackURL" value="/listings?filter=draft"',
    );
    expect(markup).not.toMatch(/raw token|credential hash/i);
  });

  it("does not echo arbitrary completion query content", async () => {
    const { default: SignInPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await SignInPage({
        searchParams: Promise.resolve({ registered: "please show raw token" }),
      }),
    );
    expect(markup).not.toContain("please show raw token");
    expect(markup).not.toContain("Your password is ready.");
  });
});
