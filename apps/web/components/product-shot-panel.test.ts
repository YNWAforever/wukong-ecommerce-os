import { describe, expect, it } from "vitest";

import { backgroundStyleFor } from "./product-shot-panel.js";

describe("backgroundStyleFor", () => {
  it("returns white for the white choice regardless of brand color", () => {
    expect(backgroundStyleFor("white", "#112233")).toEqual({
      backgroundColor: "#ffffff",
    });
  });

  it("returns the brand color for the brand choice", () => {
    expect(backgroundStyleFor("brand", "#112233")).toEqual({
      backgroundColor: "#112233",
    });
  });

  it("falls back to white for the brand choice when no brand color is configured", () => {
    expect(backgroundStyleFor("brand", null)).toEqual({
      backgroundColor: "#ffffff",
    });
  });
});
