import { describe, expect, it } from "vitest";

import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items.js";

describe("SHELL_NAV_ITEMS", () => {
  it("keeps the primary workflow and all existing tools in the approved order", () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/catalog",
      "/listings/import",
      "/jobs?kind=export",
      "/queue",
      "/batches",
      "/listings/new",
      "/jobs",
      "/quality",
      "/system-map",
    ]);
  });
});

describe("ROLE_LABELS", () => {
  it("has a bilingual label for every WorkspaceRole", () => {
    for (const role of [
      "viewer",
      "operator",
      "reviewer",
      "admin",
      "owner",
    ] as const) {
      expect(ROLE_LABELS[role].zh).toBeTruthy();
      expect(ROLE_LABELS[role].en).toBeTruthy();
    }
  });
});
