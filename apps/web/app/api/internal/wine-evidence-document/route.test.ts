import { describe, expect, it, vi } from "vitest";
import { signQueueRequest, WINE_DOCUMENT_PATH } from "@wukong/jobs";
import { createWineEvidenceDocumentPost } from "./route";

const secret = "synthetic-route-secret";
const seconds = 1_700_000_000;
const payload = {
  workspaceId: "route-unit",
  runId: "10000000-0000-4000-8000-000000000001",
  sourceId: "20000000-0000-4000-8000-000000000001",
  inputRevision: 0,
  kind: "product" as const,
};

async function signedRequest(
  body = JSON.stringify(payload),
  timestamp = seconds,
) {
  return new Request(`https://app.example${WINE_DOCUMENT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wukong-timestamp": String(timestamp),
      "x-wukong-signature": await signQueueRequest({
        secret,
        timestamp,
        path: WINE_DOCUMENT_PATH,
        body,
      }),
    },
    body,
  });
}

function fixture() {
  const getDatabase = vi.fn(() => {
    throw new Error("database must remain lazy for rejected requests");
  });
  return {
    getDatabase,
    post: createWineEvidenceDocumentPost({
      getDatabase,
      secret: () => secret,
      now: () => new Date(seconds * 1000),
    }),
  };
}

describe("wine evidence document POST route", () => {
  it("rejects a missing signature before resolving the database", async () => {
    const f = fixture();
    const request = await signedRequest();
    request.headers.delete("x-wukong-signature");
    const response = await f.post(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "unauthorized",
      message: "Invalid internal authorization.",
    });
    expect(f.getDatabase).not.toHaveBeenCalled();
  });

  it("rejects an expired signature before resolving the database", async () => {
    const f = fixture();
    const response = await f.post(
      await signedRequest(undefined, seconds - 301),
    );
    expect(response.status).toBe(401);
    expect(f.getDatabase).not.toHaveBeenCalled();
  });

  it("rejects a body mutated after signing without leaking its contents", async () => {
    const f = fixture();
    const signed = await signedRequest();
    const mutated = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({
        ...payload,
        sourceId: "private-source-token",
        url: "https://127.0.0.1/private",
      }),
    });
    const response = await f.post(mutated);
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(
      "private-source-token",
    );
    expect(
      JSON.stringify(await f.post(await signedRequest("{"))),
    ).not.toContain("SyntaxError");
    expect(f.getDatabase).not.toHaveBeenCalled();
  });
});
