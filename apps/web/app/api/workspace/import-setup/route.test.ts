import { describe, expect, it, vi } from "vitest";
import { createImportSetupHandler } from "./route";
import type { SessionContext } from "../../../../lib/session-context-port";

function harness(
  role: SessionContext["role"] | null,
  key: string | undefined,
  connected = true,
) {
  const forWorkspace = vi.fn(async (_id: string, work: any) =>
    work({
      shoplineConnections: {
        getDefault: async () =>
          connected
            ? {
                shopDomain: "synthetic.myshopline.com",
                encryptedAccessToken: "private-ciphertext",
                workspaceId: "foreign-never-return",
              }
            : null,
      },
    }),
  );
  return {
    forWorkspace,
    handler: createImportSetupHandler({
      sessionContext: {
        resolve: async () =>
          role ? { workspaceId: "ws1", actorId: "u1", role } : null,
      },
      getDatabase: () => ({ forWorkspace }) as any,
      getEncryptionKey: () => key,
    }),
  };
}
describe("import setup summary", () => {
  it.each([
    ["viewer", false, false],
    ["operator", false, true],
    ["reviewer", false, true],
    ["admin", true, true],
    ["owner", true, true],
  ] as const)(
    "returns scoped minimal capabilities for %s",
    async (role, manage, canImport) => {
      const { handler, forWorkspace } = harness(role, "A".repeat(43) + "=");
      const response = await handler(
        new Request("http://localhost?workspaceId=foreign"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        connection: { shopDomain: "synthetic.myshopline.com" },
        canManageConnection: manage,
        canImport,
        credentialStorageConfigured: true,
      });
      expect(forWorkspace).toHaveBeenCalledWith("ws1", expect.any(Function));
    },
  );
  it.each([undefined, "", "invalid", "AA=="])(
    "reports unavailable key %s without blocking existing import",
    async (key) => {
      const { handler } = harness("operator", key);
      expect(
        await (await handler(new Request("http://localhost"))).json(),
      ).toEqual({
        connection: { shopDomain: "synthetic.myshopline.com" },
        canManageConnection: false,
        canImport: true,
        credentialStorageConfigured: false,
      });
    },
  );
  it("returns disconnected summary", async () => {
    const { handler } = harness("admin", "", false);
    expect(
      await (await handler(new Request("http://localhost"))).json(),
    ).toEqual({
      connection: null,
      canManageConnection: true,
      canImport: true,
      credentialStorageConfigured: false,
    });
  });
  it("denies unauthenticated callers before database access and never caches errors", async () => {
    const { handler, forWorkspace } = harness(null, undefined);
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(forWorkspace).not.toHaveBeenCalled();
  });
});
