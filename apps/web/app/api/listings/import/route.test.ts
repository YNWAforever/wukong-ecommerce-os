import { describe, expect, it } from "vitest";

import { createBulkFormImportHandler } from "./route.js";

const okResult = {
  specVersion: "opak-2026-05",
  parsedRows: 2,
  createdDrafts: 2,
  refreshedProducts: 0,
  issues: [],
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  overrides: Partial<Parameters<typeof createBulkFormImportHandler>[0]> = {},
) {
  return createBulkFormImportHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    },
    readSheet: () => [["a"]],
    readSheetName: () => "Default",
    importBulkForm: async () => okResult,
    ...overrides,
  });
}

const IMPORT_URL =
  "http://localhost/api/listings/import?merchantAttestedExportAt=2026-08-01T00%3A00%3A00Z&filename=opak-export.xlsx";

// `BodyInit` only accepts a view over a real ArrayBuffer, not `ArrayBufferLike`.
const requestWith = (body: Uint8Array<ArrayBuffer>, url = IMPORT_URL) =>
  new Request(url, { method: "POST", body });

describe("POST /api/listings/import", () => {
  it("imports for an operator and returns the counts", async () => {
    const response = await handlerFor("operator")(
      requestWith(new Uint8Array([1, 2, 3])),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      specVersion: "opak-2026-05",
      parsedRows: 2,
      createdDrafts: 2,
      refreshedProducts: 0,
    });
  });

  it("refuses a viewer without importing anything", async () => {
    // Asserting the status alone would also pass if the role check ran after
    // the import, so the gate is only proven by the importer never being hit.
    let imported = 0;
    const handler = handlerFor("viewer", {
      importBulkForm: async () => {
        imported += 1;
        return okResult;
      },
    });

    const response = await handler(requestWith(new Uint8Array([1])));

    expect(response.status).toBe(403);
    expect(imported).toBe(0);
  });

  it("rejects an upload larger than the cap", async () => {
    let imported = 0;
    const handler = handlerFor("operator", {
      importBulkForm: async () => {
        imported += 1;
        return okResult;
      },
    });

    const response = await handler(
      requestWith(new Uint8Array(4 * 1024 * 1024 + 1)),
    );

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("upload_too_large");
    expect(imported).toBe(0);
  });

  it("rejects an empty upload", async () => {
    const response = await handlerFor("operator")(
      requestWith(new Uint8Array()),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("empty_upload");
  });

  it("rejects an upload that is not a readable workbook", async () => {
    const handler = handlerFor("operator", {
      readSheet: () => {
        throw new Error("file is not a zip container");
      },
    });

    const response = await handler(requestWith(new Uint8Array([9, 9, 9])));

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("upload_not_a_workbook");
  });

  it("caps the number of issues it echoes back", async () => {
    const handler = handlerFor("operator", {
      importBulkForm: async () => ({
        ...okResult,
        issues: Array.from({ length: 250 }, () => ({
          code: "quantity_negative" as const,
          severity: "warning" as const,
          row: 3,
          column: "quantity" as const,
          value: "-1",
          message: "negative stock clamped to 0",
        })),
      }),
    });

    const response = await handler(requestWith(new Uint8Array([1])));

    expect((await response.json()).issues).toHaveLength(100);
  });

  it("rejects a request with no merchantAttestedExportAt", async () => {
    const response = await handlerFor("operator")(
      requestWith(
        new Uint8Array([1]),
        "http://localhost/api/listings/import?filename=opak-export.xlsx",
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(
      "merchant_attested_export_at_missing",
    );
  });

  it("rejects a request with an unparseable merchantAttestedExportAt", async () => {
    const response = await handlerFor("operator")(
      requestWith(
        new Uint8Array([1]),
        "http://localhost/api/listings/import?merchantAttestedExportAt=not-a-date&filename=opak-export.xlsx",
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe(
      "merchant_attested_export_at_invalid",
    );
  });

  it("rejects a request with no filename", async () => {
    const response = await handlerFor("operator")(
      requestWith(
        new Uint8Array([1]),
        "http://localhost/api/listings/import?merchantAttestedExportAt=2026-08-01T00%3A00%3A00Z",
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("filename_missing");
  });

  it("passes the parsed timestamp, filename, and sheet name through to the importer", async () => {
    let received: Record<string, unknown> | undefined;
    const handler = handlerFor("operator", {
      importBulkForm: async (input) => {
        received = input as unknown as Record<string, unknown>;
        return okResult;
      },
    });

    await handler(requestWith(new Uint8Array([1, 2, 3])));

    expect(received?.filename).toBe("opak-export.xlsx");
    expect(received?.sheetName).toBe("Default");
    expect((received?.merchantAttestedExportAt as Date).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(received?.rawBytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
