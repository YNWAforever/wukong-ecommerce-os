// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { AuthShell } from "./auth-shell";

async function mount(
  initialLocale: "zh-Hant" | "en",
  children: React.ReactNode = <div data-testid="card-content">card</div>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthShell initialLocale={initialLocale}>{children}</AuthShell>,
    );
  });
  return container;
}

describe("AuthShell", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.cookie = "locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
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

  it("renders a skip link pointing at the main content region", async () => {
    const container = await mount("en");
    const skipLink = container.querySelector<HTMLAnchorElement>(
      'a[href="#main-content"]',
    );
    expect(skipLink).not.toBeNull();
    expect(skipLink?.textContent).toContain("Skip to content");
    const mainContent = document.getElementById("main-content");
    expect(mainContent).not.toBeNull();
  });

  it("demotes the tagline from h1 to p so the page has only one h1", async () => {
    const container = await mount("en");
    const h1Elements = container.querySelectorAll<HTMLHeadingElement>("h1");
    expect(h1Elements.length).toBe(0);
    const taglineElement = container.querySelector<HTMLParagraphElement>(
      "p.auth-shell-tagline",
    );
    expect(taglineElement).not.toBeNull();
    expect(taglineElement?.textContent).toContain(
      "Verify the evidence before approving the content.",
    );
  });

  it("renders exactly one h1 when the child (e.g. AuthForm) has its own h1, and it is the child's, not the tagline's", async () => {
    const container = await mount("en", <h1 id="auth-title">Sign in</h1>);
    const h1Elements = container.querySelectorAll<HTMLHeadingElement>("h1");
    expect(h1Elements.length).toBe(1);
    expect(h1Elements[0]?.id).toBe("auth-title");
    expect(h1Elements[0]?.textContent).toBe("Sign in");
    const taglineElement = container.querySelector<HTMLParagraphElement>(
      "p.auth-shell-tagline",
    );
    expect(taglineElement).not.toBeNull();
    expect(taglineElement?.tagName).toBe("P");
  });
});
