import type { WorkbenchItem } from "@wukong/db";
import { describe, expect, it } from "vitest";

import { workbenchDestination } from "./workbench-actions.js";

function item(kind: WorkbenchItem["kind"], id: string): WorkbenchItem {
  return {
    key: `${kind}:${id}`,
    id,
    kind,
    state: "attention",
    reason: "failed",
    title: null,
    sourceLabel: null,
    productCount: null,
    occurredAt: "2026-09-06T00:00:00.000Z",
    timestampKind: "updated",
  };
}

describe("workbenchDestination", () => {
  it.each([
    ["listing", "listing/with spaces", "/listings/listing%2Fwith%20spaces"],
    [
      "export",
      "attempt&next=https://evil.example",
      "/jobs?kind=export&attempt=attempt%26next%3Dhttps%3A%2F%2Fevil.example",
    ],
    ["website_scan", "scan#fragment", "/listings/import?scan=scan%23fragment"],
    [
      "workbook_import",
      "import?filter=all",
      "/catalog?filter=workbook&importId=import%3Ffilter%3Dall",
    ],
  ] as const)(
    "maps %s to an encoded internal destination",
    (kind, id, expected) => {
      expect(workbenchDestination(item(kind, id))).toBe(expected);
    },
  );
});
