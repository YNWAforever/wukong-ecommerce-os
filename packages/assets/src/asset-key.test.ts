import { expect, it } from "vitest";

import { assertAssetKey } from "./asset-store.js";

it("rejects an owned key whose source segment is not a UUID", () => {
  expect(() =>
    assertAssetKey("ws_opak", "ws/ws_opak/sources/not-a-uuid/file.pdf"),
  ).toThrow(/asset key/i);
});
