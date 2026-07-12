import { describe, expect, it } from "vitest";

import { assertAssetKey, createAssetKey } from "./asset-store.js";

const prefix = "ws/ws_opak/sources/00000000-0000-4000-8000-000000000001/";

describe("canonical asset key file names", () => {
  it.each([
    ["reserved dot", "."],
    ["spaces", "supplier sheet.pdf"],
    ["percent encoding", "supplier%20sheet.pdf"],
    ["non-canonical punctuation", "supplier?.pdf"],
  ])("rejects %s", (_label, fileName) => {
    expect(() => assertAssetKey("ws_opak", `${prefix}${fileName}`)).toThrow(
      /asset key/i,
    );
  });

  it("accepts the canonical safe file name emitted by key creation", () => {
    const key = createAssetKey({
      workspaceId: "ws_opak",
      fileName: "supplier sheet.pdf",
      mimeType: "application/pdf",
      size: 1,
    });

    expect(() => assertAssetKey("ws_opak", key)).not.toThrow();
    expect(key).toMatch(/\/supplier-sheet\.pdf$/);
  });
});
