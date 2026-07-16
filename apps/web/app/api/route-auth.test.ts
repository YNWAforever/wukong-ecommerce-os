import { describe, expect, it } from "vitest";

import {
  POST as failClosedFinalize,
  createFinalizeAssetHandler,
} from "./assets/finalize/route.js";

const request = (cookie?: string) =>
  new Request("http://localhost/api/assets/finalize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({}),
  });

describe("intake route authorization binding", () => {
  it("returns 503 from the default fail-closed binding without reading secrets", async () => {
    const response = await failClosedFinalize(
      request("better-auth.session_token=present-but-invalid"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "authentication_unavailable" });
  });

  it("returns 401 when the configured context has no authenticated session", async () => {
    const handler = createFinalizeAssetHandler({
      sessionContext: { async resolve() { return null; } },
      getAssetStore: () => { throw new Error("must stay lazy"); },
      getDatabase: () => { throw new Error("must stay lazy"); },
    });

    const response = await handler(
      request("__Secure-better-auth.session_token=present-but-invalid"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });
});
