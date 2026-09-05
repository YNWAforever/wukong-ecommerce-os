// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ExportReconciliationPanel,
  type WireExportReconciliationDetail,
} from "./export-reconciliation-panel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const detail: WireExportReconciliationDetail = {
  attempt: {
    id: "attempt-1",
    artifactStatus: "ready",
    artifactErrorCode: null,
    rowCount: 1,
    specVersion: "v1",
    createdAt: "2026-01-01T00:00:00Z",
  },
  reconciliation: {
    counts: {
      requested: 2,
      included: 1,
      excluded: 0,
      noOp: 1,
      accepted: 0,
      rejected: 0,
      unreported: 1,
    },
    verificationStatus: "unverified",
    members: [
      {
        listingId: "listing-a",
        versionId: "version-a",
        outcome: "included",
        latestResult: null,
        history: [],
      },
      {
        listingId: "listing-b",
        versionId: null,
        outcome: "excluded_no_op",
        reason: "No content change",
        latestResult: null,
        history: [],
      },
    ],
  },
  capabilities: { canGenerateBulkUpdate: true, canRecordImportResult: true },
};

it("renders stable attempt/member selectors, counts, and ready-only download", () => {
  const markup = renderToStaticMarkup(
    createElement(ExportReconciliationPanel, { detail }),
  );
  expect(markup).toContain('data-export-attempt-id="attempt-1"');
  expect(markup).toContain('data-listing-id="listing-a"');
  expect(markup).toContain("Unreported");
  expect(markup).toContain("No content change");
  expect(markup).toContain("/api/listings/export/attempt-1/download");
  expect(markup).toContain("Verification: Unverified");
});

it("posts an export-bound rejected report and reloads detail", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ result: { id: "result-1" } }, { status: 201 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ...detail,
        reconciliation: {
          ...detail.reconciliation,
          counts: {
            ...detail.reconciliation.counts,
            rejected: 1,
            unreported: 0,
          },
        },
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", { randomUUID: () => "key-1" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(ExportReconciliationPanel, { detail })),
  );
  const select = container.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, "rejected");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const reason = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Rejection reason"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(reason, "SHOPLINE rejected the row");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = Array.from(container.querySelectorAll("button")).find((x) =>
    x.textContent?.includes("Record operator result"),
  )!;
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const body = JSON.parse(
    String((fetcher.mock.calls[0]![1] as RequestInit).body),
  );
  expect(body).toMatchObject({
    mode: "export",
    outcome: "rejected",
    rejectReason: "SHOPLINE rejected the row",
    exportAttemptId: "attempt-1",
    versionId: "version-a",
    idempotencyKey: "key-1",
  });
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    "/api/listings/export/attempt-1",
    expect.objectContaining({ cache: "no-store" }),
  );
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("reuses the idempotency key when an ambiguous result submission is retried", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("connection lost after submit"))
    .mockResolvedValueOnce(
      Response.json({ result: { id: "result-1" }, replayed: true }),
    )
    .mockResolvedValueOnce(Response.json(detail));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", { randomUUID: () => "stable-retry-key" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(ExportReconciliationPanel, { detail })),
  );
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes("Record operator result"),
  )!;
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "connection lost after submit",
  );
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const firstBody = JSON.parse(
    String((fetcher.mock.calls[0]![1] as RequestInit).body),
  );
  const retryBody = JSON.parse(
    String((fetcher.mock.calls[1]![1] as RequestInit).body),
  );
  expect(firstBody.idempotencyKey).toBe("stable-retry-key");
  expect(retryBody.idempotencyKey).toBe(firstBody.idempotencyKey);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
