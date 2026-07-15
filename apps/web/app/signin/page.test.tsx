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
    expect(markup).toContain('href="/register"');
    expect(markup).toContain('href="/forgot-password"');
    expect(markup).not.toContain("/api/auth/signin");
  });
});
