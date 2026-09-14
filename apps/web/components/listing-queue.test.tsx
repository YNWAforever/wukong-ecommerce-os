// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { stateLabel } from "../lib/ui-copy.js";
import { ListingQueue } from "./listing-queue.js";
import { queueGroups } from "./listing-view-models.js";
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
    expect(ariaLabel).toBe("Opak Cabernet 2024 · 2 個未解決的合規標記");

    const titleAttr = checkbox!.getAttribute("title");
    expect(titleAttr).toBe("Opak Cabernet 2024 · 2 個未解決的合規標記");

    await unmount(root);
  });
});

describe("ListingQueue review readiness", () => {
  it("explains missing review readiness without claiming zero unresolved flags", async () => {
    const { container, root } = await mount([buildQueueItem()]);
    try {
      const checkbox = container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
      expect(checkbox.getAttribute("title")).toContain("請開啟項目完成審核");
      expect(checkbox.getAttribute("title")).not.toContain("0 unresolved");
    } finally {
      await unmount(root);
    }
  });
});

/**
 * The same status, named two different ways.
 *
 * Queue headings carried their own copy while the catalog badge read from
 * `states`, and the two drifted: a published listing was 已上架 on the queue
 * and 已發佈 in the catalog, and publishing was 發布中 on the queue against
 * 發佈中 everywhere else -- the Simplified form of a word the rest of the
 * product spells the Traditional way. An operator moving between two screens
 * saw two vocabularies for one workflow.
 *
 * The fix is one map, not two that agree today.
 */
describe("queue group headings", () => {
  it("names a status exactly as the rest of the product does", async () => {
    const { container, root } = await mount([
      buildQueueItem({ status: "published" }),
      buildQueueItem({ id: "listing_2", status: "publishing" }),
    ]);
    try {
      const headings = Array.from(container.querySelectorAll("h3")).map(
        (heading) => heading.textContent,
      );

      expect(headings).toContain(stateLabel("published", "zh-Hant"));
      expect(headings).toContain(stateLabel("publishing", "zh-Hant"));
      // The wording the queue used to carry on its own.
      expect(headings).not.toContain("已上架");
      expect(headings).not.toContain("發布中");
    } finally {
      await unmount(root);
    }
  });

  it("has a shared label for every group it renders", async () => {
    // Guards the risk the unification introduces: a queue status missing from
    // `states` would render "狀態未明" where a real label used to be.
    for (const group of queueGroups) {
      expect(stateLabel(group.status, "zh-Hant")).not.toBe("狀態未明");
      expect(stateLabel(group.status, "en")).not.toBe("Unknown status");
    }
  });
});
