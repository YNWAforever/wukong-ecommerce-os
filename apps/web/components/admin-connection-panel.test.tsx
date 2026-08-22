// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminConnectionPanel } from "./admin-connection-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

async function settleEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(AdminConnectionPanel));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settleEffects();
  return { container, root };
}

function stubFetch(body: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("AdminConnectionPanel", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders a stable connection-panel root before data loads", () => {
    // Note: renderToStaticMarkup can't await the client-side useEffect fetch
    // since it renders synchronously and never runs effects -- see
    // admin-members-panel.test.tsx for the same convention.
    globalThis.fetch = vi.fn<typeof fetch>() as unknown as typeof fetch;
    const markup = renderToStaticMarkup(createElement(AdminConnectionPanel));
    expect(markup).toContain("connection-panel");
  });

  it("renders the create form when no connection exists yet", async () => {
    const fetcher = stubFetch({ connection: null });

    const { container } = await mountPanel();

    expect(fetcher).toHaveBeenCalledWith("/api/workspace/connection");
    expect(container.querySelector("form.connection-form")).not.toBeNull();
    expect(
      container.querySelector(
        'input[aria-label="SHOPLINE 商店網域 SHOPLINE shop domain"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        'input[aria-label="SHOPLINE 存取權杖 SHOPLINE access token"]',
      ),
    ).not.toBeNull();
  });

  it("renders the read-only shop domain and rotate affordance for an existing connection, never the token", async () => {
    const mockConnection = {
      shopDomain: "opak.myshopline.com",
      connectedAt: "2026-01-01T00:00:00.000Z",
    };
    // Defense-in-depth: assert the mock connection object fetched-and-injected
    // has no token field of its own.
    expect(mockConnection).not.toHaveProperty("accessToken");
    expect(mockConnection).not.toHaveProperty("token");

    stubFetch({ connection: mockConnection });

    const { container } = await mountPanel();

    expect(container.textContent).toContain("opak.myshopline.com");
    expect(container.querySelector("form.connection-form")).toBeNull();
    expect(container.textContent).toMatch(/更新權杖 Rotate token/);

    // Defense-in-depth: the rendered markup must never contain anything
    // resembling a token value.
    expect(container.innerHTML).not.toMatch(/accessToken/i);
    expect(container.innerHTML).not.toContain("v1.");
  });

  it("shows an error banner when the initial load fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: "workspace not found" }), {
          status: 404,
        }),
      ),
    );

    const { container } = await mountPanel();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "workspace not found",
    );
  });

  it("never renders a token even when the API unexpectedly sends one (leak canary)", async () => {
    // Unlike the "never renders a token" test above (whose mocked GET
    // response has no token field at all, so it can't distinguish "the
    // component correctly omits the token" from "there was never a token to
    // omit"), this stubs an EXTRA field the real API never actually sends
    // (see app/api/workspace/connection/route.ts's GET handler, which only
    // ever returns shopDomain/connectedAt) and proves the component doesn't
    // blindly render whatever the API happens to include.
    stubFetch({
      connection: {
        shopDomain: "opak.myshopline.com",
        connectedAt: "2026-01-01T00:00:00.000Z",
        accessToken: "v1.LEAK-CANARY-9f8a7b6c",
      },
    });

    const { container } = await mountPanel();

    expect(container.textContent).toContain("opak.myshopline.com");
    expect(container.innerHTML).not.toContain("LEAK-CANARY-9f8a7b6c");
  });

  it("submits the create form via POST /api/workspace/connection and clears the token afterward", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ connection: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const { container } = await mountPanel();

    const domainInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="SHOPLINE 商店網域 SHOPLINE shop domain"]',
    );
    const tokenInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="SHOPLINE 存取權杖 SHOPLINE access token"]',
    );
    const form = container.querySelector("form.connection-form");
    expect(domainInput).not.toBeNull();
    expect(tokenInput).not.toBeNull();
    expect(form).not.toBeNull();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      nativeInputValueSetter?.call(domainInput, "opak.myshopline.com");
      domainInput?.dispatchEvent(new Event("input", { bubbles: true }));
      nativeInputValueSetter?.call(tokenInput, "v1.NEW-TOKEN-abc123");
      tokenInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // After the POST resolves, the connect() flow re-runs load(), which
    // needs a fresh (non-null) response so the component settles cleanly.
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          connection: {
            shopDomain: "opak.myshopline.com",
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const postCall = fetcher.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).not.toBeUndefined();
    expect(postCall?.[0]).toBe("/api/workspace/connection");
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      shopDomain: "opak.myshopline.com",
      accessToken: "v1.NEW-TOKEN-abc123",
    });

    expect(tokenInput?.value).toBe("");
  });

  it("submits the rotate form via PATCH /api/workspace/connection and clears the token afterward", async () => {
    const existingConnection = {
      shopDomain: "opak.myshopline.com",
      connectedAt: "2026-01-01T00:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ connection: existingConnection }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const { container } = await mountPanel();

    const rotateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("更新權杖 Rotate token"),
    );
    expect(rotateButton).not.toBeUndefined();

    await act(async () => {
      rotateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const tokenInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="新的存取權杖 New access token"]',
    );
    const form = Array.from(container.querySelectorAll("form")).find((f) =>
      f.querySelector('input[aria-label="新的存取權杖 New access token"]'),
    );
    expect(tokenInput).not.toBeNull();
    expect(form).not.toBeUndefined();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      nativeInputValueSetter?.call(tokenInput, "v1.ROTATED-token-xyz");
      tokenInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const patchCall = fetcher.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).not.toBeUndefined();
    expect(patchCall?.[0]).toBe("/api/workspace/connection");
    expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual({
      accessToken: "v1.ROTATED-token-xyz",
    });

    expect(
      container.querySelector(
        'input[aria-label="新的存取權杖 New access token"]',
      ),
    ).toBeNull();
  });

  it("surfaces the error banner when a connect submission fails", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ connection: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "shop domain already taken" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const { container } = await mountPanel();

    const domainInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="SHOPLINE 商店網域 SHOPLINE shop domain"]',
    );
    const tokenInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="SHOPLINE 存取權杖 SHOPLINE access token"]',
    );
    const form = container.querySelector("form.connection-form");

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      nativeInputValueSetter?.call(domainInput, "opak.myshopline.com");
      domainInput?.dispatchEvent(new Event("input", { bubbles: true }));
      nativeInputValueSetter?.call(tokenInput, "v1.NEW-TOKEN-abc123");
      tokenInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "shop domain already taken",
    );
  });
});
