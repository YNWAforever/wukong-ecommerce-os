// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
vi.mock("./workspace-policy-panel", () => ({
  WorkspacePolicyPanel: () => null,
}));
import { AdminSettingsPanel } from "./admin-settings-panel";

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
    root.render(createElement(AdminSettingsPanel));
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

describe("AdminSettingsPanel", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders a stable settings-panel root before data loads", () => {
    globalThis.fetch = vi.fn<typeof fetch>() as unknown as typeof fetch;
    const markup = renderToStaticMarkup(createElement(AdminSettingsPanel));
    expect(markup).toContain("settings-panel");
  });

  it("pre-fills the color input with the fetched brandBackgroundColor", async () => {
    const fetcher = stubFetch({
      brandBackgroundColor: "#112233",
      digest: "a".repeat(64),
    });

    const { container } = await mountPanel();

    expect(fetcher).toHaveBeenCalledWith("/api/workspace/settings");
    const input = container.querySelector<HTMLInputElement>(
      'input[type="color"]',
    );
    expect(input).not.toBeNull();
    expect(input?.value).toBe("#112233");
  });

  it("submits the new color via POST /api/workspace/settings", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          brandBackgroundColor: "#112233",
          digest: "a".repeat(64),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    const { container } = await mountPanel();

    const input = container.querySelector<HTMLInputElement>(
      'input[type="color"]',
    );
    expect(input).not.toBeNull();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeInputValueSetter?.call(input, "#abcdef");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeUndefined();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const postCall = fetcher.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).not.toBeUndefined();
    expect(postCall?.[0]).toBe("/api/workspace/settings");
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      brandBackgroundColor: "#abcdef",
      expectedDigest: "a".repeat(64),
    });
  });

  it("preserves conflicting color until an explicit compare or discard reload", async () => {
    let latest = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === "POST") {
          latest = true;
          return Response.json(
            { message: "Settings changed" },
            { status: 409 },
          );
        }
        return Response.json({
          brandBackgroundColor: latest ? "#445566" : "#112233",
          digest: (latest ? "b" : "a").repeat(64),
        });
      }),
    );
    const { container } = await mountPanel();
    const input = container.querySelector<HTMLInputElement>(
      'input[type="color"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "#abcdef");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(text),
      )!;
    await act(async () => button("Save").click());
    expect(input.value).toBe("#abcdef");
    await act(async () => button("Compare latest settings").click());
    expect(input.value).toBe("#abcdef");
    expect(container.textContent).toContain("#445566");
    await act(async () => button("Reload and discard my edits").click());
    expect(input.value).toBe("#445566");
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
