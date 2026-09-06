import { describe, expect, it, vi } from "vitest";
import { signQueueRequest, WEBSITE_DOCUMENT_PATH } from "@wukong/jobs";
import { createWebsiteDocumentHandler, runtime } from "./route";
const payload = {
  kind: "website_scan",
  workspaceId: "ws",
  scanId: "10000000-0000-4000-8000-000000000001",
  revision: 0,
  leaseToken: "20000000-0000-4000-8000-000000000001",
};
const secret = "synthetic-internal-test-secret";
const seconds = 1700000000;
async function request(
  body = JSON.stringify(payload),
  path = WEBSITE_DOCUMENT_PATH,
  timestamp = seconds,
) {
  return new Request("https://app.example" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wukong-timestamp": String(timestamp),
      "x-wukong-signature": await signQueueRequest({
        secret,
        timestamp,
        path,
        body,
      }),
    },
    body,
  });
}
describe("internal website document callback", () => {
  it("uses Node and checks exact HMAC before invoking the injected service", async () => {
    const service = vi.fn(async () => ({
      status: "completed",
      result: { checkpoint: { preview: { products: [], warnings: [] } } },
    }));
    const handler = createWebsiteDocumentHandler({
      secret: () => secret,
      now: () => new Date(seconds * 1000),
      service: service as any,
    });
    expect(runtime).toBe("nodejs");
    expect((await handler(await request())).status).toBe(200);
    expect(service).toHaveBeenCalledWith(payload);
    const bad = await request();
    bad.headers.set("x-wukong-signature", "bad");
    expect((await handler(bad)).status).toBe(401);
    expect(
      (
        await handler(
          await request(undefined, WEBSITE_DOCUMENT_PATH, seconds - 301),
        )
      ).status,
    ).toBe(401);
    expect(
      (await handler(await request(undefined, "/api/website-scans"))).status,
    ).toBe(404);
    expect(service).toHaveBeenCalledTimes(1);
  });
  it("rejects URL injection, large bodies and non-JSON before any service call", async () => {
    const service = vi.fn();
    const handler = createWebsiteDocumentHandler({
      secret: () => secret,
      now: () => new Date(seconds * 1000),
      service,
    });
    expect(
      (
        await handler(
          await request(
            JSON.stringify({ ...payload, url: "https://store.example" }),
          ),
        )
      ).status,
    ).toBe(400);
    expect((await handler(await request("x".repeat(4097)))).status).toBe(413);
    const req = await request();
    req.headers.set("content-type", "text/plain");
    expect((await handler(req)).status).toBe(415);
    expect(
      (
        await handler(
          new Request("https://app.example" + WEBSITE_DOCUMENT_PATH),
        )
      ).status,
    ).toBe(405);
    expect(service).not.toHaveBeenCalled();
  });
  it.each([
    ["stale", 409],
    ["in_progress", 202],
    ["completed", 200],
  ])("maps %s without leaking service diagnostics", async (status, code) => {
    const handler = createWebsiteDocumentHandler({
      secret: () => secret,
      now: () => new Date(seconds * 1000),
      service: vi.fn(async () => ({
        status,
        result: {
          state: "failed",
          checkpoint: { preview: { products: [], warnings: [] } },
        },
      })) as any,
    });
    const response = await handler(await request());
    expect(response.status).toBe(code);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
