import { describe, expect, it } from "vitest";

import {
  assertAssetKey,
  assertExportAssetKey,
  createExportAssetKey,
} from "./asset-store.js";

it("rejects an owned key whose source segment is not a UUID", () => {
  expect(() =>
    assertAssetKey("ws_opak", "ws/ws_opak/sources/not-a-uuid/file.pdf"),
  ).toThrow(/asset key/i);
});

describe("createExportAssetKey / assertExportAssetKey", () => {
  it("creates a key scoped to the workspace and export attempt id", () => {
    const key = createExportAssetKey({
      workspaceId: "ws_1",
      exportAttemptId: "11111111-1111-4111-8111-111111111111",
      fileName: "export-11111111.xlsx",
    });
    expect(key).toBe(
      "ws/ws_1/exports/11111111-1111-4111-8111-111111111111/export-11111111.xlsx",
    );
  });

  it("rejects a key belonging to a different workspace", () => {
    const key = createExportAssetKey({
      workspaceId: "ws_1",
      exportAttemptId: "11111111-1111-4111-8111-111111111111",
      fileName: "export.xlsx",
    });
    expect(() => assertExportAssetKey("ws_2", key)).toThrow();
  });

  it("rejects a sources/ key when asserting an export key, and vice versa", () => {
    const exportKey = createExportAssetKey({
      workspaceId: "ws_1",
      exportAttemptId: "11111111-1111-4111-8111-111111111111",
      fileName: "export.xlsx",
    });
    // The two namespaces validate independently in both directions.
    expect(() => assertAssetKey("ws_1", exportKey)).toThrow();
    expect(() =>
      assertExportAssetKey(
        "ws_1",
        "ws/ws_1/sources/11111111-1111-4111-8111-111111111111/file.pdf",
      ),
    ).toThrow();
  });
});
