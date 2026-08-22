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
});
