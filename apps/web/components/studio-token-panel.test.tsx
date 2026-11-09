// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpTokenView } from "../lib/studio/mcp-tokens";
import { StudioTokenPanel } from "./studio-token-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  rateLimitPerMinute: 60,
  monthlyCallQuota: 1000,
  usage: { minuteCalls: 2, monthCalls: 41 },
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
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(created, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    expect(findButton(container, "Create token")).toBeDefined();

    await act(async () => {
      setInput(
        container.querySelector(
          'input[name="token-label"]',
        ) as HTMLInputElement,
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

  it("shows each token's quotas and actual usage, with edit and rotate actions", () => {
    const html = render([token]);
    expect(html).toContain("60 / per minute");
    expect(html).toContain("1000 / per month");
    expect(html).toContain("2 per minute · 41 per month");
    expect(html).toContain("Edit limits");
    expect(html).toContain("Rotate");
    expect(html).not.toContain("wuk_");
  });

  it("renders unlimited quotas and usage honestly", () => {
    const html = render([
      {
        ...token,
        rateLimitPerMinute: null,
        monthlyCallQuota: null,
        usage: { minuteCalls: 0, monthCalls: 0 },
      },
    ]);
    // Two table cells plus the two create-form placeholders.
    expect(html.match(/Unlimited/g)).toHaveLength(4);
    expect(html).toContain("0 per minute · 0 per month");
  });

  it("sends the optional quotas on create and rejects out-of-range input locally", async () => {
    const created = {
      ...token,
      tokenId: "44444444-4444-4444-8444-444444444444",
      label: "Quota token",
      token: "wuk_abcdefghijkl.secretvalue",
      rateLimitPerMinute: 30,
      monthlyCallQuota: 500,
      usage: { minuteCalls: 0, monthCalls: 0 },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(created, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();

    await act(async () => {
      setInput(
        container.querySelector(
          'input[name="token-label"]',
        ) as HTMLInputElement,
        "Quota token",
      );
      setInput(
        container.querySelector(
          'input[name="token-rate-limit"]',
        ) as HTMLInputElement,
        "30",
      );
      setInput(
        container.querySelector(
          'input[name="token-monthly-quota"]',
        ) as HTMLInputElement,
        "500",
      );
    });
    await act(async () => {
      submitForm(container);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      label: "Quota token",
      scopes: ["read"],
      rateLimitPerMinute: 30,
      monthlyCallQuota: 500,
    });

    const invalid = await mount();
    await act(async () => {
      setInput(
        invalid.querySelector('input[name="token-label"]') as HTMLInputElement,
        "Too many",
      );
      setInput(
        invalid.querySelector(
          'input[name="token-rate-limit"]',
        ) as HTMLInputElement,
        "601",
      );
      submitForm(invalid);
      await Promise.resolve();
    });
    expect(invalid.textContent).toContain(
      "A quota must be an integer within range, or blank for unlimited.",
    );
  });

  it("edits both limits and shows the server readback", async () => {
    const updated: McpTokenView = {
      ...token,
      rateLimitPerMinute: 120,
      monthlyCallQuota: null,
      usage: { minuteCalls: 3, monthCalls: 42 },
      updatedAt: "2026-11-08T12:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(updated));
    vi.stubGlobal("fetch", fetcher);
    const container = await mount([token]);

    await act(async () => {
      findButton(container, "Edit limits")!.click();
    });
    await act(async () => {
      setInput(
        container.querySelector(
          'input[name="edit-rate-limit"]',
        ) as HTMLInputElement,
        "120",
      );
      setInput(
        container.querySelector(
          'input[name="edit-monthly-quota"]',
        ) as HTMLInputElement,
        "",
      );
    });
    const editForm = container.querySelectorAll("form")[1]!;
    await act(async () => {
      editForm.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `/api/studio/tokens/${token.tokenId}`,
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      rateLimitPerMinute: 120,
      monthlyCallQuota: null,
    });
    expect(container.textContent).toContain(
      "Limits updated from the server readback.",
    );
    expect(container.textContent).toContain("120 / per minute");
    expect(container.textContent).toContain("3 per minute · 42 per month");
  });

  it("reports quota update failures honestly and does not claim the new limits", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}, { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    const container = await mount([token]);

    await act(async () => findButton(container, "Edit limits")!.click());
    await act(async () => {
      setInput(
        container.querySelector(
          'input[name="edit-rate-limit"]',
        ) as HTMLInputElement,
        "5",
      );
      setInput(
        container.querySelector(
          'input[name="edit-monthly-quota"]',
        ) as HTMLInputElement,
        "5",
      );
      container
        .querySelectorAll("form")[1]!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "The limits could not be updated. Try again.",
    );
    expect(container.textContent).not.toContain(
      "Limits updated from the server readback.",
    );
  });

  it("rotates after confirmation, reveals the new plaintext once and replaces the row", async () => {
    const replacement: McpTokenView & { token: string } = {
      ...token,
      tokenId: "55555555-5555-4555-8555-555555555555",
      prefix: "newprefix0001",
      rateLimitPerMinute: 60,
      monthlyCallQuota: 1000,
      usage: { minuteCalls: 0, monthCalls: 0 },
      token: "wuk_newprefix0001.newsecretvalue",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(replacement, { status: 201 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const container = await mount([token]);

    await act(async () => findButton(container, "Rotate")!.click());
    expect(container.textContent).toContain(
      "Rotation revokes the old token immediately and shows the new one once. Continue?",
    );
    // The old token is still shown as active until the response arrives.
    await act(async () => {
      findButton(container, "Confirm rotate")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `/api/studio/tokens/${token.tokenId}/rotate`,
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(container.textContent).toContain("wuk_newprefix0001.newsecretvalue");
    expect(container.textContent).toContain(
      "Copy the token now; it cannot be shown again after you leave.",
    );
    expect(container.textContent).toContain("newprefix0001");
    // The old prefix is replaced, not duplicated.
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).not.toContain("abcdefghijkl");
  });

  it("reports rotation failure honestly and keeps the old token usable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}, { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    const container = await mount([token]);

    await act(async () => findButton(container, "Rotate")!.click());
    await act(async () => {
      findButton(container, "Confirm rotate")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "The token could not be rotated. Try again.",
    );
    expect(container.textContent).toContain("abcdefghijkl");
    expect(container.textContent).toContain("Active");
  });
});
