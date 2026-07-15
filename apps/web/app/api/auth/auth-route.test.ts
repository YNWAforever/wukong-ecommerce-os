import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./[...all]/route.js";

describe("Better Auth route safety", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns a controlled unavailable response without auth secrets", async () => {
    vi.stubEnv("AUTH_SMTP_URL", "");
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("DATABASE_URL", "");
    const response = await GET(
      new Request("http://localhost/api/auth/session"),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "authentication_unavailable",
      message: "Authentication is not configured.",
    });
  });

  it("does not expose a database or SMTP error from POST", async () => {
    vi.stubEnv("AUTH_SMTP_URL", "");
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("DATABASE_URL", "");
    const response = await POST(
      new Request("http://localhost/api/auth/signin", { method: "POST" }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("DATABASE_URL");
  });
  it("blocks raw initiation endpoints while leaving reset completion on Better Auth", async () => {
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/sign-in/magic-link",
      "/api/auth/request-password-reset",
    ]) {
      const response = await POST(
        new Request("http://localhost" + path, { method: "POST" }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "not_found",
        message: "Unable to complete this request.",
      });
    }
    const completion = await POST(
      new Request("http://localhost/api/auth/reset-password", { method: "POST" }),
    );
    expect(completion.status).toBe(503);
  });
});
