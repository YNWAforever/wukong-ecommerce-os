import { describe, expect, it } from "vitest";
import { normalizeWorkbenchReturn, exactQueryId } from "./workbench-navigation";
describe("bounded workbench navigation", () => {
  it.each([
    null,
    "//example.test",
    "https://example.test/dashboard",
    "/dashboard/evil",
    "/dashboard\\evil",
    "/dashboard?" + "x".repeat(2000),
  ])("rejects unsafe return %s", (input) => {
    expect(normalizeWorkbenchReturn(input)).toBe("/dashboard");
  });
  it("normalizes only approved filters", () => {
    expect(normalizeWorkbenchReturn("/dashboard?state=attention&page=2")).toBe(
      "/dashboard?state=attention&page=2",
    );
    expect(
      normalizeWorkbenchReturn(
        "/dashboard?secret=hidden&kind=export&page=0002&state=oops#x",
      ),
    ).toBe("/dashboard?kind=export");
  });
  it("validates IDs without accepting URL syntax", () => {
    expect(exactQueryId("../other")).toBeNull();
    expect(exactQueryId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
