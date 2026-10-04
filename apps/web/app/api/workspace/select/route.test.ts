import { describe, expect, it, vi } from "vitest";

import {
  createSelectWorkspaceHandler,
  configuredWorkspaceOrigin,
} from "./route";

function request(workspaceId: string, origin = "https://app.test") {
  return new Request("https://app.test/api/workspace/select", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ workspaceId }),
  });
}

describe("workspace selection", () => {
  it("sets a private preference cookie for a verified membership", async () => {
    const hasMembership = vi.fn().mockResolvedValue(true);
    const handler = createSelectWorkspaceHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "ws_first",
          actorId: "user_1",
          role: "viewer",
        }),
      },
      hasMembership,
    });

    const response = await handler(request("ws_second"));
    expect(response.status).toBe(200);
    expect(hasMembership).toHaveBeenCalledWith("user_1", "ws_second");
    expect(response.headers.get("set-cookie")).toContain(
      "wukong_workspace=ws_second",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("rejects another user's workspace without setting a cookie", async () => {
    const handler = createSelectWorkspaceHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "ws_first",
          actorId: "user_1",
          role: "viewer",
        }),
      },
      hasMembership: async () => false,
    });

    const response = await handler(request("ws_other"));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a cross-origin request before looking up membership", async () => {
    const hasMembership = vi.fn();
    const handler = createSelectWorkspaceHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "ws_first",
          actorId: "user_1",
          role: "viewer",
        }),
      },
      hasMembership,
    });

    const response = await handler(
      request("ws_second", "https://attacker.test"),
    );
    expect(response.status).toBe(403);
    expect(hasMembership).not.toHaveBeenCalled();
  });
});

describe("configured public origin behind Next request reconstruction", () => {
  const context = {
    resolve: async () => ({
      workspaceId: "ws_first",
      actorId: "user_1",
      role: "operator" as const,
    }),
  };
  it("accepts the configured browser origin when Next reconstructs an internal localhost URL", async () => {
    const membership = vi.fn().mockResolvedValue(true);
    const handler = createSelectWorkspaceHandler({
      sessionContext: context,
      hasMembership: membership,
      publicOrigin: () => "http://127.0.0.1:49217",
    });
    const req = new Request("http://localhost:49217/api/workspace/select", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:49217",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: "ws_second" }),
    });
    expect((await handler(req)).status).toBe(200);
    expect(membership).toHaveBeenCalledWith("user_1", "ws_second");
  });
  it("rejects a forged Host/forwarded header and internal origin before membership lookup", async () => {
    const membership = vi.fn(),
      resolve = vi.fn();
    const handler = createSelectWorkspaceHandler({
      sessionContext: { resolve },
      hasMembership: membership,
      publicOrigin: () => "https://app.test",
    });
    for (const origin of ["https://attacker.test", "http://localhost:49217"]) {
      const req = new Request("http://localhost:49217/api/workspace/select", {
        method: "POST",
        headers: {
          origin,
          host: "attacker.test",
          "x-forwarded-host": "attacker.test",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId: "ws_second" }),
      });
      expect((await handler(req)).status).toBe(403);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(membership).not.toHaveBeenCalled();
  });
  it("keeps membership authorization and Secure cookies under the canonical HTTPS origin", async () => {
    for (const allowed of [false, true]) {
      const handler = createSelectWorkspaceHandler({
        sessionContext: context,
        hasMembership: async () => allowed,
        publicOrigin: () => "https://app.test",
      });
      const req = new Request("http://internal:3000/api/workspace/select", {
        method: "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId: "ws_second" }),
      });
      const response = await handler(req);
      expect(response.status).toBe(allowed ? 200 : 403);
      if (allowed)
        expect(response.headers.get("set-cookie")).toContain("Secure");
      else expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
  it("rejects a missing/null Origin and expired session", async () => {
    const membership = vi.fn(),
      handler = createSelectWorkspaceHandler({
        sessionContext: { resolve: async () => null },
        hasMembership: membership,
        publicOrigin: () => "https://app.test",
      });
    for (const origin of [undefined, "null"]) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (origin) headers.origin = origin;
      expect(
        (
          await handler(
            new Request("http://internal/api/workspace/select", {
              method: "POST",
              headers,
              body: '{"workspaceId":"ws_second"}',
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect((await handler(request("ws_second"))).status).toBe(401);
    expect(membership).not.toHaveBeenCalled();
  });
  it("uses server configuration, supports Vercel hostnames and fails closed on invalid explicit URLs", () => {
    expect(
      configuredWorkspaceOrigin({ BETTER_AUTH_URL: "http://127.0.0.1:49217/" }),
    ).toBe("http://127.0.0.1:49217");
    expect(
      configuredWorkspaceOrigin({ VERCEL_URL: "preview.example.test" }),
    ).toBe("https://preview.example.test");
    expect(
      configuredWorkspaceOrigin({
        BETTER_AUTH_URL: "https://public.test",
        VERCEL_URL: "ignored.test",
      }),
    ).toBe("https://public.test");
    expect(configuredWorkspaceOrigin({})).toBeNull();
    expect(
      configuredWorkspaceOrigin({
        BETTER_AUTH_URL: "https://user:pass@app.test",
      }),
    ).toBe("");
    expect(configuredWorkspaceOrigin({ BETTER_AUTH_URL: "broken url" })).toBe(
      "",
    );
    expect(
      configuredWorkspaceOrigin({ BETTER_AUTH_URL: "ftp://app.test" }),
    ).toBe("");
  });
});
