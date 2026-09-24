// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../lib/locale-context.js";
import type { Locale } from "../lib/locale.js";
import { sharedMessages } from "../lib/ui-copy.js";
import {
  AdvanceBatchButton,
  submitAdvanceBatch,
} from "./advance-batch-button.js";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/batches",
  useSearchParams: () => new URLSearchParams(),
}));

describe("submitAdvanceBatch", () => {
  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    // The same copy every batch screen shows, so the four cannot drift.
    expect(result).toEqual({
      kind: "network_error",
      message: sharedMessages.unreachable,
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          batchId: "batch_1",
          status: "running",
          enqueued: 2,
          spentUsd: 1,
          budgetUsd: 5,
        },
        { status: 200 },
      ),
    );

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({
      kind: "success",
      batchId: "batch_1",
      status: "running",
      enqueued: 2,
      spentUsd: 1,
      budgetUsd: 5,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches/batch_1/advance",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    [403, "insufficient_role", "Operator access is required."],
    [404, "batch_not_found", "This batch no longer exists."],
  ])("maps a %d %s to its message", async (status, code, english) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status }),
      );

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toMatchObject({ kind: "api_error", code });
    if (result.kind === "success") throw new Error("expected a failure");
    // The English half is what the pilot journey reads; the Chinese half must
    // be a real translation rather than the same sentence twice.
    expect(result.message[1]).toBe(english);
    expect(result.message[0]).not.toBe(english);
  });
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdvanceBatchButton", () => {
  it("calls onAdvanced with the success outcome after a successful click", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          batchId: "batch_1",
          status: "running",
          enqueued: 2,
          spentUsd: 1,
          budgetUsd: 5,
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const onAdvanced = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(AdvanceBatchButton, { batchId: "batch_1", onAdvanced }),
      );
    });

    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAdvanced).toHaveBeenCalledWith({
      kind: "success",
      batchId: "batch_1",
      status: "running",
      enqueued: 2,
      spentUsd: 1,
      budgetUsd: 5,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches/batch_1/advance",
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders the error message via the intake-message paragraph after a failed click", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "batch_not_found", message: "server detail" },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const onAdvanced = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(AdvanceBatchButton, { batchId: "batch_1", onAdvanced }),
      );
    });

    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const message = container.querySelector(".intake-message");
    // Chinese, because that is the default locale. This paragraph used to be
    // English whatever language the reader had chosen.
    expect(message?.textContent).toBe(sharedMessages.batchNotFound[0]);
    expect(onAdvanced).toHaveBeenCalledWith({
      kind: "api_error",
      code: "batch_not_found",
      message: sharedMessages.batchNotFound,
    });

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("disables the button while the request is in flight and re-enables it afterward", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(AdvanceBatchButton, { batchId: "batch_1" }));
    });

    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.disabled).toBe(true);

    await act(async () => {
      resolveFetch(
        Response.json(
          {
            batchId: "batch_1",
            status: "running",
            enqueued: 2,
            spentUsd: 1,
            budgetUsd: 5,
          },
          { status: 200 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});

// Chromium rejects a native fetch called with the dependency object as receiver.
it("calls browser fetch without a dependency-object receiver", async () => {
  const fetcher = async function (this: unknown) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return Response.json({
      batchId: "batch_1",
      selected: 2,
      budgetUsd: 1,
      waveSize: 2,
      status: "running",
      enqueued: 2,
      spentUsd: 0,
    });
  } as typeof fetch;
  expect((await submitAdvanceBatch("batch_1", { fetcher })).kind).toBe(
    "success",
  );
});

/**
 * The button that drives the pilot journey, in the reader's language.
 *
 * It printed both languages at once -- 推進下一波 followed by a span reading
 * Advance -- so the language toggle changed nothing here, and the accessible
 * name was two sentences in two languages. The English half is load-bearing:
 * tests/e2e/bulk-update-pilot.spec.ts clicks this button by /Advance/ with the
 * fixture pinned to locale=en, so these pin that contract in milliseconds
 * rather than in a full real-stack run.
 */
describe("AdvanceBatchButton localisation", () => {
  async function mountWithLocale(locale: Locale) {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(LocaleProvider, {
          locale,
          children: createElement(AdvanceBatchButton, { batchId: "batch_1" }),
        }),
      );
    });
    return { container, root };
  }

  async function unmountLocale(root: Root) {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  }

  it("keeps the exact English name the pilot journey clicks", async () => {
    const { container, root } = await mountWithLocale("en");
    try {
      expect(container.querySelector("button")?.textContent).toBe("Advance");
    } finally {
      await unmountLocale(root);
    }
  });

  it("shows one language at a time", async () => {
    const { container, root } = await mountWithLocale("en");
    try {
      expect(container.textContent).not.toContain("推進");
    } finally {
      await unmountLocale(root);
    }
  });

  it("names the action in Chinese for a Chinese reader", async () => {
    const { container, root } = await mountWithLocale("zh-Hant");
    try {
      expect(container.querySelector("button")?.textContent).toBe("推進下一波");
    } finally {
      await unmountLocale(root);
    }
  });
});
