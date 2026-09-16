import { describe, expect, it } from "vitest";
import { wineDocumentRequestSchema } from "./wine-document.js";
const request = {
  workspaceId: "ws",
  runId: "10000000-0000-4000-8000-000000000001",
  sourceId: "20000000-0000-4000-8000-000000000001",
  inputRevision: 2,
  kind: "product",
};
describe("wine document request", () => {
  it("accepts only persisted source coordinates", () =>
    expect(wineDocumentRequestSchema.parse(request)).toEqual(request));
  it.each([
    { url: "https://evil.example" },
    { inputRevision: -1 },
    { kind: "extract" },
    { sourceId: "bad" },
  ])("rejects invalid coordinates %j", (change) =>
    expect(
      wineDocumentRequestSchema.safeParse({ ...request, ...change }).success,
    ).toBe(false),
  );
});
