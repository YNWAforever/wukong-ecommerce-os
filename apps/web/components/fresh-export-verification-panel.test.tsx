// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  FreshExportVerificationPanel,
  comparisonTimeToIso,
} from "./fresh-export-verification-panel";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
it("converts explicit Hong Kong seconds and rejects invalid calendar dates", () => {
  expect(comparisonTimeToIso("2026-09-05T12:34:56")).toBe(
    "2026-09-05T04:34:56.000Z",
  );
  expect(comparisonTimeToIso("2026-02-30T12:34:56")).toBeNull();
  expect(comparisonTimeToIso("2026-09-05T12:34")).toBe(
    "2026-09-05T04:34:00.000Z",
  );
});
it("sends raw selected workbook, explicit time and attestation; retains lost-response retry inputs", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      if (init?.method === "POST") throw new Error("private transport detail");
      return Response.json({ items: [], total: 0, page: 1, pageSize: 10 });
    });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(FreshExportVerificationPanel, { attemptId: "attempt-1" }),
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const file = new File(["xlsx bytes"], "snapshot & 中文.xlsx");
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const time = host.querySelector<HTMLInputElement>(
    'input[type="datetime-local"]',
  )!;
  await act(async () => {
    time.value = "2026-09-05T12:34:56";
    time.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  const submit = () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await act(async () => {
    submit();
    submit();
  });
  const posts = () => fetcher.mock.calls.filter((c) => c[1]?.method === "POST");
  expect(posts()).toHaveLength(1);
  const url = new URL(String(posts()[0]![0]), "http://localhost");
  expect(url.pathname).toBe("/api/listings/export/attempt-1/verifications");
  expect(url.searchParams.get("merchantAttestedExportAt")).toBe(
    "2026-09-05T04:34:56.000Z",
  );
  expect(url.searchParams.get("filename")).toBe(file.name);
  expect(url.searchParams.get("sameStoreAttested")).toBe("true");
  expect(posts()[0]![1]!.body).toBe(file);
  expect(host.textContent).not.toContain("private transport detail");
  expect(time.value).toBe("2026-09-05T12:34:56");
  await act(async () => submit());
  expect(posts()).toHaveLength(2);
  expect(posts()[1]).toEqual(posts()[0]);
  await act(async () => root.unmount());
  host.remove();
});

it("keeps history summary separate from fetched full evidence and bounds paging", async () => {
  const summary = {
    id: "comparison-1",
    filename: "retained.xlsx",
    merchantAttestedExportAt: "2026-09-05T00:00:00Z",
    comparison: { outcome: "inconclusive", counts: { expected: 2 } },
  };
  const full = {
    ...summary,
    createdAt: "2026-09-05T00:00:01Z",
    comparison: {
      ...summary.comparison,
      products: [
        {
          productId: "0001",
          outcome: "missing",
          expectedRow: { rowNumber: 3, cells: [] },
          observedRows: [],
          fields: [],
          quantityDeltaObservations: [],
        },
      ],
    },
    provenance: {
      evidence: [{ listingId: "exact-listing", versionId: "exact-version" }],
    },
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      String(url).includes("verificationId=")
        ? Response.json({ verification: full })
        : Response.json({ items: [summary], total: 21, page: 1, pageSize: 10 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(FreshExportVerificationPanel, { attemptId: "attempt-1" }),
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(host.textContent).toContain("per page; total 21");
  expect(host.querySelector("[data-verification-id]")).toBeNull();
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("retained.xlsx"))!
      .click(),
  );
  expect(String(fetcher.mock.calls[1]![0])).toContain(
    "?verificationId=comparison-1",
  );
  expect(host.textContent).toContain(
    "Fields were not compared; this does not mean matched.",
  );
  expect(host.textContent).toContain("exact-version");
  await act(async () => root.unmount());
});

it("ignores a superseded full-detail response", async () => {
  let finishOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const summary = (id: string) => ({
    id,
    filename: id + ".xlsx",
    merchantAttestedExportAt: "2026-09-05T00:00:00Z",
    comparison: { outcome: "inconclusive", counts: { expected: 0 } },
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).includes("verificationId=old")) return old;
    if (String(url).includes("verificationId=new"))
      return Response.json({
        verification: {
          ...summary("new"),
          createdAt: "2026-09-05T00:00:00Z",
          comparison: { ...summary("new").comparison, products: [] },
        },
      });
    return Response.json({
      items: [summary("old"), summary("new")],
      total: 2,
      page: 1,
      pageSize: 10,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"),
    root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(FreshExportVerificationPanel, { attemptId: "attempt-1" }),
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const select = (name: string) =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent?.startsWith(name))!
      .click();
  await act(async () => select("old.xlsx"));
  await act(async () => select("new.xlsx"));
  await act(async () =>
    finishOld(
      Response.json({
        verification: {
          ...summary("old"),
          createdAt: "2026-09-05T00:00:00Z",
          comparison: { ...summary("old").comparison, products: [] },
        },
      }),
    ),
  );
  expect(
    host
      .querySelector("[data-verification-id]")
      ?.getAttribute("data-verification-id"),
  ).toBe("new");
  await act(async () => root.unmount());
});

it("rejects missing selection/time/attestation without posting and ignores superseded history", async () => {
  let finishOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(
      Response.json({ items: [], total: 5, page: 1, pageSize: 10 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"),
    root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(FreshExportVerificationPanel, { attemptId: "attempt-1" }),
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(host.textContent).toContain("Choose an XLSX up to 4 MiB");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  await act(async () =>
    finishOld(Response.json({ items: [], total: 1, page: 1, pageSize: 10 })),
  );
  expect(host.textContent).toContain("per page; total 5");
  await act(async () => root.unmount());
});
