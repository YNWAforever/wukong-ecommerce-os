// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/locale-context.js";
import type { Locale } from "../lib/locale.js";
import { stateLabel } from "../lib/ui-copy.js";
import { BatchList } from "./batch-list.js";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/batches",
  useSearchParams: () => new URLSearchParams(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Same as `mount`, with the reader's chosen language in place. */
async function mountWithLocale(
  fetcher: ReturnType<typeof vi.fn>,
  locale: Locale,
) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale,
        children: createElement(BatchList),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(BatchList));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
}

describe("BatchList", () => {
  it("renders each batch's label and status after fetching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batches: [
          {
            id: "batch_1",
            label: "zh names",
            budgetUsd: 5,
            waveSize: 3,
            status: "running",
            createdBy: "user_1",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const { container, root } = await mount(fetcher);

    expect(container.textContent).toContain("zh names");
    expect(fetcher).toHaveBeenCalledWith("/api/enrichment-batches");

    await unmount(root);
  });

  it("links each batch to /batches/{id}", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batches: [
          {
            id: "batch_42",
            label: "seo titles",
            budgetUsd: 12.5,
            waveSize: 2,
            status: "completed",
            createdBy: "user_1",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        ],
      }),
    );

    const { container, root } = await mount(fetcher);

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/batches/batch_42");
    expect(link!.textContent).toBe("seo titles");

    await unmount(root);
  });

  it("renders an empty-state message when there are no batches", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ batches: [] }));

    const { container, root } = await mount(fetcher);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("尚無批次紀錄");

    await unmount(root);
  });

  it("renders an error message instead of crashing when the response is not ok", async () => {
    // Regression: a viewer-role user's GET 403s with {code, message}. The
    // body still parses as JSON, so without a response.ok check the old code
    // did `setBatches(undefined)` and then crashed on `batches.length`.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          code: "insufficient_role",
          message: "server detail",
        },
        { status: 403 },
      ),
    );

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    // Chinese, because that is the default locale: this alert used to be
    // English whatever language the reader had chosen.
    expect(alert!.textContent).toBe("需要操作員權限。");
    expect(container.querySelector("a")).toBeNull();

    await unmount(root);
  });

  it("renders an error message instead of hanging on a network failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("無法連線至伺服器，請重試。");
    expect(container.textContent).not.toContain("載入中");

    await unmount(root);
  });
});

describe("BatchList localisation", () => {
  const batches = [
    {
      id: "batch_1",
      label: "Opak spring cohort",
      budgetUsd: 5,
      waveSize: 3,
      status: "open" as const,
      createdBy: "user_1",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ];

  it("names a status the way the rest of the product does", async () => {
    // This file carried its own fourth status map, in which `open` was
    // 待開始 where `states` says 開放中.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ batches }));

    const { container, root } = await mount(fetcher);
    try {
      expect(container.textContent).toContain(stateLabel("open", "zh-Hant"));
      expect(container.textContent).not.toContain("待開始");
    } finally {
      await unmount(root);
    }
  });

  it("answers in English when the reader has chosen English", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ batches }));

    const { container, root } = await mountWithLocale(fetcher, "en");
    try {
      expect(container.textContent).toContain(stateLabel("open", "en"));
      expect(container.textContent).not.toContain("每波");
      expect(container.textContent).not.toContain("預算");
    } finally {
      await unmount(root);
    }
  });

  it("reports a failure in the reader's language", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "insufficient_role" }, { status: 403 }),
      );

    const { container, root } = await mountWithLocale(fetcher, "zh-Hant");
    try {
      expect(container.textContent).not.toContain(
        "Operator access is required.",
      );
      expect(container.textContent).toMatch(/[一-鿿]/);
    } finally {
      await unmount(root);
    }
  });
});
