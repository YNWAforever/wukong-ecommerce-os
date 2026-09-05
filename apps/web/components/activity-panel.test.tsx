// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { ActivityPanel } from "./activity-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// ActivityPanel's own local prop shape -- deliberately NOT imported from
// listing-review-client.tsx's WireListingActivityEntry (unexported) or from
// lib/listing-activity-service.ts's ListingActivityEntry (createdAt: Date,
// not the wire-format string this component actually receives).
type TestActivityEntry =
  | {
      kind: "audit";
      id: string;
      action: string;
      metadata: unknown;
      createdAt: string;
    }
  | {
      kind: "batch";
      id: string;
      label: string;
      status: string;
      createdAt: string;
    }
  | {
      kind: "export";
      id: string;
      outcome: string;
      reason?: string;
      artifactStatus?: string | null;
      provenanceComplete?: boolean;
      createdAt: string;
    };

async function mount(entries: TestActivityEntry[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(ActivityPanel, { entries }));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
}

describe("ActivityPanel", () => {
  it("renders a heading and a list item per activity entry", async () => {
    const entries: TestActivityEntry[] = [
      {
        kind: "audit",
        id: "audit_1",
        action: "listing.approved",
        metadata: null,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      {
        kind: "batch",
        id: "batch_1",
        label: "Bulk import",
        status: "completed",
        createdAt: "2026-08-16T01:00:00.000Z",
      },
    ];
    const { container, root } = await mount(entries);

    const heading = container.querySelector('[role="heading"], h1, h2, h3');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/活動記錄|Activity/);

    const items = container.querySelectorAll('[role="listitem"], li');
    expect(items.length).toBe(2);

    await unmount(root);
  });

  it("shows empty-state text and no list items when there is no activity", async () => {
    const { container, root } = await mount([]);

    const items = container.querySelectorAll('[role="listitem"], li');
    expect(items.length).toBe(0);
    expect(container.textContent).toMatch(/尚無活動記錄|No activity yet/);

    await unmount(root);
  });

  it("marks the empty-state paragraph with role=status", async () => {
    const { container, root } = await mount([]);

    const status = container.querySelector('p.helper-copy[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toMatch(/尚無活動記錄|No activity yet/);

    await unmount(root);
  });

  it("translates a known audit action instead of showing the raw action string", async () => {
    const entries: TestActivityEntry[] = [
      {
        kind: "audit",
        id: "audit_1",
        action: "listing.approved",
        metadata: null,
        createdAt: "2026-08-16T00:00:00.000Z",
      },
    ];
    const { container, root } = await mount(entries);

    expect(container.textContent).toMatch(/已批准 Approved/);
    expect(container.textContent).not.toContain("listing.approved");

    await unmount(root);
  });

  it("translates a batch's raw status enum instead of showing it verbatim", async () => {
    const entries: TestActivityEntry[] = [
      {
        kind: "batch",
        id: "batch_1",
        label: "Bulk import",
        status: "budget_exhausted",
        createdAt: "2026-08-16T01:00:00.000Z",
      },
    ];
    const { container, root } = await mount(entries);

    expect(container.textContent).toMatch(/預算用盡 Budget exhausted/);
    expect(container.textContent).not.toContain("budget_exhausted");

    await unmount(root);
  });

  it("translates an export's raw outcome enum instead of showing it verbatim", async () => {
    const entries: TestActivityEntry[] = [
      {
        kind: "export",
        id: "export_1",
        outcome: "raw_row_invalid",
        createdAt: "2026-08-16T02:00:00.000Z",
      },
    ];
    const { container, root } = await mount(entries);

    expect(container.textContent).toMatch(
      /來源資料無效，未納入 Excluded, invalid source row/,
    );
    expect(container.textContent).not.toContain("raw_row_invalid");

    await unmount(root);
  });

  it("humanizes an unmapped audit action into readable prose instead of raw dots/underscores", async () => {
    const entries: TestActivityEntry[] = [
      {
        kind: "audit",
        id: "audit_2",
        action: "some.unknown.action",
        metadata: null,
        createdAt: "2026-08-16T03:00:00.000Z",
      },
    ];
    const { container, root } = await mount(entries);

    expect(container.textContent).toContain("some unknown action");
    expect(container.textContent).not.toContain("some.unknown.action");
    expect(container.textContent).not.toContain("_");

    await unmount(root);
  });
});

it("shows artifact failure separately from included membership", async () => {
  const { container, root } = await mount([
    {
      kind: "export",
      id: "failed",
      outcome: "included",
      artifactStatus: "failed",
      provenanceComplete: true,
      createdAt: "2026-09-05T00:00:00Z",
    },
  ]);
  expect(container.textContent).toContain("file failed");
  await unmount(root);
});
