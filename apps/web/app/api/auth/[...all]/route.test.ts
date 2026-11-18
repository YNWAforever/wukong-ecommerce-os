import { describe, expect, it, vi } from "vitest";

import { AuthConfigurationUnavailableError } from "../../../../auth";
import { createAuthGetHandler } from "./route";

function request(path: string) {
  return new Request(`http://localhost${path}`);
}

function deps(
  overrides: Partial<Parameters<typeof createAuthGetHandler>[0]> = {},
) {
  return {
    configured: () => true,
    standard: vi.fn().mockResolvedValue(new Response("standard")),
    operator: vi.fn().mockResolvedValue(new Response("operator")),
    ...overrides,
  };
}

describe("Better Auth catch-all GET", () => {
  it("returns 503 before touching a handler when auth is not configured", async () => {
    const flow = deps({ configured: () => false });
    const response = await createAuthGetHandler(flow)(request("/signin"));
    expect(response.status).toBe(503);
    expect(flow.standard).not.toHaveBeenCalled();
    expect(flow.operator).not.toHaveBeenCalled();
  });

  it("routes only magic-link verification through the operator instance", async () => {
    const flow = deps();
    const verify = await createAuthGetHandler(flow)(
      request("/api/auth/magic-link/verify?token=synthetic"),
    );
    expect(await verify.text()).toBe("operator");
    expect(flow.standard).not.toHaveBeenCalled();

    const session = await createAuthGetHandler(flow)(
      request("/api/auth/get-session"),
    );
    expect(await session.text()).toBe("standard");
    expect(flow.operator).toHaveBeenCalledTimes(1);
  });

  it("maps a configuration failure to 503 without leaking it", async () => {
    const flow = deps({
      standard: vi
        .fn()
        .mockRejectedValue(new AuthConfigurationUnavailableError()),
    });
    const response = await createAuthGetHandler(flow)(
      request("/api/auth/get-session"),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "authentication_unavailable",
    });
  });
});
