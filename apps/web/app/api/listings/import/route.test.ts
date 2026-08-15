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
    importBulkForm: async () => okResult,
    ...overrides,
  });
}

// `BodyInit` only accepts a view over a real ArrayBuffer, not `ArrayBufferLike`.
const requestWith = (body: Uint8Array<ArrayBuffer>) =>
  new Request("http://localhost/api/listings/import", { method: "POST", body });

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
});
