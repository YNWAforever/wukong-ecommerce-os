import { describe, expect, it } from "vitest";

import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items.js";

describe("SHELL_NAV_ITEMS", () => {
  it("has exactly the 9 routes that exist on this branch, in order", () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/catalog",
      "/queue",
      "/listings/new",
      "/listings/import",
      "/batches",
      "/jobs",
      "/system-map",
      "/quality",
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
