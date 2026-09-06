import { describe, expect, it, vi } from "vitest";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import {
  createWorkbookSaveHandler,
  maxDuration,
  type WorkbookSaveRouteDeps,
} from "./route";
import { createWorkbookParser } from "../../../lib/workbook-import";
const bytes = () =>
  writeBulkFormWorkbook([
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
    ...Array.from({ length: 21 }, (_, i) =>
      BULK_FORM_COLUMNS.map((c) =>
        c.key === "productId" ? `00${i}` : c.key === "sku" ? `sku${i}` : "",
      ),
    ),
  ]);
const request = (body: Uint8Array, headers: Record<string, string> = {}) =>
  new Request(
    "https://app.test/api/workbook-imports?filename=synthetic.xlsx&workspaceId=foreign&merchantAttestedExportAt=2026-01-01",
    { method: "POST", body: new Uint8Array(body), headers },
  );
const sessionContext = {
  resolve: async () => ({
    workspaceId: "trusted",
    actorId: "operator",
    role: "operator" as const,
  }),
};
describe("workbook save route", () => {
  it("reparses all 21 original rows and takes identity from session", async () => {
    const body = bytes(),
      parsed = await createWorkbookParser()(request(body));
    const saveWorkbook = vi.fn<WorkbookSaveRouteDeps["saveWorkbook"]>(
      async () => ({
        importId: "import",
        importedProducts: 21,
        alreadyImportedProducts: 0,
        excludedRows: 0,
      }),
    );
    const handler = createWorkbookSaveHandler({
      sessionContext,
      parseWorkbook: createWorkbookParser(),
      saveWorkbook,
    });
    const response = await handler(
      request(body, {
        "x-workbook-sha256": parsed.workbookSha256,
        "x-workbook-header-sha256": parsed.headerContractSha256,
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(maxDuration).toBe(300);
    const input = saveWorkbook.mock.calls[0]![0];
    expect(input).toMatchObject({
      workspaceId: "trusted",
      actorId: "operator",
    });
    expect(input.prepared.products).toHaveLength(21);
    expect(input).not.toHaveProperty("merchantAttestedExportAt");
  });
  it.each(["x-workbook-sha256", "x-workbook-header-sha256"])(
    "rejects mismatched %s",
    async (key) => {
      const body = bytes(),
        parsed = await createWorkbookParser()(request(body)),
        saveWorkbook = vi.fn();
      const response = await createWorkbookSaveHandler({
        sessionContext,
        parseWorkbook: createWorkbookParser(),
        saveWorkbook,
      })(
        request(body, {
          "x-workbook-sha256": parsed.workbookSha256,
          "x-workbook-header-sha256": parsed.headerContractSha256,
          [key]: "0".repeat(64),
        }),
      );
      expect(response.status).toBe(409);
      expect(saveWorkbook).not.toHaveBeenCalled();
    },
  );
  it.each([null, "viewer"] as const)(
    "denies %s before parse/save",
    async (role) => {
      const parseWorkbook = vi.fn(),
        saveWorkbook = vi.fn();
      const response = await createWorkbookSaveHandler({
        sessionContext: {
          resolve: async () =>
            role ? { workspaceId: "trusted", actorId: "v", role } : null,
        },
        parseWorkbook,
        saveWorkbook,
      })(request(bytes()));
      expect(response.status).toBe(role ? 403 : 401);
      expect(parseWorkbook).not.toHaveBeenCalled();
      expect(saveWorkbook).not.toHaveBeenCalled();
    },
  );
  it("rejects JSON pretending to supply products", async () => {
    const saveWorkbook = vi.fn();
    const response = await createWorkbookSaveHandler({
      sessionContext,
      parseWorkbook: createWorkbookParser(),
      saveWorkbook,
    })(
      request(
        new TextEncoder().encode(
          JSON.stringify({ workspaceId: "foreign", products: [{}] }),
        ),
      ),
    );
    expect(response.status).toBe(400);
    expect(saveWorkbook).not.toHaveBeenCalled();
  });
  it("refuses saving a zero eligible preview", async () => {
    const body = writeBulkFormWorkbook([
      BULK_FORM_COLUMNS.map((c) => c.en),
      BULK_FORM_COLUMNS.map((c) => c.zh),
      BULK_FORM_COLUMNS.map((c) => (c.key === "sku" ? "bad" : "")),
    ]);
    const parsed = await createWorkbookParser()(request(body)),
      saveWorkbook = vi.fn();
    const response = await createWorkbookSaveHandler({
      sessionContext,
      parseWorkbook: createWorkbookParser(),
      saveWorkbook,
    })(
      request(body, {
        "x-workbook-sha256": parsed.workbookSha256,
        "x-workbook-header-sha256": parsed.headerContractSha256,
      }),
    );
    expect(response.status).toBe(422);
    expect(saveWorkbook).not.toHaveBeenCalled();
  });
});
