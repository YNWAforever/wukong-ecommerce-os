import { createHash } from "node:crypto";
import { workspaceProfileSchema } from "@wukong/core";
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
    const updateSettings = vi.fn();
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
              workspaces: { requireProfile, updateSettings },
              audit: { write: auditWrite },
            }),
        }) as any,
    });
    const response = await handler(
      makeRequest({
        brandBackgroundColor: "#112233",
        expectedDigest: "a".repeat(64),
      }),
    );
    expect(response.status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it("updates the brand background color for admin and above", async () => {
    const updateSettings = vi.fn(async () => ({
      ...baseProfile,
      brandBackgroundColor: "#112233",
    }));
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
              workspaces: { requireProfile, updateSettings },
              audit: { write: auditWrite },
            }),
        }) as any,
    });
    const response = await handler(
      makeRequest({
        brandBackgroundColor: "#112233",
        expectedDigest: "a".repeat(64),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      brandBackgroundColor: "#112233",
      digest: expect.any(String),
    });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ brandBackgroundColor: "#112233" }),
      "a".repeat(64),
    );
    expect(auditWrite).toHaveBeenCalledWith({
      workspaceId: "ws_opak",
      actorId: "user_1",
      entityId: "ws_opak",
      action: "workspace.settings_updated",
      metadata: { brandBackgroundColor: "#112233" },
    });
  });

  it("requires a fence and exposes concurrent settings as 409 without an audit", async () => {
    const auditWrite = vi.fn();
    const updateSettings = async () => {
      throw Object.assign(new Error("conflict"), {
        code: "workspace_policy_conflict",
      });
    };
    const handler = createSettingsHandler({
      sessionContext: {
        async resolve() {
          return { workspaceId: "ws1", actorId: "u1", role: "admin" };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_: string, work: any) =>
            work({
              workspaces: { updateSettings },
              audit: { write: auditWrite },
            }),
        }) as any,
    });
    expect(
      (await handler(makeRequest({ brandBackgroundColor: "#112233" }))).status,
    ).toBe(400);
    expect(
      (
        await handler(
          makeRequest({
            brandBackgroundColor: "#112233",
            expectedDigest: "a".repeat(64),
          }),
        )
      ).status,
    ).toBe(409);
    expect(auditWrite).not.toHaveBeenCalled();
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
    expect(await response.json()).toEqual({
      brandBackgroundColor: "#112233",
      digest: createHash("sha256")
        .update(
          JSON.stringify(workspaceProfileSchema.parse(await requireProfile())),
        )
        .digest("hex"),
    });
  });
});
