// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BulkExportPanel } from "./bulk-export-panel.js";

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
