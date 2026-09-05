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
  expect(markup).toContain("No enrichable fields changed");
  expect(markup).toContain("/api/listings/export/attempt-1/download");
  expect(markup).toContain("Verification: Unverified");
  const rejected = {
    ...detail,
    reconciliation: {
      ...detail.reconciliation,
      members: [
        {
          listingId: "listing-r",
          versionId: "version-r",
          outcome: "included",
          latestResult: {
            id: "result-2",
            outcome: "rejected" as const,
            rejectReason: "Protected field rejected",
            correctionReason: "Corrected prior acceptance",
            revision: 2,
            createdAt: "2026-01-02T00:00:00Z",
          },
          history: [
            {
              id: "result-2",
              outcome: "rejected" as const,
              rejectReason: "Protected field rejected",
              correctionReason: "Corrected prior acceptance",
              revision: 2,
              createdAt: "2026-01-02T00:00:00Z",
            },
            {
              id: "result-1",
              outcome: "rejected" as const,
              rejectReason: "Original row rejected",
              correctionReason: null,
              revision: 1,
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  };
  const rejectedMarkup = renderToStaticMarkup(
    createElement(ExportReconciliationPanel, { detail: rejected }),
  );
  expect(rejectedMarkup).toContain("Protected field rejected");
  expect(rejectedMarkup).toContain("Original row rejected");
  expect(rejectedMarkup).toContain("Corrected prior acceptance");
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
    "The action could not be completed. Please retry.",
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

// Exercise the selected locale explicitly; bilingual coverage lives in listing-detail-locale.test.tsx.
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));

function reported(
  revision: number,
  outcome: "accepted" | "rejected" = "rejected",
): WireExportReconciliationDetail {
  const receipt = {
    id: "result-" + revision,
    revision,
    outcome,
    rejectReason: outcome === "rejected" ? "rejection-" + revision : null,
    correctionReason: revision > 1 ? "correction-" + revision : null,
    createdAt: "2026-01-02T00:00:00Z",
  };
  return {
    ...detail,
    reconciliation: {
      ...detail.reconciliation,
      counts: {
        ...detail.reconciliation.counts,
        accepted: outcome === "accepted" ? 1 : 0,
        rejected: outcome === "rejected" ? 1 : 0,
        unreported: 0,
      },
      members: detail.reconciliation.members.map((m) =>
        m.listingId === "listing-a"
          ? { ...m, latestResult: receipt, history: [receipt] }
          : m,
      ),
    },
  };
}
function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function panelHarness(initial = detail) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: WireExportReconciliationDetail) => {
    await act(async () =>
      root.render(createElement(ExportReconciliationPanel, { detail: next })),
    );
  };
  await render(initial);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}
function count(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("dt")).find(
    (n) => n.textContent === label,
  )?.nextElementSibling?.textContent;
}

it("adopts same-attempt parent receipts, counts, and correction predecessor", async () => {
  const view = await panelHarness();
  try {
    await view.render(reported(1));
    expect(view.container.textContent).toContain("rejection-1");
    expect(count(view.container, "Rejected")).toBe("1");
    expect(count(view.container, "Unreported")).toBe("0");
    expect(
      view.container.querySelector('textarea[aria-label="Correction reason"]'),
    ).not.toBeNull();
  } finally {
    await view.close();
  }
});

it("retains local post-report receipts when a stale parent response arrives", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: { id: "result-2" } }))
    .mockResolvedValueOnce(Response.json(reported(2)));
  vi.stubGlobal("fetch", fetcher);
  const view = await panelHarness();
  try {
    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });
    expect(view.container.textContent).toContain("rejection-2");
    await view.render(reported(1, "accepted"));
    expect(view.container.textContent).toContain("rejection-2");
    expect(count(view.container, "Rejected")).toBe("1");
    expect(count(view.container, "Accepted")).toBe("0");
    await view.render(reported(3, "accepted"));
    expect(view.container.textContent).toContain("correction-3");
    expect(count(view.container, "Accepted")).toBe("1");
  } finally {
    await view.close();
  }
});

it("does not regress newer parent receipts when an older local reload completes", async () => {
  const reload = deferredResponse();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: { id: "result-1" } }))
      .mockReturnValueOnce(reload.promise),
  );
  const view = await panelHarness();
  try {
    await act(async () => {
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });
    await view.render(reported(2));
    await act(async () =>
      reload.resolve(Response.json(reported(1, "accepted"))),
    );
    expect(view.container.textContent).toContain("rejection-2");
    expect(count(view.container, "Rejected")).toBe("1");
    expect(count(view.container, "Accepted")).toBe("0");
  } finally {
    await view.close();
  }
});

it("merges independently newer members rather than choosing a whole response", async () => {
  const withSecond = (
    first: number,
    second: number,
  ): WireExportReconciliationDetail => {
    const value = reported(first);
    const other = reported(second, "accepted").reconciliation.members[0]!;
    return {
      ...value,
      reconciliation: {
        ...value.reconciliation,
        counts: {
          requested: 2,
          included: 2,
          excluded: 0,
          noOp: 0,
          accepted: 1,
          rejected: 1,
          unreported: 0,
        },
        members: [
          value.reconciliation.members[0]!,
          { ...other, listingId: "listing-c", versionId: "version-c" },
        ],
      },
    };
  };
  const view = await panelHarness(withSecond(2, 1));
  try {
    await view.render(withSecond(1, 3));
    expect(
      view.container.querySelector('[data-listing-id="listing-a"]')!
        .textContent,
    ).toContain("rejection-2");
    expect(
      view.container.querySelector('[data-listing-id="listing-c"]')!
        .textContent,
    ).toContain("correction-3");
    expect(count(view.container, "Accepted")).toBe("1");
    expect(count(view.container, "Rejected")).toBe("1");
  } finally {
    await view.close();
  }
});

it("does not apply an old attempt reload to a replacement attempt", async () => {
  const reload = deferredResponse();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: { id: "result-1" } }))
      .mockReturnValueOnce(reload.promise),
  );
  const view = await panelHarness();
  try {
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await view.render({
      ...detail,
      attempt: { ...detail.attempt, id: "attempt-other" },
    });
    await act(async () => reload.resolve(Response.json(reported(1))));
    expect(
      view.container.querySelector("article")!.dataset.exportAttemptId,
    ).toBe("attempt-other");
    expect(view.container.textContent).not.toContain("rejection-1");
    expect(count(view.container, "Unreported")).toBe("1");
  } finally {
    await view.close();
  }
});

it("retains an ambiguous retry through permission loss and restoration without allowing hidden submits", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(Response.json({ replayed: true }))
    .mockResolvedValueOnce(Response.json(reported(1, "accepted")));
  let key = 0;
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("crypto", { randomUUID: () => "key-" + ++key });
  const view = await panelHarness();
  try {
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await view.render({
      ...reported(1, "accepted"),
      capabilities: { ...detail.capabilities, canRecordImportResult: false },
    });
    const retainedForm = view.container.querySelector("form");
    expect(retainedForm).not.toBeNull();
    expect(retainedForm!.hidden).toBe(true);
    expect(retainedForm!.style.display).toBe("none");
    await act(async () =>
      retainedForm!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await view.render(reported(1, "accepted"));
    expect(view.container.querySelector("form")).toBe(retainedForm);
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    expect(fetcher.mock.calls[1]![1]!.body).toBe(
      fetcher.mock.calls[0]![1]!.body,
    );
  } finally {
    await view.close();
  }
});

it("keeps newer parent permission revocation while merging a newer receipt from an obsolete reload", async () => {
  const reload = deferredResponse();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: { id: "result-2" } }))
    .mockReturnValueOnce(reload.promise);
  vi.stubGlobal("fetch", fetcher);
  const view = await panelHarness();
  try {
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await view.render({
      ...reported(1, "accepted"),
      capabilities: { ...detail.capabilities, canRecordImportResult: false },
    });
    await act(async () => reload.resolve(Response.json(reported(2))));
    expect(view.container.querySelector("form")!.hidden).toBe(true);
    expect(
      view.container.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
    ).toBe(true);
    expect(view.container.textContent).toContain("rejection-2");
    expect(count(view.container, "Rejected")).toBe("1");
    await act(async () =>
      view.container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    await view.render(reported(1, "accepted"));
    expect(view.container.querySelector("form")!.hidden).toBe(false);
    expect(view.container.textContent).toContain("rejection-2");
  } finally {
    await view.close();
  }
});

it("keeps newer parent artifact metadata while merging a newer receipt from an obsolete reload", async () => {
  const reload = deferredResponse();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ result: { id: "result-2" } }))
      .mockReturnValueOnce(reload.promise),
  );
  const view = await panelHarness();
  try {
    await act(async () =>
      view.container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await view.render({
      ...reported(1, "accepted"),
      attempt: {
        ...detail.attempt,
        artifactStatus: "failed",
        artifactErrorCode: "artifact_hash_mismatch",
      },
    });
    await act(async () => reload.resolve(Response.json(reported(2))));
    expect(
      view.container.querySelector(".connection-status")!.textContent,
    ).toBe("Failed");
    expect(view.container.querySelector('a[href$="/download"]')).toBeNull();
    expect(view.container.textContent).toContain("rejection-2");
    expect(count(view.container, "Rejected")).toBe("1");
  } finally {
    await view.close();
  }
});

it("orders overlapping local metadata reads without discarding newer receipts in the older read", async () => {
  const first = deferredResponse();
  const second = deferredResponse();
  const initial: WireExportReconciliationDetail = {
    ...detail,
    reconciliation: {
      ...detail.reconciliation,
      counts: {
        requested: 2,
        included: 2,
        excluded: 0,
        noOp: 0,
        accepted: 0,
        rejected: 0,
        unreported: 2,
      },
      members: [
        detail.reconciliation.members[0]!,
        {
          ...detail.reconciliation.members[0]!,
          listingId: "listing-c",
          versionId: "version-c",
        },
      ],
    },
  };
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, options) =>
        options?.method === "POST"
          ? Response.json({ result: { id: "result" } })
          : ++reads === 1
            ? first.promise
            : second.promise,
      ),
  );
  const view = await panelHarness(initial);
  try {
    const buttons = view.container.querySelectorAll<HTMLButtonElement>(
      'button[type="submit"]',
    );
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    await act(async () =>
      second.resolve(
        Response.json({
          ...initial,
          capabilities: {
            ...initial.capabilities,
            canRecordImportResult: false,
          },
          attempt: { ...initial.attempt, artifactStatus: "failed" },
        }),
      ),
    );
    await act(async () =>
      first.resolve(
        Response.json({
          ...initial,
          reconciliation: {
            ...initial.reconciliation,
            members: [
              reported(2).reconciliation.members[0]!,
              initial.reconciliation.members[1]!,
            ],
          },
        }),
      ),
    );
    expect(
      view.container.querySelector(".connection-status")!.textContent,
    ).toBe("Failed");
    expect(view.container.querySelector('a[href$="/download"]')).toBeNull();
    expect(view.container.textContent).toContain("rejection-2");
    expect(count(view.container, "Rejected")).toBe("1");
    expect(count(view.container, "Unreported")).toBe("1");
  } finally {
    await view.close();
  }
});

it("only exposes fresh comparison for ready reviewer-capable attempts", () => {
  const render = (value: WireExportReconciliationDetail) =>
    renderToStaticMarkup(
      createElement(ExportReconciliationPanel, { detail: value }),
    );
  expect(render(detail)).toContain("Compare fresh export");
  expect(
    render({
      ...detail,
      capabilities: {
        ...detail.capabilities,
        canGenerateBulkUpdate: false,
        canRecordImportResult: true,
      },
    }),
  ).not.toContain("Compare fresh export");
  expect(
    render({
      ...detail,
      attempt: { ...detail.attempt, artifactStatus: "pending" },
    }),
  ).not.toContain("Compare fresh export");
  expect(render(detail)).not.toMatch(/<form[^>]*>[^]*<form/);
});
