// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobsLedgerClient } from "./jobs-ledger-client";

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

async function mountLedger() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(JobsLedgerClient));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settleEffects();
  return { container, root };
}

function stubFetch(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const SAMPLE_METRICS = {
  publishRetries: 3,
  versionConflicts: 1,
  staleSourceRejections: 2,
  importedRows: 120,
};

const SAMPLE_ENTRIES = [
  {
    kind: "export",
    id: "e1",
    listingId: null,
    normalizedStatus: "succeeded",
    rawStatus: "export_attempts",
    createdAt: "2026-08-04T00:00:00.000Z",
    summary: "Export: 1 row(s)",
  },
  {
    kind: "pipeline_run",
    id: "pr1",
    listingId: "l2",
    normalizedStatus: "running",
    rawStatus: "started",
    createdAt: "2026-08-03T00:00:00.000Z",
    summary: "AI pipeline run",
  },
  {
    kind: "publish_job",
    id: "p1",
    listingId: "l1",
    normalizedStatus: "failed",
    rawStatus: "failed",
    createdAt: "2026-08-02T00:00:00.000Z",
    summary: "Publish failed",
  },
  {
    kind: "batch",
    id: "b1",
    listingId: null,
    normalizedStatus: "pending",
    rawStatus: "open",
    createdAt: "2026-08-01T00:00:00.000Z",
    summary: "Batch 1 (wave 3, $5.00)",
  },
];

describe("JobsLedgerClient", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders a stable root before data loads", () => {
    // renderToStaticMarkup can't await the client-side useEffect fetch since
    // it renders synchronously and never runs effects -- see
    // admin-connection-panel.test.tsx for the same convention.
    globalThis.fetch = vi.fn<typeof fetch>() as unknown as typeof fetch;
    const markup = renderToStaticMarkup(createElement(JobsLedgerClient));
    expect(markup).toContain("正在載入");
  });

  it("fetches /api/jobs and renders one row per entry, showing kind, summary, and rawStatus", async () => {
    const fetcher = stubFetch({
      entries: SAMPLE_ENTRIES,
      metrics: SAMPLE_METRICS,
    });

    const { container } = await mountLedger();

    expect(fetcher).toHaveBeenCalledWith(
      "/api/jobs?page=1&pageSize=50",
      expect.objectContaining({ cache: "no-store" }),
    );

    const rows = container.querySelectorAll(".flag-item");
    expect(rows.length).toBe(SAMPLE_ENTRIES.length);

    expect(container.textContent).toContain("Export: 1 row(s)");
    expect(container.textContent).toContain("export_attempts");
    expect(container.textContent).toContain("AI pipeline run");
    expect(container.textContent).toContain("started");
    expect(container.textContent).toContain("Publish failed");
    expect(container.textContent).toContain("Batch 1 (wave 3, $5.00)");
    expect(container.textContent).toContain("open");
  });

  it("renders a listing link only when listingId is non-null", async () => {
    stubFetch({ entries: SAMPLE_ENTRIES, metrics: SAMPLE_METRICS });

    const { container } = await mountLedger();

    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a[href^='/listings/']"),
    );
    const hrefs = links.map((link) => link.getAttribute("href")).sort();
    // Only pr1 (l2) and p1 (l1) have a listingId; e1 and b1 have null.
    expect(hrefs).toEqual(["/listings/l1", "/listings/l2"]);
  });

  it("narrows visible rows to the selected kind via the filter toggle, and back to All", async () => {
    stubFetch({ entries: SAMPLE_ENTRIES, metrics: SAMPLE_METRICS });

    const { container } = await mountLedger();

    expect(container.querySelectorAll(".flag-item").length).toBe(4);

    const exportButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("匯出"),
    );
    expect(exportButton).not.toBeUndefined();

    await act(async () => {
      exportButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const filteredRows = container.querySelectorAll(".flag-item");
    expect(filteredRows.length).toBe(1);
    expect(container.textContent).toContain("Export: 1 row(s)");
    expect(container.textContent).not.toContain("AI pipeline run");

    const allButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("全部"),
    );
    await act(async () => {
      allButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelectorAll(".flag-item").length).toBe(4);
  });

  it("renders and filters on the import_result kind", async () => {
    const entries = [
      ...SAMPLE_ENTRIES,
      {
        kind: "import_result",
        id: "ir1",
        listingId: "l4",
        normalizedStatus: "succeeded",
        rawStatus: "accepted",
        createdAt: "2026-08-05T00:00:00.000Z",
        summary: "Import accepted by SHOPLINE",
      },
    ];
    stubFetch({ entries, metrics: SAMPLE_METRICS });

    const { container } = await mountLedger();

    expect(container.querySelectorAll(".flag-item").length).toBe(
      entries.length,
    );
    expect(container.textContent).toContain("Import accepted by SHOPLINE");

    const importResultButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("匯入結果"));
    expect(importResultButton).not.toBeUndefined();

    await act(async () => {
      importResultButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const filteredRows = container.querySelectorAll(".flag-item");
    expect(filteredRows.length).toBe(1);
    expect(container.textContent).toContain("Import accepted by SHOPLINE");
  });

  it("renders a visible error state when the fetch fails", async () => {
    stubFetch({ message: "workspace not found" }, 500);

    const { container } = await mountLedger();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "無法載入資料，請重試。",
    );
  });

  it("renders a visible error state when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("network down")),
    );

    const { container } = await mountLedger();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "無法載入資料，請重試。",
    );
  });

  it("aborts the in-flight fetch's signal when the component unmounts", async () => {
    // Capture the AbortSignal the component actually passes to fetch, then
    // assert it's aborted once the component unmounts -- this exercises the
    // effect's cleanup directly, rather than inferring it indirectly (React
    // 18+ no longer warns on a state update after unmount, so a "no console
    // warning fired" assertion would pass even with no cleanup at all).
    let capturedSignal: AbortSignal | undefined;
    const pending = new Promise<Response>(() => {
      // Deliberately never resolves -- the component should still be safe
      // to unmount while this is in flight.
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return pending;
      }) as unknown as typeof fetch,
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobsLedgerClient));
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });

    expect(capturedSignal?.aborted).toBe(true);

    document.body.innerHTML = "";
  });

  it("renders a metric tile for each of the 4 new observability metrics", async () => {
    stubFetch({ entries: [], metrics: SAMPLE_METRICS });

    const { container } = await mountLedger();

    const values = Array.from(
      container.querySelectorAll(".jobs-metric-strip .metric-value"),
    ).map((tile) => tile.textContent);
    expect(values).toEqual(["3", "1", "2", "120"]);
  });
  it("renders mixed export reconciliation totals and correction history", async () => {
    stubFetch({
      entries: [],
      metrics: SAMPLE_METRICS,
      capabilities: {
        canGenerateBulkUpdate: true,
        canRecordImportResult: true,
      },
      exportReconciliations: [
        {
          attempt: {
            id: "attempt-mixed",
            artifactStatus: "ready",
            rowCount: 2,
            specVersion: "v1",
            createdAt: "2026-08-06T00:00:00Z",
          },
          reconciliation: {
            counts: {
              requested: 3,
              included: 2,
              excluded: 0,
              noOp: 1,
              accepted: 1,
              rejected: 1,
              unreported: 0,
            },
            verificationStatus: "unverified",
            members: [
              {
                listingId: "listing-a",
                versionId: "version-a",
                outcome: "included",
                latestResult: {
                  id: "r2",
                  outcome: "accepted",
                  rejectReason: null,
                  correctionReason: "Merchant retried",
                  revision: 2,
                  createdAt: "2026-08-07T00:00:00Z",
                },
                history: [
                  {
                    id: "r2",
                    outcome: "accepted",
                    rejectReason: null,
                    correctionReason: "Merchant retried",
                    revision: 2,
                    createdAt: "2026-08-07T00:00:00Z",
                  },
                  {
                    id: "r1",
                    outcome: "rejected",
                    rejectReason: "Invalid",
                    correctionReason: null,
                    revision: 1,
                    createdAt: "2026-08-06T00:00:00Z",
                  },
                ],
              },
              {
                listingId: "listing-b",
                versionId: "version-b",
                outcome: "included",
                latestResult: {
                  id: "r3",
                  outcome: "rejected",
                  rejectReason: "Invalid",
                  correctionReason: null,
                  revision: 1,
                  createdAt: "2026-08-06T00:00:00Z",
                },
                history: [
                  {
                    id: "r3",
                    outcome: "rejected",
                    rejectReason: "Invalid",
                    correctionReason: null,
                    revision: 1,
                    createdAt: "2026-08-06T00:00:00Z",
                  },
                ],
              },
              {
                listingId: "listing-c",
                versionId: null,
                outcome: "excluded_no_op",
                reason: "No change",
                latestResult: null,
                history: [],
              },
            ],
          },
        },
      ],
    });
    const { container } = await mountLedger();
    expect(
      container.querySelector('[data-export-attempt-id="attempt-mixed"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Correction history");
    expect(container.textContent).toContain("Merchant retried");
    expect(container.textContent).toContain("Rejection reason: Invalid");
    expect(container.textContent).toContain("Accepted1");
    expect(container.textContent).toContain("Rejected1");
  });
});
