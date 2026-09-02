// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { ListingQueue } from "./listing-queue.js";
import type { QueueItem } from "./listing-view-models.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(
  items: QueueItem[],
  selected: Set<string> = new Set(),
  eligibleIds: string[] = [],
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ListingQueue, {
        items,
        selected,
        eligibleIds,
        onToggle: () => {},
        onSelectAllEligible: () => {},
      }),
    );
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
}

function buildQueueItem(overrides?: Partial<QueueItem>): QueueItem {
  return {
    id: "listing_1",
    title: "Opak Cabernet 2024",
    subtitle: "OPAK-001 · 澳洲南澳 · HK$288",
    status: "in_review",
    updatedAt: "2026-08-16T00:00:00.000Z",
    nextAction: "繼續審核",
    openBlockingFlagCount: 0,
    ...overrides,
  };
}

describe("ListingQueue", () => {
  it("renders the queue with the provided items", async () => {
    const item = buildQueueItem();
    const { container, root } = await mount([item]);

    expect(container.textContent).toContain("Opak Cabernet 2024");

    await unmount(root);
  });

  it("shows a checkbox for in_review items that are eligible", async () => {
    const item = buildQueueItem();
    const { container, root } = await mount([item], new Set(), ["listing_1"]);

    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(false);

    await unmount(root);
  });

  it("disables the checkbox for in_review items with unresolved compliance flags", async () => {
    const item = buildQueueItem({ openBlockingFlagCount: 3 });
    const { container, root } = await mount([item], new Set(), []);

    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);

    await unmount(root);
  });

  it("includes the listing title in a disabled queue checkbox's accessible label", async () => {
    const item = buildQueueItem({
      title: "Opak Cabernet 2024",
      openBlockingFlagCount: 2,
    });
    const { container, root } = await mount([item], new Set(), []);

    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();

    const ariaLabel = checkbox!.getAttribute("aria-label");
    expect(ariaLabel).toContain("Opak Cabernet 2024");
    expect(ariaLabel).toContain("2");
    expect(ariaLabel).toContain("個未解決的合規標記");

    const titleAttr = checkbox!.getAttribute("title");
    expect(titleAttr).toContain("Opak Cabernet 2024");
    expect(titleAttr).toContain("2");
    expect(titleAttr).toContain("個未解決的合規標記");

    await unmount(root);
  });
});
