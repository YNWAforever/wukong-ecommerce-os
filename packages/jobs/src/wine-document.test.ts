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
import { wineDocumentResultSchema } from "./wine-document.js";
const result = {
  ...request,
  schemaVersion: 1,
  state: "ready",
  url: "https://example.test/wine",
  capturedAt: new Date().toISOString(),
  title: "wine",
  text: "abc",
  documentDigest: "sha256:" + "a".repeat(64),
  truncated: false,
  spans: [{ start: 0, end: 3, location: "body:text" }],
  warnings: [],
  extractEligible: false,
};
describe("wine document result content boundary", () => {
  it.each([{ state: "denied" }, { state: "unavailable" }, { kind: "robots" }])(
    "rejects retained text or spans %j",
    (change) => {
      expect(
        wineDocumentResultSchema.safeParse({ ...result, ...change }).success,
      ).toBe(false);
    },
  );
  it("accepts an empty denied terminal result", () =>
    expect(
      wineDocumentResultSchema.safeParse({
        ...result,
        state: "denied",
        text: "",
        spans: [],
      }).success,
    ).toBe(true));
});
