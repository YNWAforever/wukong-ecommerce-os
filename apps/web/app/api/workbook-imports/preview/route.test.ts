import { describe, expect, it, vi } from "vitest";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import { createWorkbookPreviewHandler } from "./route";
import { createWorkbookParser } from "../../../../lib/workbook-import";
const bytes = () =>
  writeBulkFormWorkbook([
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
    BULK_FORM_COLUMNS.map((c) =>
      c.key === "productId" ? "001" : c.key === "sku" ? "0002" : "",
    ),
  ]);
const request = () =>
  new Request(
    "https://app.test/api/workbook-imports/preview?filename=synthetic.xlsx&workspaceId=foreign&freshnessAttested=true",
    { method: "POST", body: new Uint8Array(bytes()) },
  );
describe("workbook preview route", () => {
  it("previews real XLSX without a connection and without a persistence dependency", async () => {
    const handler = createWorkbookPreviewHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "ws",
          actorId: "op",
          role: "operator",
        }),
      },
      parseWorkbook: createWorkbookParser(),
    });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.eligibleProducts).toBe(1);
    expect(body).not.toHaveProperty("freshnessAttested");
    expect(body.products[0]).not.toHaveProperty("raw");
  });
  it.each([null, "viewer"] as const)(
    "authorizes before parsing %s",
    async (role) => {
      const parseWorkbook = vi.fn();
      const handler = createWorkbookPreviewHandler({
        sessionContext: {
          resolve: async () =>
            role ? { workspaceId: "ws", actorId: "op", role } : null,
        },
        parseWorkbook,
      });
      const response = await handler(request());
      expect(response.status).toBe(role ? 403 : 401);
      expect(parseWorkbook).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
});
