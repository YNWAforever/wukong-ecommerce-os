// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ListingIntakeTabs } from "./listing-intake-tabs";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
vi.mock("./website-import-panel", () => ({
  WebsiteImportPanel: () => createElement("p", null, "Website unchanged"),
}));
const legacy = vi.hoisted(() => vi.fn());
vi.mock("./bulk-import-panel", () => ({
  BulkImportPanel: () => {
    legacy();
    return createElement("p", null, "Connected legacy importer");
  },
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("retains workbook file/preview through keyboard tab changes and lazily opens connected importer", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      totalRows: 1,
      eligibleProducts: 1,
      excludedRows: 0,
      products: [],
      issues: [],
      totalIssues: 0,
      sheetName: "Default",
      inferredExportTime: null,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  legacy.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(ListingIntakeTabs, { canScan: true })),
    );
    expect(container.querySelector("[aria-selected=true]")?.textContent).toBe(
      "Website",
    );
    await act(async () =>
      container
        .querySelector("#intake-tab-website")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
    );
    expect(document.activeElement?.id).toBe("intake-tab-bulk");
    expect(legacy).not.toHaveBeenCalled();
    const file = new File(["original"], "retained.xlsx");
    const input = container.querySelector<HTMLInputElement>(
      "#workbook-import-file",
    )!;
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("#intake-tab-bulk")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        ),
    );
    await act(async () =>
      container
        .querySelector("#intake-tab-website")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
    );
    expect(container.querySelector("#workbook-import-file")).toBe(input);
    expect(input.files?.[0]).toBe(file);
    expect(container.textContent).toContain("Import 1 products");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    const details = container.querySelector<HTMLDetailsElement>(
      "#connected-shopline-update",
    )!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(legacy).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
it("passes viewer capability to the automatic workbook path", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(ListingIntakeTabs, { canScan: false })),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("#intake-tab-bulk")!.click(),
    );
    expect(
      container.querySelector<HTMLInputElement>("#workbook-import-file")
        ?.disabled,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
