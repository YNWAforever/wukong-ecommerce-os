// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbookImportPanel } from "./workbook-import-panel";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const preview = (name = "Sample", eligibleProducts = 21) => ({
  filename: "sample.xlsx",
  sheetName: "Default",
  workbookSha256: "a".repeat(64),
  headerContractSha256: "b".repeat(64),
  specVersion: "v1",
  inferredExportTime: null,
  totalRows: 22,
  eligibleProducts,
  excludedRows: 1,
  products: [
    {
      rowNumber: 3,
      productId: "001",
      sku: "SKU",
      title: { en: name, "zh-Hant": "範例" },
      priceHkd: 100,
    },
  ],
  issues: [
    {
      code: "variant_row_blocked",
      severity: "error",
      row: 4,
      message: "Variant row is unsupported",
    },
  ],
  totalIssues: 1,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve!: (r: Response) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Response>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function mount(fetcher: ReturnType<typeof vi.fn>, canImport = true) {
  vi.stubGlobal("fetch", fetcher);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(createElement(WorkbookImportPanel, { canImport })),
  );
}
async function select(name = "sample.xlsx") {
  const file = new File(["retained bytes"], name);
  await act(async () => {
    const input =
      container.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
}
function button(label: string) {
  const b = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  expect(b).toBeDefined();
  return b!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("automatically previews retained bytes, then explicitly imports the full eligible count with exact hashes", async () => {
  const pending = deferred();
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(
      json({
        importId: "i",
        importedProducts: 21,
        alreadyImportedProducts: 0,
        excludedRows: 1,
      }),
    );
  await mount(fetcher);
  const file = await select();
  expect(container.textContent).toContain("Reading workbook");
  expect(fetcher.mock.calls[0]![1].body).toBe(file);
  expect(container.querySelectorAll("input:not([type=file])")).toHaveLength(0);
  await act(async () => pending.resolve(json(preview())));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Preview sample");
  expect(container.textContent).toContain("21 eligible");
  expect(container.textContent).toContain("1 excluded");
  expect(container.textContent).toContain("Variant");
  await click("Import 21 products");
  expect(fetcher.mock.calls[1]![1].body).toBe(file);
  expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
    "x-workbook-sha256": "a".repeat(64),
    "x-workbook-header-sha256": "b".repeat(64),
  });
  expect(container.textContent).toContain("21 imported");
  expect(container.querySelector('a[href="/catalog"]')).not.toBeNull();
});
it("retains preview and file on save failure; retry saves once and shows replay counts", async () => {
  const pending = deferred();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(preview()))
    .mockResolvedValueOnce(json({}, 500))
    .mockReturnValueOnce(pending.promise);
  await mount(fetcher);
  const file = await select();
  await click("Import 21 products");
  expect(container.textContent).toContain("Sample");
  await act(async () => {
    button("Retry import").click();
    button("Retry import").click();
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2]![1].body).toBe(file);
  await act(async () =>
    pending.resolve(
      json({
        importedProducts: 0,
        alreadyImportedProducts: 21,
        excludedRows: 1,
      }),
    ),
  );
  expect(container.textContent).toContain("21 already imported");
});
it("retries preview at the failed stage with retained file", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("private server error"))
    .mockResolvedValueOnce(json(preview()));
  await mount(fetcher);
  const file = await select();
  expect(container.textContent).not.toContain("private server error");
  await click("Retry preview");
  expect(fetcher.mock.calls[1]![0]).toContain("/preview?");
  expect(fetcher.mock.calls[1]![1].body).toBe(file);
  expect(button("Import 21 products").disabled).toBe(false);
});
it.each(["resolve", "reject"] as const)(
  "ignores old preview %s after changing files",
  async (mode) => {
    const old = deferred();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json(preview("Latest")));
    await mount(fetcher);
    await select("old.xlsx");
    const signal = fetcher.mock.calls[0]![1].signal;
    await select("new.xlsx");
    expect(signal.aborted).toBe(true);
    await act(async () => {
      if (mode === "resolve") old.resolve(json(preview("Old")));
      else old.reject(new Error("old error"));
    });
    expect(container.textContent).toContain("Latest");
    expect(container.textContent).not.toContain("Old");
    expect(container.querySelector("[role=alert]")).toBeNull();
  },
);
it.each(["resolve", "reject"] as const)(
  "ignores old save %s and clears actionable preview on a new file",
  async (mode) => {
    const old = deferred(),
      next = deferred();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(preview()))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    await mount(fetcher);
    await select();
    await click("Import 21 products");
    await select("new.xlsx");
    expect(container.textContent).not.toContain("Import 21 products");
    await act(async () => {
      if (mode === "resolve")
        old.resolve(
          json({
            importedProducts: 21,
            alreadyImportedProducts: 0,
            excludedRows: 1,
          }),
        );
      else old.reject(new Error("old"));
    });
    expect(container.textContent).not.toContain("21 imported");
    expect(container.querySelector("[role=alert]")).toBeNull();
    await act(async () => next.resolve(json(preview("New"))));
    expect(button("Import 21 products").disabled).toBe(false);
  },
);
it("blocks preview and save without operator capability including capability loss", async () => {
  const fetcher = vi.fn().mockResolvedValue(json(preview()));
  await mount(fetcher, false);
  await select();
  expect(fetcher).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Operator access");
  await act(async () =>
    root.render(createElement(WorkbookImportPanel, { canImport: true })),
  );
  await select();
  await act(async () =>
    root.render(createElement(WorkbookImportPanel, { canImport: false })),
  );
  expect(button("Import 21 products").disabled).toBe(true);
  await click("Import 21 products");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not save zero eligible products and renders source text safely", async () => {
  await mount(
    vi
      .fn()
      .mockResolvedValue(
        json(preview("<img src=https://bad.example/x onerror=bad()>", 0)),
      ),
  );
  await select();
  expect(button("Import 0 products").disabled).toBe(true);
  expect(container.querySelector("img,script")).toBeNull();
  expect(container.textContent).toContain("<img");
});

it.each([
  [401, "Sign in again"],
  [403, "Operator access"],
  [413, "smaller XLSX"],
  [422, "Unsupported columns"],
])(
  "keeps the selected file and gives safe actionable %s errors",
  async (status, message) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json(
          { code: "workbook_unrecognized", message: "private internals" },
          Number(status),
        ),
      );
    await mount(fetcher);
    await select();
    expect(container.textContent).toContain(String(message));
    expect(container.textContent).toContain("sample.xlsx");
    expect(container.textContent).not.toContain("private internals");
    expect(button("Retry preview")).toBeDefined();
  },
);
it("requires a new preview after digest mismatch and saves with only the new hashes", async () => {
  const next = {
    ...preview("Refreshed"),
    workbookSha256: "c".repeat(64),
    headerContractSha256: "d".repeat(64),
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(preview()))
    .mockResolvedValueOnce(json({ code: "workbook_preview_mismatch" }, 409))
    .mockResolvedValueOnce(json(next))
    .mockResolvedValueOnce(
      json({
        importedProducts: 21,
        alreadyImportedProducts: 0,
        excludedRows: 1,
      }),
    );
  await mount(fetcher);
  const file = await select();
  await click("Import 21 products");
  expect(button("Import 21 products").disabled).toBe(true);
  await click("Retry preview");
  expect(fetcher.mock.calls[2]![1].body).toBe(file);
  await click("Import 21 products");
  expect(fetcher.mock.calls[3]![1].headers).toMatchObject({
    "x-workbook-sha256": next.workbookSha256,
    "x-workbook-header-sha256": next.headerContractSha256,
  });
});
it("shows inferred source time only in collapsed details without requiring a date", async () => {
  await mount(
    vi.fn().mockResolvedValue(
      json({
        ...preview(),
        inferredExportTime: {
          value: "2026-05-21T15:50",
          source: "filename",
          timeZone: null,
        },
      }),
    ),
  );
  await select();
  const details = [...container.querySelectorAll("details")].find(
    (d) => d.querySelector("summary")?.textContent === "Source details",
  )!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain(
    "inferred from filename; timezone unknown, unverified",
  );
  expect(container.querySelector("input[type=datetime-local]")).toBeNull();
  expect(button("Import 21 products").disabled).toBe(false);
});

it("keeps one import action before the sample and collapses detailed issues while showing exact totals", async () => {
  const data = {
    ...preview(),
    totalIssues: 48,
    issues: Array.from({ length: 48 }, (_, i) => ({
      code: "sku_missing",
      severity: "error",
      row: i + 3,
      message: "SKU missing",
    })),
  };
  await mount(vi.fn().mockResolvedValue(json(data)));
  await select();
  const action = button("Import 21 products");
  expect(container.querySelectorAll("button.primary-button")).toHaveLength(1);
  expect(
    action.compareDocumentPosition(container.querySelector("table")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const disclosure = [...container.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")?.textContent?.includes("Row issues"),
  )!;
  expect(disclosure).toBeDefined();
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector("summary")?.textContent).toContain("48");
  expect(disclosure.querySelector("summary")?.textContent).toContain(
    "1 excluded",
  );
  expect(disclosure.querySelectorAll("li")).toHaveLength(48);
  expect(action.previousElementSibling?.textContent).toContain("48 issues");
});
it("automatically opens blocking reasons when no products are eligible", async () => {
  await mount(
    vi.fn().mockResolvedValue(
      json({
        ...preview("Blocked", 0),
        products: [],
        totalRows: 1,
        excludedRows: 1,
      }),
    ),
  );
  await select();
  const disclosure = [...container.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")?.textContent?.includes("Row issues"),
  )!;
  expect(disclosure).toBeDefined();
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain("Variant rows unsupported");
  expect(button("Import 0 products").disabled).toBe(true);
});
