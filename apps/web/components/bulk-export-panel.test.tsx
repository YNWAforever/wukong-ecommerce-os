// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BulkExportPanel } from "./bulk-export-panel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function submitExport(
  root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  listingIds: readonly string[],
) {
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds,
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe.each([
  [403, { message: "Reviewer access revoked" }],
  [409, { message: "Eligibility changed", rowCount: 0, manifest: [] }],
  [500, { message: "Server failure" }],
  [200, { exportAttemptId: null, rowCount: 0 }],
])("no-attempt response status %i", (status, body) => {
  it("does not present an unsuccessful or malformed response as a completed zero-row export", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await submitExport(root, container, ["listing-a"]);

    expect(container.textContent).not.toContain(
      "every requested listing was excluded or unchanged",
    );
    expect(container.textContent).not.toContain("Requested: 1");
    expect(
      container.querySelector("[data-zero-row-export-summary]"),
    ).toBeNull();
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});

it("keeps exact mixed zero-row counts and member context bound to the submitted response", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      exportAttemptId: null,
      rowCount: 0,
      manifest: [
        {
          listingId: "listing-no-op",
          versionId: "version-no-op",
          outcome: "excluded_no_op",
          reason: "No enrichable fields changed",
        },
        {
          listingId: "listing-stale",
          versionId: "version-stale",
          outcome: "excluded_stale",
          reason: "Imported source is stale",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await submitExport(root, container, ["listing-no-op", "listing-stale"]);

  const summary = container.querySelector("[data-zero-row-export-summary]")!;
  expect(summary.textContent).toContain("Requested: 2");
  expect(summary.textContent).toContain("Included: 0");
  expect(summary.textContent).toContain("Excluded: 1");
  expect(summary.textContent).toContain("No-op: 1");
  expect(summary.textContent).toContain("listing-no-op");
  expect(summary.textContent).toContain("version-no-op");
  expect(summary.textContent).toContain("excluded_no_op");
  expect(summary.textContent).toContain("No enrichable fields changed");
  expect(summary.textContent).toContain("listing-stale");
  expect(summary.textContent).toContain("version-stale");
  expect(summary.textContent).toContain("excluded_stale");
  expect(summary.textContent).toContain("Imported source is stale");

  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds: ["listing-new"],
        canGenerate: true,
      }),
    ),
  );

  expect(summary.textContent).toContain("Requested: 2");
  expect(summary.textContent).toContain("Excluded: 1");
  expect(summary.textContent).toContain("No-op: 1");
  expect(summary.textContent).toContain("version-stale");
  expect(container.textContent).toContain("1 listing(s) selected");
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("gates generation on permission and explicit freshness, then preserves submitted ids", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      exportAttemptId: null,
      manifest: [
        {
          listingId: "listing-a",
          versionId: null,
          outcome: "excluded_no_op",
          reason: "No changes",
        },
      ],
      rowCount: 0,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds: ["listing-a"],
        canGenerate: true,
      }),
    ),
  );
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain("Generate Bulk Update XLSX");
  expect(button.disabled).toBe(true);
  const checkbox = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  await act(async () => checkbox.click());
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/listings/export",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        listingIds: ["listing-a"],
        freshnessAttested: true,
      }),
    }),
  );
  expect(container.textContent).toContain("No changes");
  expect(container.textContent).toContain("No artifact was created");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("invalidates freshness when the selected listing IDs change", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds: ["listing-a"],
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    false,
  );
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds: ["listing-a", "listing-b"],
        canGenerate: true,
      }),
    ),
  );
  expect(
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .checked,
  ).toBe(false);
  expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    true,
  );
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

it("keeps a POST-created attempt visible and retries only its detail lookup", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        exportAttemptId: "attempt-stable",
        artifactStatus: "pending",
        rowCount: 1,
        manifest: [],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ message: "temporarily unavailable" }, { status: 503 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        attempt: {
          id: "attempt-stable",
          artifactStatus: "ready",
          rowCount: 1,
          specVersion: "v1",
          createdAt: "2026-01-01T00:00:00Z",
        },
        reconciliation: {
          counts: {
            requested: 1,
            included: 1,
            excluded: 0,
            noOp: 0,
            accepted: 0,
            rejected: 0,
            unreported: 1,
          },
          verificationStatus: "unverified",
          members: [],
        },
        capabilities: {
          canGenerateBulkUpdate: true,
          canRecordImportResult: true,
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds: ["listing-a"],
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.textContent).toContain("attempt-stable");
  expect(container.textContent).toContain("pending");
  const retry = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("Retry attempt details"),
  )!;
  await act(async () => {
    retry.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2]![0]).toBe("/api/listings/export/attempt-stable");
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("shows the stable attempt carried by an artifact error response", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          exportAttemptId: "attempt-failed",
          artifactStatus: "failed",
          message: "Upload verification failed",
        },
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ message: "detail unavailable" }, { status: 503 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(BulkExportPanel, {
        listingIds: ["listing-a"],
        canGenerate: true,
      }),
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(
    container.querySelector('[data-export-attempt-id="attempt-failed"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("Artifact status: failed");
  expect(container.textContent).toContain("Retry attempt details");
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
