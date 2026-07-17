import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "./middleware";

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`https://wukong.test${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("authentication middleware", () => {
  it.each([
    "/signin",
    "/signin/magic-link",
    "/register",
    "/register/invitation",
    "/forgot-password",
    "/reset-password",
  ])("allows public page route %s without a session cookie", (path) => {
    const response = middleware(request(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "/api/auth",
    "/api/auth/sign-in/email",
    "/api/auth/reset-password/token-1",
  ])("allows Better Auth route %s without a session cookie", (path) => {
    const response = middleware(request(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "better-auth.session_token=opaque",
    "__Secure-better-auth.session_token=opaque",
  ])("allows protected page navigation with cookie %s", (cookie) => {
    const response = middleware(request("/listings/listing-1?tab=review", cookie));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects a protected page without a cookie and preserves path and query", () => {
    const response = middleware(request("/listings/listing-1?tab=review&from=queue"));

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.origin).toBe("https://wukong.test");
    expect(redirect.pathname).toBe("/signin");
    expect(redirect.searchParams.get("callbackUrl")).toBe(
      "/listings/listing-1?tab=review&from=queue",
    );
  });

  it("does not copy request cookies into the redirect", () => {
    const response = middleware(
      request("/listings", "unrelated-secret=do-not-leak"),
    );

    const location = response.headers.get("location") ?? "";
    expect(location).not.toContain("unrelated-secret");
    expect(location).not.toContain("do-not-leak");
    expect(response.headers.get("cookie")).toBeNull();
  });
});
