// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
import { AdminTabs } from "./admin-tabs";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
function fixtureFetch(post?: () => Promise<Response>) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST")
      return post ? post() : Response.json({ ok: true });
    return Response.json({ members: [], invites: [], items: [] });
  });
}
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(AdminTabs)));
  return container;
}
async function click(element: Element | null) {
  await act(async () => (element as HTMLElement)?.click());
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function choice(container: HTMLElement, text: string) {
  return Array.from(
    container.querySelectorAll('[role="alertdialog"] button'),
  ).find((b) => b.textContent?.includes(text))!;
}
describe("AdminTabs", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("labels the active panel and exposes exactly one keyboard tab stop", () => {
    const markup = renderToStaticMarkup(createElement(AdminTabs));
    const buttons =
      markup.match(/<button[^>]*role="tab"[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(4);
    expect(buttons.filter((b) => b.includes('tabindex="0"'))).toHaveLength(1);
    expect(markup).toContain('aria-labelledby="admin-tab-members"');
  });
  it("keeps edits on stay, warns before unload, and discards only on explicit choice", async () => {
    vi.stubGlobal("fetch", fixtureFetch());
    const c = await mount();
    await type(
      c.querySelector('input[type="email"]')!,
      "draft@example.invalid",
    );
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await click(c.querySelector("#admin-tab-connection"));
    expect(c.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click(choice(c, "Stay"));
    expect(
      (c.querySelector('input[type="email"]') as HTMLInputElement).value,
    ).toBe("draft@example.invalid");
    await click(c.querySelector("#admin-tab-connection"));
    await click(choice(c, "Discard"));
    expect(
      c.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe("admin-tab-connection");
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });
  it("awaits successful save before leaving and prevents duplicate submission", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = fixtureFetch(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const c = await mount();
    await type(c.querySelector('input[type="email"]')!, "new@example.invalid");
    await click(c.querySelector("#admin-tab-connection"));
    await click(choice(c, "Save"));
    expect(
      c.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe("admin-tab-members");
    expect((choice(c, "Save") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(Response.json({ ok: true })));
    expect(
      c.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe("admin-tab-connection");
    expect(
      fetcher.mock.calls.filter(([, i]) => i?.method === "POST"),
    ).toHaveLength(1);
  });
  it("keeps invalid or rejected invitations in the current tab", async () => {
    vi.stubGlobal(
      "fetch",
      fixtureFetch(async () =>
        Response.json({ message: "Invite already exists" }, { status: 409 }),
      ),
    );
    const c = await mount();
    await type(c.querySelector('input[type="email"]')!, "bad-email");
    await click(c.querySelector("#admin-tab-settings"));
    await click(choice(c, "Save"));
    expect(
      (c.querySelector('input[type="email"]') as HTMLInputElement).value,
    ).toBe("bad-email");
    expect(
      c.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe("admin-tab-members");
    await click(choice(c, "Stay"));
    await type(c.querySelector('input[type="email"]')!, "new@example.invalid");
    await click(c.querySelector("#admin-tab-settings"));
    await click(choice(c, "Save"));
    expect(c.querySelector('[role="alert"]')?.textContent).toContain(
      "Invite already exists",
    );
    expect(
      (c.querySelector('input[type="email"]') as HTMLInputElement).value,
    ).toBe("new@example.invalid");
  });
  it("guards native popstate through pending and failed save, and restores Stay URL", async () => {
    const replace = window.history.replaceState.bind(window.history);
    const originalUrl = window.location.href;
    replace({ __NA: true }, "", new URL("/admin", originalUrl).href);
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      fixtureFetch(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    const c = await mount();
    const ownState = window.history.state;
    const go = vi.spyOn(window.history, "go").mockImplementation((delta) => {
      const back = delta === -1;
      replace(
        back ? { __NA: true } : ownState,
        "",
        new URL(back ? "/jobs" : "/admin", originalUrl).href,
      );
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: window.history.state }),
      );
    });
    await type(
      c.querySelector('input[type="email"]')!,
      "draft@example.invalid",
    );
    await act(async () => window.history.go(-1));
    expect(window.location.pathname).toBe("/admin");
    expect(c.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click(choice(c, "Stay"));
    expect(window.location.pathname).toBe("/admin");
    expect(
      (c.querySelector('input[type="email"]') as HTMLInputElement).value,
    ).toBe("draft@example.invalid");
    await act(async () => window.history.go(-1));
    await click(choice(c, "Save"));
    expect(window.location.pathname).toBe("/admin");
    await act(async () =>
      resolve(
        Response.json({ message: "Synthetic conflict" }, { status: 409 }),
      ),
    );
    expect(window.location.pathname).toBe("/admin");
    expect(
      (c.querySelector('input[type="email"]') as HTMLInputElement).value,
    ).toBe("draft@example.invalid");
    await click(choice(c, "Save"));
    expect(window.location.pathname).toBe("/admin");
    await act(async () => resolve(Response.json({ ok: true })));
    expect(window.location.pathname).toBe("/jobs");
    expect(c.querySelector('[role="alertdialog"]')).toBeNull();
    expect(go.mock.calls.filter(([delta]) => delta === -1)).toHaveLength(2);
    expect(go.mock.calls.filter(([delta]) => delta === 1)).toHaveLength(0);
    go.mockRestore();
    replace({}, "", originalUrl);
  });
  it("saves two edited settings forms with the fence from the first successful save", async () => {
    const policy = {
      name: "Synthetic",
      tone: "Plain",
      claimPolicy: [],
      requiredFields: [],
      sourcePreferences: { allowedDomains: [] },
    };
    let currentDigest = "a".repeat(64);
    let color = "#112233";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        if (init?.method === "POST" || init?.method === "PATCH") {
          const body = JSON.parse(init.body as string);
          if (body.expectedDigest !== currentDigest)
            return Response.json(
              { message: "Settings changed" },
              { status: 409 },
            );
          currentDigest =
            currentDigest === "a".repeat(64) ? "b".repeat(64) : "c".repeat(64);
          if (body.policy) Object.assign(policy, body.policy);
          else color = body.brandBackgroundColor;
        }
        if (String(url).includes("/policies"))
          return Response.json({
            policy,
            digest: currentDigest,
            usage: null,
            admission: {
              enabled: false,
              provider: null,
              model: null,
              capUsd: null,
            },
          });
        if (String(url).includes("/settings"))
          return Response.json({
            brandBackgroundColor: color,
            digest: currentDigest,
          });
        return Response.json({ members: [], invites: [] });
      }),
    );
    const c = await mount();
    await click(c.querySelector("#admin-tab-settings"));
    await type(c.querySelector('input[type="color"]')!, "#abcdef");
    const voice = c.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(voice, "Updated tone");
      voice.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(c.querySelector("#admin-tab-connection"));
    await click(choice(c, "Save"));
    expect(
      c.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"),
    ).toBe("admin-tab-connection");
    expect(color).toBe("#abcdef");
    expect(policy.tone).toBe("Updated tone");
    expect(currentDigest).toBe("c".repeat(64));
  });
  it("supports roving arrows, Home and End without discarding a form", async () => {
    vi.stubGlobal("fetch", fixtureFetch());
    const c = await mount();
    const first = c.querySelector<HTMLButtonElement>("#admin-tab-members")!;
    first.focus();
    await act(async () =>
      first.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(document.activeElement?.id).toBe("admin-tab-capabilities");
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(document.activeElement?.id).toBe("admin-tab-members");
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    expect(document.activeElement?.id).toBe("admin-tab-members");
  });
  it("guards internal route links while an invitation is dirty", async () => {
    vi.stubGlobal("fetch", fixtureFetch());
    const c = await mount();
    await type(
      c.querySelector('input[type="email"]')!,
      "draft@example.invalid",
    );
    const link = document.createElement("a");
    link.href = "/catalog";
    document.body.append(link);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    await act(async () => link.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(c.querySelector('[role="alertdialog"]')).not.toBeNull();
  });
});
