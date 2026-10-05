import { expect, it } from "vitest";
import { exportErrorLabel } from "./export-ui-copy";
it("gives current-preview and latest-receipt remedies without server details", () => {
  expect(exportErrorLabel("export_preview_changed", "en")).toContain(
    "Preview the current listings and fields again",
  );
  expect(exportErrorLabel("repair_result_changed", "en")).toContain(
    "compare the latest reports",
  );
});
