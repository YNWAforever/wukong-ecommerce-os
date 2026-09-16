import { describe, expect, it, vi } from "vitest";
import { signQueueRequest, WINE_DOCUMENT_PATH } from "@wukong/jobs";
import { createWineDocumentHandler } from "./wine-document-handler";
const payload = {
  workspaceId: "ws",
  runId: "10000000-0000-4000-8000-000000000001",
  sourceId: "20000000-0000-4000-8000-000000000001",
  inputRevision: 2,
  kind: "product",
};
const secret = "synthetic-wine-callback-secret",
  seconds = 1700000000;
async function request(
  body = JSON.stringify(payload),
  path = WINE_DOCUMENT_PATH,
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
function fixture() {
  const service = vi.fn(async () => ({ status: "stale" as const }));
  return {
    service,
    handler: createWineDocumentHandler({
      secret: () => secret,
      now: () => new Date(seconds * 1000),
      service,
    }),
  };
}
describe("signed wine document handler", () => {
  it("accepts exact body/path/timestamp signature before calling the service", async () => {
    const f = fixture();
    expect((await f.handler(await request())).status).toBe(409);
    expect(f.service).toHaveBeenCalledWith(payload);
  });
  it("rejects missing signatures", async () => {
    const f = fixture(),
      r = await request();
    r.headers.delete("x-wukong-signature");
    expect((await f.handler(r)).status).toBe(401);
    expect(f.service).not.toHaveBeenCalled();
  });
  it("rejects expired signatures", async () => {
    const f = fixture();
    expect(
      (await f.handler(await request(undefined, undefined, seconds - 301)))
        .status,
    ).toBe(401);
    expect(f.service).not.toHaveBeenCalled();
  });
  it("rejects mutated bodies", async () => {
    const f = fixture(),
      signed = await request();
    const changed = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ ...payload, inputRevision: 3 }),
    });
    expect((await f.handler(changed)).status).toBe(401);
    expect(f.service).not.toHaveBeenCalled();
  });
  it("rejects wrong paths", async () => {
    const f = fixture();
    expect(
      (
        await f.handler(
          await request(undefined, "/api/internal/website-document"),
        )
      ).status,
    ).toBe(404);
    expect(f.service).not.toHaveBeenCalled();
  });
  it("rejects arbitrary URL injection", async () => {
    const f = fixture();
    expect(
      (
        await f.handler(
          await request(
            JSON.stringify({ ...payload, url: "https://127.0.0.1/" }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(f.service).not.toHaveBeenCalled();
  });
  it("bounds bodies before service invocation", async () => {
    const f = fixture();
    expect((await f.handler(await request("x".repeat(4097)))).status).toBe(413);
    expect(f.service).not.toHaveBeenCalled();
  });
});
