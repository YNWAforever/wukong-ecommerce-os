// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { localized, type BilingualMessage } from "../lib/ui-copy.js";
import {
  BulkImportPanel,
  MAX_BULK_IMPORT_BYTES,
  submitBulkImport,
  type BulkImportOutcome,
  validateBulkImportFile,
} from "./bulk-import-panel.js";

/**
 * The outcome as an English reader sees it.
 *
 * Every failure message is a `[zh, en]` pair now, so the cases below would
 * otherwise have to restate both halves to assert one sentence. A separate
 * case checks that the pair really does hold two languages.
 */
function inEnglish(outcome: BulkImportOutcome) {
  return outcome.kind === "success"
    ? outcome
    : { ...outcome, message: localized("en", ...outcome.message) };
}

const englishOf = (message: BilingualMessage | null) =>
  message === null ? null : localized("en", ...message);

function xlsxFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("validateBulkImportFile", () => {
  it("rejects a file that is not .xlsx", () => {
    const file = xlsxFile("catalog.csv", 100);
    expect(englishOf(validateBulkImportFile(file))).toBe(
      "Choose an .xlsx SHOPLINE Bulk Update workbook.",
    );
  });

  it("rejects a file over the 4 MiB runtime limit", () => {
    const file = xlsxFile("catalog.xlsx", MAX_BULK_IMPORT_BYTES + 1);
    expect(englishOf(validateBulkImportFile(file))).toBe(
      "Workbook exceeds the 4 MiB runtime limit.",
    );
  });

  it("accepts a valid .xlsx file within the size limit", () => {
    const file = xlsxFile("catalog.xlsx", 1024);
    expect(validateBulkImportFile(file)).toBeNull();
  });
});

describe("submitBulkImport", () => {
  it("returns a validation_error without calling the fetcher for a bad extension", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await submitBulkImport(
      xlsxFile("catalog.csv", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "validation_error",
      message: "Choose an .xlsx SHOPLINE Bulk Update workbook.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a validation_error without calling the fetcher for an oversized file", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", MAX_BULK_IMPORT_BYTES + 1),
      "2026-08-01T08:00",
      { fetcher },
    );
    expect(inEnglish(result)).toEqual({
      kind: "validation_error",
      message: "Workbook exceeds the 4 MiB runtime limit.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a network_error when the response body is not valid JSON", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html>gateway timeout</html>", { status: 504 }),
      );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          specVersion: "opak-2026-05",
          parsedRows: 2,
          createdDrafts: 2,
          refreshedProducts: 0,
          issues: [
            {
              code: "quantity_negative",
              severity: "warning",
              row: 3,
              column: "quantity",
              value: "-1",
              message: "Stock cannot be negative; clamped to 0.",
            },
          ],
        },
        { status: 201 },
      ),
    );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "success",
      specVersion: "opak-2026-05",
      parsedRows: 2,
      createdDrafts: 2,
      refreshedProducts: 0,
      issues: [
        {
          code: "quantity_negative",
          severity: "warning",
          row: 3,
          column: "quantity",
          value: "-1",
          message: "Stock cannot be negative; clamped to 0.",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/listings/import?merchantAttestedExportAt=2026-08-01T00%3A00%3A00.000Z&filename=catalog.xlsx",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["empty_upload", "Attach a SHOPLINE bulk update form."],
    ["upload_too_large", "The bulk update form is too large."],
    ["upload_not_a_workbook", "The upload is not a readable xlsx workbook."],
    [
      "bulk_form_unreadable",
      "No product rows could be read from this bulk update form.",
    ],
    [
      "bulk_form_too_many_rows",
      "This form holds too many products for one import.",
    ],
    [
      "shopline_connection_missing",
      "Connect a SHOPLINE store before importing a catalog.",
    ],
    ["insufficient_role", "Operator access is required."],
  ])("maps API error code %s to its message", async (code, message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status: 400 }),
      );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({ kind: "api_error", code, message });
  });

  it("falls back to the server's message for an unrecognized error code", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "some_future_code", message: "server-provided detail" },
          { status: 400 },
        ),
      );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "api_error",
      code: "some_future_code",
      message: "server-provided detail",
    });
  });

  it("falls back to unknown_error when the response has no code", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ message: "server-provided detail" }, { status: 500 }),
      );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "api_error",
      code: "unknown_error",
      message: "server-provided detail",
    });
  });

  it("falls back to a generic message when the response has neither a known code nor a message", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}, { status: 500 }));
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      {
        fetcher,
      },
    );
    expect(inEnglish(result)).toEqual({
      kind: "api_error",
      code: "unknown_error",
      message: "The import failed.",
    });
  });
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("bilingual failure copy", () => {
  /**
   * The acceptance criterion for this surface: the toggle changes every
   * string. A message this panel writes itself must therefore hold two
   * languages, not one sentence repeated -- which is exactly what an
   * English-only table looked like to a reader who chose Chinese.
   */
  it("gives its own failures a real translation, not the same sentence twice", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "shopline_connection_missing" }, { status: 409 }),
      );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      { fetcher },
    );

    expect(result.kind).toBe("api_error");
    const [zh, en] = (result as { message: BilingualMessage }).message;
    expect(zh).not.toBe(en);
    expect(zh).toMatch(/[一-鿿]/);
    expect(en).not.toMatch(/[一-鿿]/);
  });

  it("repeats a server-written message rather than inventing a translation", async () => {
    // batch-list.tsx:87 takes the same position: text we did not write is
    // shown as it stands, because translating it here would be invention.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "some_future_code", message: "server-provided detail" },
          { status: 400 },
        ),
      );
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", 100),
      "2026-08-01T08:00",
      { fetcher },
    );

    const [zh, en] = (result as { message: BilingualMessage }).message;
    expect([zh, en]).toEqual([
      "server-provided detail",
      "server-provided detail",
    ]);
  });
});

describe("BulkImportPanel", () => {
  it("renders the real parsed/created/refreshed counts after a successful import", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          specVersion: "opak-2026-05",
          parsedRows: 2,
          createdDrafts: 2,
          refreshedProducts: 0,
          issues: [],
        },
        { status: 201 },
      ),
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
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(BulkImportPanel));
    });

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [xlsxFile("catalog.xlsx", 100)],
    });
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const timeInput = container.querySelector<HTMLInputElement>(
      "#merchant-attested-export-at",
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(timeInput, "2026-08-01T08:00");
    await act(async () => {
      timeInput.dispatchEvent(new Event("input", { bubbles: true }));
      timeInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
