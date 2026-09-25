import { describe, expect, it, vi } from "vitest";

import { createSelectWorkspaceHandler } from "./route";

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
