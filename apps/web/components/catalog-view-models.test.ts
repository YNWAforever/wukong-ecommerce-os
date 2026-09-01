import { describe, expect, it } from "vitest";

import { catalogStatusLabel } from "./catalog-view-models.js";

describe("catalog view models", () => {
  it("labels products without a Wukong draft explicitly", () => {
    expect(catalogStatusLabel(null)).toBe("未建立草稿 No draft");
  });
});
