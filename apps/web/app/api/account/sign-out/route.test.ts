import { expect, it, vi } from "vitest";
import { createAccountSignOutHandler } from "./route";
function request() {
  return new Request("http://localhost/api/account/sign-out", {
    method: "POST",
    headers: {
      cookie: "synthetic-cookie",
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: "{}",
  });
}
it("forwards success only after the original session has actually disappeared", async () => {
  const revoke = vi.fn(
    async (_request: Request) =>
      new Response('{"success":true}', {
        headers: { "set-cookie": "synthetic-expired" },
      }),
  );
  const hasSession = vi.fn(async (_headers: Headers) => false);
  const response = await createAccountSignOutHandler({ revoke, hasSession })(
    request(),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBe("synthetic-expired");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(hasSession).toHaveBeenCalledWith(expect.any(Headers));
  expect(hasSession.mock.calls[0]?.[0].get("cookie")).toBe("synthetic-cookie");
  const forwarded = revoke.mock.calls[0]![0];
  expect(new URL(forwarded.url).pathname).toBe("/api/auth/sign-out");
  expect(forwarded.headers.get("origin")).toBe("http://localhost");
});
it("rejects apparent Better Auth success when server deletion silently failed", async () => {
  const response = await createAccountSignOutHandler({
    revoke: async () =>
      new Response('{"success":true}', {
        headers: { "set-cookie": "synthetic-expired" },
      }),
    hasSession: async () => true,
  })(request());
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toMatchObject({ code: "sign_out_not_revoked" });
});
it("preserves Better Auth CSRF rejection and never attempts to bypass it", async () => {
  const hasSession = vi.fn(async (_headers: Headers) => false);
  const response = await createAccountSignOutHandler({
    revoke: async () => new Response(null, { status: 403 }),
    hasSession,
  })(request());
  expect(response.status).toBe(403);
  expect(hasSession).not.toHaveBeenCalled();
});
