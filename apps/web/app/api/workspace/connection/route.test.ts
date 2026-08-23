import { describe, expect, it, vi } from "vitest";

import { ShoplineConnectionExistsError } from "@wukong/db";

import { createConnectionHandler } from "./route.js";

function harness(
  role: string,
  overrides: { getDefault?: any; create?: any; update?: any } = {},
) {
  const getDefault = overrides.getDefault ?? vi.fn(async () => null);
  const create =
    overrides.create ??
    vi.fn(async () => ({
      id: "conn1",
      shopDomain: "opak.myshopline.com",
      createdAt: new Date("2026-01-01"),
    }));
  const update = overrides.update ?? vi.fn(async () => undefined);
  const auditWrite = vi.fn(async () => undefined);
  const handler = createConnectionHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({
          shoplineConnections: { getDefault, create, update },
          audit: { write: auditWrite },
        }),
    }),
    getEncryptionKey: () => "A".repeat(43) + "=",
  } as any);
  return { handler, getDefault, create, update, auditWrite };
}

describe("GET /api/workspace/connection", () => {
  it("returns null when no connection exists", async () => {
    const { handler } = harness("admin");
    const response = await handler.GET(new Request("http://localhost"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: null });
  });

  it("returns shopDomain but never the token", async () => {
    const { handler } = harness("admin", {
      getDefault: vi.fn(async () => ({
        id: "conn1",
        shopDomain: "opak.myshopline.com",
        encryptedAccessToken: "v1.abc.def",
      })),
    });
    const response = await handler.GET(new Request("http://localhost"));
    const body = await response.json();
    expect(body.connection.shopDomain).toBe("opak.myshopline.com");
    expect(JSON.stringify(body)).not.toContain("encryptedAccessToken");
    expect(JSON.stringify(body)).not.toContain("v1.abc.def");
  });
});

describe("POST /api/workspace/connection", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler.POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({
          shopDomain: "opak.myshopline.com",
          accessToken: "tok",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("creates a connection for an admin", async () => {
    const { handler, create, auditWrite } = harness("admin");
    const response = await handler.POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({
          shopDomain: "opak.myshopline.com",
          accessToken: "tok",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith({
      shopDomain: "opak.myshopline.com",
      accessToken: "tok",
      base64Key: "A".repeat(43) + "=",
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.connection_created" }),
    );
  });

  it("returns 409 when a connection already exists", async () => {
    const { handler } = harness("admin", {
      create: vi.fn(async () => {
        throw new ShoplineConnectionExistsError();
      }),
    });
    const response = await handler.POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({
          shopDomain: "opak.myshopline.com",
          accessToken: "tok",
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "already_exists",
      message: "A SHOPLINE connection already exists for this workspace.",
    });
  });
});

describe("PATCH /api/workspace/connection", () => {
  it("rotates the token for an admin", async () => {
    const { handler, update, auditWrite } = harness("admin", {
      getDefault: vi.fn(async () => ({
        id: "conn1",
        shopDomain: "opak.myshopline.com",
        encryptedAccessToken: "v1.a.b",
      })),
    });
    const response = await handler.PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ accessToken: "new-tok" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith("conn1", {
      accessToken: "new-tok",
      base64Key: "A".repeat(43) + "=",
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.connection_rotated" }),
    );
  });

  it("returns 404 when rotating with no existing connection", async () => {
    const { handler } = harness("admin");
    const response = await handler.PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        body: JSON.stringify({ accessToken: "new-tok" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
