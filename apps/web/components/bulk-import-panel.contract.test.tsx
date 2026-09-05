// @vitest-environment happy-dom
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import {
  readBulkFormSheet,
  readBulkFormSheetName,
  writeBulkFormWorkbook,
} from "@wukong/shopline/bulk-form-xlsx";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createBulkFormImportHandler } from "../app/api/listings/import/route.js";
import type { BulkFormImportInput } from "../lib/bulk-form-import.js";
import {
  BulkImportPanel,
  merchantExportTimeToIso,
  submitBulkImport,
} from "./bulk-import-panel.js";

const workbook = () =>
  writeBulkFormWorkbook([
    BULK_FORM_COLUMNS.map((column) => column.en),
    BULK_FORM_COLUMNS.map((column) => column.zh),
    BULK_FORM_COLUMNS.map((column) =>
      column.key === "productId"
        ? "product-1"
        : column.key === "sku"
          ? "0001"
          : "",
    ),
  ]);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("browser import contract", () => {
  it.each([
    ["2026-01-01T00:30", "2025-12-31T16:30:00.000Z"],
    ["2026-08-02T03:15", "2026-08-01T19:15:00.000Z"],
  ])(
    "converts fixed Hong Kong time %s across date boundaries",
    (value, iso) => {
      expect(merchantExportTimeToIso(value)).toBe(iso);
    },
  );

  it.each(["", "2026-02-29T12:00", "2026-13-01T00:00", "2026-01-01T24:00"])(
    "strictly rejects invalid calendar time %j",
    (value) => expect(merchantExportTimeToIso(value)).toBeNull(),
  );

  it("emits a request accepted by the real workbook readers and route contract", async () => {
    const bytes = workbook();
    const file = new File(
      [bytes.slice().buffer as ArrayBuffer],
      "香港 +新品?#.xlsx",
    );
    const imported = vi.fn(async (_input: BulkFormImportInput) => ({
      specVersion: "opak-2026-05" as const,
      parsedRows: 1,
      createdDrafts: 1,
      refreshedProducts: 0,
      issues: [],
    }));
    const handler = createBulkFormImportHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_1",
            actorId: "user_1",
            role: "operator" as const,
          };
        },
      },
      readSheet: readBulkFormSheet,
      readSheetName: readBulkFormSheetName,
      importBulkForm: imported,
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) =>
      handler(new Request(new URL(String(input), "http://localhost"), init)),
    );
    const result = await submitBulkImport(file, "2026-01-01T00:30", {
      fetcher,
    });
    expect(result.kind).toBe("success");
    const url = new URL(String(fetcher.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("merchantAttestedExportAt")).toBe(
      "2025-12-31T16:30:00.000Z",
    );
    expect(url.searchParams.get("filename")).toBe("香港 +新品?#.xlsx");
    expect(imported.mock.calls[0]![0].sheetName).toBe("Default");
    expect(imported.mock.calls[0]![0].rawBytes).toEqual(bytes);
  });

  it("does not upload on selection, preserves retry inputs, and blocks duplicate in-flight submits", async () => {
    let reject!: (reason: unknown) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({
        connection: { shopDomain: "synthetic.myshopline.com" },
        canImport: true,
        canManageConnection: false,
        credentialStorageConfigured: true,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(BulkImportPanel)));
    const fileInput =
      container.querySelector<HTMLInputElement>("#bulk-import-file")!;
    const timeInput = container.querySelector<HTMLInputElement>(
      "#merchant-attested-export-at",
    )!;
    const form = container.querySelector<HTMLFormElement>("form")!;
    const file = new File(
      [workbook().slice().buffer as ArrayBuffer],
      "retry.xlsx",
    );
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(timeInput, "2026-08-01T08:00");
      timeInput.dispatchEvent(new Event("input", { bubbles: true }));
      timeInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/workspace/import-setup");
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      reject(new TypeError("offline"));
      await Promise.resolve();
    });
    expect(fileInput.files?.[0]).toBe(file);
    expect(timeInput.value).toBe("2026-08-01T08:00");
    expect(container.textContent).toContain("Could not reach the server");
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
});
