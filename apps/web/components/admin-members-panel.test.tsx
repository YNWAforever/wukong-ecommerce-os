// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminMembersPanel } from "./admin-members-panel";

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
    root.render(createElement(AdminMembersPanel));
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

describe("AdminMembersPanel", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders a stable members-panel root before data loads", () => {
    // Note: this only proves the initial (pre-fetch) render is stable --
    // renderToStaticMarkup can't await a client-side useEffect fetch, since
    // it renders synchronously and never runs effects. The fetched-state
    // assertions live in the mounted test below, which uses react-dom/client
    // + act, matching the convention already used by
    // listing-review-client.test.ts for this codebase's other
    // fetch-on-mount component (there is no @testing-library/react
    // dependency here).
    globalThis.fetch = vi.fn<typeof fetch>() as unknown as typeof fetch;
    const markup = renderToStaticMarkup(createElement(AdminMembersPanel));
    expect(markup).toContain("members-panel");
  });

  it("renders active members and pending invites with a status badge", async () => {
    const fetcher = stubFetch({
      members: [
        {
          userId: "u1",
          email: "admin@opak.test",
          role: "admin",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      invites: [
        {
          id: "inv1",
          email: "new@opak.test",
          role: "operator",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    const { container } = await mountPanel();

    expect(fetcher).toHaveBeenCalledWith("/api/workspace/members");
    expect(container.textContent).toContain("admin@opak.test");
    expect(container.textContent).toContain("啟用中 Active");
    expect(container.textContent).toContain("new@opak.test");
    expect(container.textContent).toContain("operator");
    expect(container.textContent).toContain("待接受 Pending");
  });

  it("labels every form control accessibly", async () => {
    stubFetch({
      members: [
        {
          userId: "u1",
          email: "admin@opak.test",
          role: "admin",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      invites: [],
    });

    const { container } = await mountPanel();

    expect(
      container.querySelector('select[aria-label*="Change role for admin@opak.test"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('input[aria-label="邀請成員的電子郵件 Invite email address"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('select[aria-label="新成員的角色 Role for new member"]'),
    ).not.toBeNull();
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
