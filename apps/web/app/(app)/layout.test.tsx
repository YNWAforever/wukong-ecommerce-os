import { describe, expect, it } from "vitest";

import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items.js";

describe("SHELL_NAV_ITEMS", () => {
  it("has exactly the 6 routes that exist on this branch, in the Site's confirmed order", () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/catalog",
      "/queue",
      "/listings/new",
      "/listings/import",
      "/batches",
    ]);
  });

  it("does not include /jobs, /system-map, or /quality", () => {
    const hrefs = SHELL_NAV_ITEMS.map((item) => item.href);
    expect(hrefs).not.toContain("/jobs");
    expect(hrefs).not.toContain("/system-map");
    expect(hrefs).not.toContain("/quality");
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
