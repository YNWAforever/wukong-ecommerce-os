import { describe, expect, it, vi } from "vitest";

import { createForgotPasswordHandler } from "./forgot-password/route";
import { createMagicLinkHandler } from "./magic-link/route";
import { createPasswordHandler } from "./password/route";
import { createRegisterHandler } from "./register/route";

function request(path: string, body: unknown) {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function flow() {
  return {
    requestEnrollment: vi.fn().mockResolvedValue({ accepted: true }),
    passwordSignIn: vi.fn().mockResolvedValue({ ok: false, cookies: [] }),
    requestMagicLink: vi.fn().mockResolvedValue({ accepted: true }),
    requestPasswordReset: vi.fn().mockResolvedValue({ accepted: true }),
  };
}

describe("invite-aware auth routes", () => {
  it("returns one generic validation result without secret or account fields", async () => {
    const deps = flow();
    const handlers = [
      [createRegisterHandler(deps), "/api/auth/register", { email: "admin@example.com", password: "must-not-be-accepted" }],
      [createMagicLinkHandler(deps), "/api/auth/magic-link", { email: "admin@example.com", callbackURL: "/dashboard", token: "raw-token" }],
      [createForgotPasswordHandler(deps), "/api/auth/forgot-password", { email: "admin@example.com", hash: "secret-hash" }],
    ] as const;
    for (const [handler, path, body] of handlers) {
      const response = await handler(request(path, body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, message: "Unable to complete this request." });
    }
  });

  it("preserves safe callbacks and sanitizes unsafe callbacks before auth flows", async () => {
    const deps = flow();
    await createRegisterHandler(deps)(
      request("/api/auth/register", { email: "admin@example.com", callbackURL: "/listings?view=mine" }),
    );
    await createMagicLinkHandler(deps)(
      request("/api/auth/magic-link", { email: "admin@example.com", callbackURL: "//evil.example" }),
    );
    await createForgotPasswordHandler(deps)(
      request("/api/auth/forgot-password", { email: "admin@example.com", callbackURL: "https://evil.example" }),
    );
    expect(deps.requestEnrollment).toHaveBeenCalledWith({
      email: "admin@example.com", callbackURL: "/listings?view=mine",
    });
    expect(deps.requestMagicLink).toHaveBeenCalledWith({
      email: "admin@example.com", callbackURL: "/dashboard",
    });
    expect(deps.requestPasswordReset).toHaveBeenCalledWith({
      email: "admin@example.com", callbackURL: "/dashboard",
    });
  });

  it("forwards all successful password cookies", async () => {
    const deps = flow();
    deps.passwordSignIn.mockResolvedValue({
      ok: true, cookies: ["session=one; Path=/", "csrf=two; Path=/"],
    });
    const response = await createPasswordHandler(deps)(
      request("/api/auth/password", {
        email: "admin@example.com", password: "correct horse battery staple", callbackURL: "/dashboard",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(["session=one; Path=/", "csrf=two; Path=/"]);
    expect(await response.json()).toEqual({ ok: true, message: "Authentication completed." });
  });

  it("maps password-policy failures to one public response", async () => {
    const deps = flow();
    const response = await createPasswordHandler(deps)(
      request("/api/auth/password", { email: "admin@example.com", password: "short" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, message: "Unable to complete this request." });
  });
});
