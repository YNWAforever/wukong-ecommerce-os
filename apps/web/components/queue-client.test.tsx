// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { QueueClient } from "./queue-client.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueueClient));
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

function findButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
}

const eligibleItem = {
  id: "listing_1",
  status: "in_review" as const,
  target: "shopline" as const,
  title: "Mosel Riesling Kabinett 2024",
  sku: "OPAK-001",
  updatedAt: "2026-08-16T00:00:00.000Z",
  openBlockingFlagCount: 0,
};

const publishedItem = {
  id: "listing_2",
  status: "published" as const,
  target: "shopline" as const,
  title: "Barolo Riserva 2018",
  sku: "OPAK-004",
  updatedAt: "2026-08-15T00:00:00.000Z",
  openBlockingFlagCount: 0,
};

describe("QueueClient", () => {
  it("renders the fetched listings inside the grouped queue", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ items: [eligibleItem, publishedItem] }),
      );

    const { container, root } = await mount(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/listings",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(container.textContent).toContain("Mosel Riesling Kabinett 2024");
    expect(container.textContent).toContain("Barolo Riserva 2018");

    await unmount(root);
  });

  it("does not render the dashboard's summary metric strip", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [eligibleItem] }));

    const { container, root } = await mount(fetcher);

    expect(container.querySelector(".metric-strip")).toBeNull();

    await unmount(root);
  });

  it("shows a loading state before the fetch resolves", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValue(new Promise(() => {}));

    const { container, root } = await mount(fetcher);

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain("正在載入");

    await unmount(root);
  });

  it("shows an error state instead of crashing when the fetch fails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();

    await unmount(root);
  });

  it("shows an error state when the response is not ok", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "server_error" }, { status: 500 }),
      );

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();

    await unmount(root);
  });

  it("selects eligible items and runs bulk-approve, then reloads the list", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (url === "/api/listings/bulk-approve") {
        return Promise.resolve(
          Response.json({
            results: [
              { listingId: "listing_1", ok: true, versionId: "version_1" },
            ],
            approved: 1,
            failed: 0,
          }),
        );
      }
      return Promise.resolve(Response.json({ items: [eligibleItem] }));
    });

    const { container, root } = await mount(fetcher);

    await act(async () => {
      findButtonByText(container, "全選可批准項目")!.click();
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(container, "批准")!.click();
      await Promise.resolve();
    });

    const bulkCall = calls.find(
      (call) => call.url === "/api/listings/bulk-approve",
    );
    expect(bulkCall).toBeDefined();
    expect(bulkCall!.init?.method).toBe("POST");
    expect(JSON.parse(bulkCall!.init!.body as string)).toEqual({
      listingIds: ["listing_1"],
    });

    // The list reloads after a successful bulk-approve.
    const listingsCalls = calls.filter((call) => call.url === "/api/listings");
    expect(listingsCalls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("listing_1");

    await unmount(root);
  });

  it("shows a visible error and preserves the selection when bulk-approve's request fails outright", async () => {
    const calls: { url: string }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url });
      if (url === "/api/listings/bulk-approve") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(Response.json({ items: [eligibleItem] }));
    });

    const { container, root } = await mount(fetcher);

    await act(async () => {
      findButtonByText(container, "全選可批准項目")!.click();
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(container, "批准")!.click();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Bulk approve failed");

    // Selection is preserved -- the bulk-action-bar only renders while
    // selected.size > 0, and it must still be there after a failed attempt.
    expect(container.querySelector(".bulk-action-bar")).not.toBeNull();
    expect(container.textContent).toContain("1 個項目已選取");

    // The list was not reloaded -- only the one initial /api/listings call.
    const listingsCalls = calls.filter((call) => call.url === "/api/listings");
    expect(listingsCalls.length).toBe(1);

    await unmount(root);
  });

  it("shows the server's error message and does not render the results list when bulk-approve returns a non-ok response", async () => {
    const calls: { url: string }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url });
      if (url === "/api/listings/bulk-approve") {
        return Promise.resolve(
          Response.json(
            { code: "insufficient_role", message: "Reviewer access is required." },
            { status: 403 },
          ),
        );
      }
      return Promise.resolve(Response.json({ items: [eligibleItem] }));
    });

    const { container, root } = await mount(fetcher);

    await act(async () => {
      findButtonByText(container, "全選可批准項目")!.click();
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(container, "批准")!.click();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Reviewer access is required.");

    expect(container.querySelector(".bulk-result-list")).toBeNull();
    expect(container.querySelector(".bulk-action-bar")).not.toBeNull();

    const listingsCalls = calls.filter((call) => call.url === "/api/listings");
    expect(listingsCalls.length).toBe(1);

    await unmount(root);
  });
});
