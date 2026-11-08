// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpTokenView } from "../lib/studio/mcp-tokens";
import { StudioTokenPanel } from "./studio-token-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * API-token panel tests (plan Task 13 settings surface): the list never shows
 * a token value, creation reveals the plaintext exactly once, and revoke
 * updates the row. Fetches are stubbed; no network.
 */

const token: McpTokenView = {
  tokenId: "22222222-2222-4222-8222-222222222222",
  label: "Automation",
  prefix: "abcdefghijkl",
  scopes: ["read", "propose"],
  createdBy: "actor_ops",
  revokedAt: null,
  lastUsedAt: null,
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
};

function render(tokens: readonly McpTokenView[]) {
  return renderToStaticMarkup(
    <StudioTokenPanel locale="en" initialTokens={tokens} />,
  );
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(tokens: readonly McpTokenView[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StudioTokenPanel locale="en" initialTokens={tokens} />);
  });
  return container;
}

function setInput(input: HTMLInputElement, value: string) {
  // React tracks the previous DOM value; go through the prototype setter so
  // the synthetic onChange sees a real change.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm(container: HTMLElement) {
  container
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("StudioTokenPanel", () => {
  it("renders an honest empty state and the create form", () => {
    const html = render([]);
    expect(html).toContain("API tokens");
    expect(html).toContain("No tokens yet.");
    expect(html).toContain("Create token");
    expect(html).toContain("Read");
    expect(html).toContain("Propose");
    expect(html).not.toContain("wuk_");
  });

  it("renders token metadata without a plaintext value", () => {
    const html = render([token]);
    expect(html).toContain("Automation");
    expect(html).toContain("abcdefghijkl");
    expect(html).toContain("Active");
    expect(html).toContain("Revoke");
    expect(html).not.toContain("wuk_");
    expect(html).not.toContain("tokenHash");
  });

  it("creates a token, shows the plaintext once and keeps the form usable", async () => {
    const created = {
      ...token,
      tokenId: "44444444-4444-4444-8444-444444444444",
      label: "CI token",
      token: "wuk_abcdefghijkl.secretvalue",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(created, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    expect(findButton(container, "Create token")).toBeDefined();

    await act(async () => {
      setInput(
        container.querySelector('input[name="token-label"]') as HTMLInputElement,
        "CI token",
      );
    });
    await act(async () => {
      submitForm(container);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/studio/tokens");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ label: "CI token", scopes: ["read"] });
    expect(container.textContent).toContain("wuk_abcdefghijkl.secretvalue");
    expect(container.textContent).toContain(
      "Copy the token now; it cannot be shown again after you leave.",
    );
    expect(container.textContent).toContain("CI token");
  });

  it("revokes a token and marks the row", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        tokenId: token.tokenId,
        revokedAt: "2026-11-08T11:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount([token]);
    await act(async () => {
      findButton(container, "Revoke")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `/api/studio/tokens/${token.tokenId}`,
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(container.textContent).toContain("Revoked");
  });

  it("states a required label instead of sending an empty one", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();

    await act(async () => {
      submitForm(container);
      await Promise.resolve();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a token label.");
  });
});

