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

async function mountLedger(initialSearch?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<JobsLedgerClient initialSearch={initialSearch} />);
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
    expect(container.textContent).toContain("更正記錄");
    expect(container.textContent).toContain("Merchant retried");
    expect(container.textContent).toContain("拒絕原因： Invalid");
    expect(container.textContent).toContain("操作員回報接受1");
    expect(container.textContent).toContain("操作員回報拒絕1");
  });
});

it("opens exact URL attempt despite ledger failure", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  window.history.replaceState(
    null,
    "",
    `/jobs?kind=export&attempt=${id}&returnTo=${encodeURIComponent("/dashboard?state=attention&page=2")}`,
  );
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      Response.json(
        {},
        { status: String(input).startsWith("/api/jobs?") ? 503 : 404 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    const { container } = await mountLedger();
    expect(fetcher.mock.calls.map(([url]) => url)).toContain(
      `/api/listings/export/${id}`,
    );
    expect(fetcher.mock.calls.map(([url]) => url)).toContain(
      "/api/jobs?page=1&pageSize=50&kind=export",
    );
    expect(
      container.querySelector('a[href="/dashboard?state=attention&page=2"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(".export-attempt-detail [role=alert]"),
    ).not.toBeNull();
    expect(
      container.querySelector(
        'a[href="/jobs?returnTo=%2Fdashboard%3Fstate%3Dattention%26page%3D2"]',
      ),
    ).not.toBeNull();
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

it("renders an older exact attempt absent from page one, retaining viewer restrictions", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  window.history.replaceState(null, "", `/jobs?kind=export&attempt=${id}`);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    Response.json(
      String(input).startsWith("/api/jobs?")
        ? {
            entries: [],
            metrics: SAMPLE_METRICS,
            page: 1,
            pageSize: 50,
            totalMatching: 200,
            total: 200,
          }
        : {
            attempt: {
              id,
              artifactStatus: "ready",
              artifactErrorCode: null,
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
              canGenerateBulkUpdate: false,
              canRecordImportResult: false,
            },
          },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const { container } = await mountLedger();
    expect(
      container.querySelector(`[data-export-attempt-id="${id}"]`),
    ).not.toBeNull();
    expect(container.textContent).toContain("驗證：未獨立核實");
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/jobs?"),
      ),
    ).toHaveLength(1);
  } finally {
    window.history.replaceState(null, "", "/");
  }
});
it("rejects malformed attempt URL without fetching its detail", async () => {
  window.history.replaceState(null, "", "/jobs?attempt=..%2Fforeign");
  const fetcher = stubFetch({ entries: [], metrics: SAMPLE_METRICS });
  try {
    const { container } = await mountLedger();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "連結無效",
    );
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/jobs?")),
    ).toBe(true);
  } finally {
    window.history.replaceState(null, "", "/");
  }
});
it("updates exact attempt to All jobs and follows changed URL pages without remounting", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      String(input).startsWith("/api/jobs?")
        ? Response.json({ entries: SAMPLE_ENTRIES, metrics: SAMPLE_METRICS })
        : Response.json({}, { status: 404 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const { container, root } = await mountLedger(`kind=export&attempt=${id}`);
  await settleEffects();
  expect(container.querySelector('[aria-label="指定匯出紀錄"]')).not.toBeNull();
  expect(fetcher.mock.calls.map(([url]) => url)).toContain(
    "/api/jobs?page=1&pageSize=50&kind=export",
  );
  await act(async () => root.render(<JobsLedgerClient initialSearch={""} />));
  await settleEffects();
  expect(container.querySelector('[aria-label="指定匯出紀錄"]')).toBeNull();
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe("/api/jobs?page=1&pageSize=50");
  expect(container.textContent).toContain("AI pipeline run");
  await act(async () =>
    root.render(<JobsLedgerClient initialSearch={"kind=publish_job&page=3"} />),
  );
  await settleEffects();
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
    "/api/jobs?page=3&pageSize=50&kind=publish_job",
  );
  await act(async () => root.unmount());
});

it("clears previous exact attempt during navigation and failure, retries the new attempt, and preserves return-only form state", async () => {
  const attemptA = "11111111-1111-4111-8111-111111111111";
  const attemptB = "22222222-2222-4222-8222-222222222222";
  const detail = (id: string) => ({
    attempt: {
      id,
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
      members: [
        {
          listingId: "listing-a",
          versionId: "version-a",
          outcome: "included",
          latestResult: null,
          history: [],
        },
      ],
    },
    capabilities: { canGenerateBulkUpdate: false, canRecordImportResult: true },
  });
  let finishB!: (response: Response) => void;
  const pendingB = new Promise<Response>((resolve) => {
    finishB = resolve;
  });
  let bRequests = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).startsWith("/api/jobs?"))
      return Response.json({ entries: [], metrics: SAMPLE_METRICS });
    if (String(input) === `/api/listings/export/${attemptA}`)
      return Response.json(detail(attemptA));
    if (String(input) === `/api/listings/export/${attemptB}`) {
      bRequests += 1;
      return bRequests === 1 ? pendingB : Response.json(detail(attemptB));
    }
    throw new Error(`Unexpected request: ${input}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const { container, root } = await mountLedger(`attempt=${attemptA}`);
  try {
    const aPanel = container.querySelector(
      `[data-export-attempt-id="${attemptA}"]`,
    );
    expect(aPanel).not.toBeNull();
    const outcome = aPanel!.querySelector("select")!;
    await act(async () => {
      outcome.value = "rejected";
      outcome.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      root.render(
        <JobsLedgerClient
          initialSearch={`attempt=${attemptA}&returnTo=%2Fdashboard%3Fpage%3D2`}
        />,
      ),
    );
    expect(
      container.querySelector(`[data-export-attempt-id="${attemptA}"]`),
    ).toBe(aPanel);
    expect(aPanel!.querySelector("select")?.value).toBe("rejected");
    expect(aPanel!.querySelector("textarea")).not.toBeNull();
    await act(async () =>
      root.render(<JobsLedgerClient initialSearch={`attempt=${attemptB}`} />),
    );
    expect(
      container.querySelector(`[data-export-attempt-id="${attemptA}"]`),
    ).toBeNull();
    expect(
      container.querySelector(".export-attempt-detail [role=status]"),
    ).not.toBeNull();
    await act(async () => {
      finishB(Response.json({}, { status: 404 }));
    });
    await settleEffects();
    expect(
      container.querySelector(`[data-export-attempt-id="${attemptA}"]`),
    ).toBeNull();
    expect(
      container.querySelector(".export-attempt-detail [role=alert]"),
    ).not.toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(
      ".export-attempt-detail [role=alert] button",
    )!;
    await act(async () => retry.click());
    await settleEffects();
    expect(bRequests).toBe(2);
    expect(
      container.querySelector(`[data-export-attempt-id="${attemptB}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-export-attempt-id="${attemptA}"]`),
    ).toBeNull();
    expect(
      container.querySelector(".export-attempt-detail [role=alert]"),
    ).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
