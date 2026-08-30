import { describe, expect, it, vi } from "vitest";

import {
  MAX_BULK_IMPORT_BYTES,
  submitBulkImport,
  validateBulkImportFile,
} from "./bulk-import-panel.js";

function xlsxFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("validateBulkImportFile", () => {
  it("rejects a file that is not .xlsx", () => {
    const file = xlsxFile("catalog.csv", 100);
    expect(validateBulkImportFile(file)).toBe(
      "Choose an .xlsx SHOPLINE Bulk Update workbook.",
    );
  });

  it("rejects a file over the 4 MiB runtime limit", () => {
    const file = xlsxFile("catalog.xlsx", MAX_BULK_IMPORT_BYTES + 1);
    expect(validateBulkImportFile(file)).toBe(
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
    const result = await submitBulkImport(xlsxFile("catalog.csv", 100), {
      fetcher,
    });
    expect(result).toEqual({
      kind: "validation_error",
      message: "Choose an .xlsx SHOPLINE Bulk Update workbook.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a validation_error without calling the fetcher for an oversized file", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await submitBulkImport(
      xlsxFile("catalog.xlsx", MAX_BULK_IMPORT_BYTES + 1),
      { fetcher },
    );
    expect(result).toEqual({
      kind: "validation_error",
      message: "Workbook exceeds the 4 MiB runtime limit.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await submitBulkImport(xlsxFile("catalog.xlsx", 100), {
      fetcher,
    });
    expect(result).toEqual({
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
    const result = await submitBulkImport(xlsxFile("catalog.xlsx", 100), {
      fetcher,
    });
    expect(result).toEqual({
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
      "/api/listings/import",
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
    const result = await submitBulkImport(xlsxFile("catalog.xlsx", 100), {
      fetcher,
    });
    expect(result).toEqual({ kind: "api_error", code, message });
  });
});
