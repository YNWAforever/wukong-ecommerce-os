import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const pagePath = fileURLToPath(new URL("./page.tsx", import.meta.url));

describe("SignInPage", () => {
  it("provides an invite-only email entry route with a safe callback", async () => {
    expect(existsSync(pagePath)).toBe(true);
    if (!existsSync(pagePath)) return;

    const { default: SignInPage } = await import("./page.js");
    const markup = renderToStaticMarkup(
      await SignInPage({
        searchParams: Promise.resolve({ callbackUrl: "/dashboard" }),
      }),
    );

    expect(markup).toContain("Opak Cellar");
    expect(markup).toContain("邀請");
    expect(markup).toContain(
      'href="/api/auth/signin?callbackUrl=%2Fdashboard"',
    );
  });
});
