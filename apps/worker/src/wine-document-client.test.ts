import { describe, expect, it } from "vitest";
import { WINE_DOCUMENT_PATH, verifyQueueRequest } from "@wukong/jobs";
import { createWineDocumentClient } from "./wine-document-client.js";
const input = {
  workspaceId: "w",
  runId: "00000000-0000-4000-8000-000000000001",
  sourceId: "00000000-0000-4000-8000-000000000002",
  inputRevision: 0,
  kind: "product" as const,
};
const now = new Date("2026-09-16T00:00:00Z");
const result = {
  ...input,
  schemaVersion: 1,
  state: "ready",
  url: "https://wine.test/product",
  capturedAt: now.toISOString(),
  title: "wine",
  text: "wine",
  documentDigest: "sha256:" + "a".repeat(64),
  truncated: false,
  spans: [{ start: 0, end: 4, location: "body:text" }],
  warnings: [],
  extractEligible: true,
};
describe("signed wine document client", () => {
  it("pins origin and signs exact coordinates without source URL", async () => {
    const client = createWineDocumentClient({
      baseUrl: "https://callback.test",
      secret: "test",
      now: () => now,
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://callback.test" + WINE_DOCUMENT_PATH);
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(
          await verifyQueueRequest({
            secret: "test",
            nowSeconds: now.getTime() / 1000,
            timestamp: headers.get("x-wukong-timestamp")!,
            signature: headers.get("x-wukong-signature")!,
            path: WINE_DOCUMENT_PATH,
            body: String(init?.body),
          }),
        ).toBe(true);
        expect(JSON.parse(String(init?.body))).toEqual(input);
        return Response.json({ status: "completed", result });
      },
    });
    expect(await client(input)).toEqual(result);
  });
  it.each([
    "http://callback.test",
    "https://user:pass@callback.test",
    "https://callback.test/path",
    "https://callback.test?x=1",
  ])("rejects unsafe callback config %s", (baseUrl) => {
    expect(() =>
      createWineDocumentClient({ baseUrl, secret: "test" }),
    ).toThrow();
  });
  it.each([
    { status: "completed", result: { ...result, sourceId: input.runId } },
    { status: "completed", result: { ...result, workspaceId: "foreign" } },
    { status: "completed", result: { ...result, extra: true } },
    { status: "unknown" },
    {},
  ])("rejects malformed or foreign callback binding", async (body) => {
    const client = createWineDocumentClient({
      baseUrl: "https://callback.test",
      secret: "test",
      fetch: async () => Response.json(body),
    });
    await expect(client(input)).rejects.toThrow();
  });
  it("rejects oversized declared and streamed bodies", async () => {
    for (const response of [
      new Response("{}", { headers: { "content-length": "9999999" } }),
      new Response("x".repeat(131073)),
    ]) {
      const client = createWineDocumentClient({
        baseUrl: "https://callback.test",
        secret: "test",
        fetch: async () => response,
      });
      await expect(client(input)).rejects.toThrow();
    }
  });
});
