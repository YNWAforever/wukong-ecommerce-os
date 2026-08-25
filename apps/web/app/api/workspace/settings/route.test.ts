import { describe, expect, it, vi } from "vitest";

import { createSettingsGetHandler, createSettingsHandler } from "./route.js";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/workspace/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseProfile = {
  name: "Opak Cellar",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"] as const,
  tone: "clear",
  claimPolicy: [] as string[],
  requiredFields: [] as string[],
  brandBackgroundColor: null as string | null,
};

describe("POST /api/workspace/settings", () => {
  it("rejects a role below admin", async () => {
    const updateProfile = vi.fn();
    const requireProfile = vi.fn(async () => baseProfile);
    const auditWrite = vi.fn(async () => {});
    const handler = createSettingsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "reviewer" as const,
          };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_id: string, work: any) =>
            work({
              workspaces: { requireProfile, updateProfile },
              audit: { write: auditWrite },
            }),
        }) as any,
    });
    const response = await handler(
      makeRequest({ brandBackgroundColor: "#112233" }),
    );
    expect(response.status).toBe(403);
    expect(updateProfile).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it("updates the brand background color for admin and above", async () => {
    const updateProfile = vi.fn(async () => {});
    const requireProfile = vi.fn(async () => baseProfile);
    const auditWrite = vi.fn(async () => {});
    const handler = createSettingsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "admin" as const,
          };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_id: string, work: any) =>
            work({
              workspaces: { requireProfile, updateProfile },
              audit: { write: auditWrite },
            }),
        }) as any,
    });
    const response = await handler(
      makeRequest({ brandBackgroundColor: "#112233" }),
    );
    expect(response.status).toBe(200);
    expect(updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ brandBackgroundColor: "#112233" }),
    );
    expect(auditWrite).toHaveBeenCalledWith({
      workspaceId: "ws_opak",
      actorId: "user_1",
      entityId: "ws_opak",
      action: "workspace.settings_updated",
      metadata: { brandBackgroundColor: "#112233" },
    });
  });

  it("rejects a malformed color with 400", async () => {
    const handler = createSettingsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "owner" as const,
          };
        },
      },
      getDatabase: () => ({ forWorkspace: async () => {} }) as any,
    });
    const response = await handler(
      makeRequest({ brandBackgroundColor: "red" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/workspace/settings", () => {
  it("rejects a sub-admin role", async () => {
    const handler = createSettingsGetHandler({
      sessionContext: {
        async resolve() {
          return { workspaceId: "ws1", actorId: "u1", role: "reviewer" };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async () => {
            throw new Error("should not be called");
          },
        }) as any,
    });
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(403);
  });

  it("returns the current brandBackgroundColor for an admin", async () => {
    const requireProfile = vi.fn(async () => ({
      name: "Opak",
      currency: "HKD" as const,
      locales: ["en", "zh-Hant"] as const,
      tone: "warm",
      claimPolicy: [],
      requiredFields: [],
      brandBackgroundColor: "#112233",
    }));
    const handler = createSettingsGetHandler({
      sessionContext: {
        async resolve() {
          return { workspaceId: "ws1", actorId: "u1", role: "admin" };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_id: string, work: any) =>
            work({ workspaces: { requireProfile } }),
        }) as any,
    });
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brandBackgroundColor: "#112233" });
  });
});
