import { describe, it, expect, vi } from "vitest";
import { createWebsiteScanSaveHandler } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
const req = (
  body: unknown = { keys: ["https://store.example/products/one"] },
) =>
  new Request("https://app.example", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("save website selection", () => {
  it.each(["operator", "reviewer", "admin", "owner"])(
    "saves server preview for %s without platform configuration",
    async (role) => {
      const saveSelection = vi.fn(async () => ({
        savedIds: [id],
        alreadySavedIds: [],
      }));
      const handler = createWebsiteScanSaveHandler({
        session: {
          resolve: async () => ({ workspaceId: "own", actorId: "actor", role }),
        } as any,
        getDatabase: () =>
          ({
            forWorkspace: async (ws: string, work: any) => {
              expect(ws).toBe("own");
              return work({
                websiteCatalog: {
                  getScan: async () => ({
                    state: "partial",
                    checkpoint: {
                      preview: {
                        products: [
                          { key: "https://store.example/products/one" },
                        ],
                      },
                    },
                  }),
                  saveSelection,
                },
              });
            },
          }) as any,
      });
      const response = await handler(req(), {
        params: Promise.resolve({ id }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(saveSelection).toHaveBeenCalledWith({
        scanId: id,
        actorId: "actor",
        keys: ["https://store.example/products/one"],
      });
    },
  );
  it.each([null, "viewer"])("rejects %s", async (role) => {
    const getDatabase = vi.fn();
    const handler = createWebsiteScanSaveHandler({
      session: {
        resolve: async () =>
          role ? { workspaceId: "own", actorId: "actor", role } : null,
      } as any,
      getDatabase,
    });
    const response = await handler(req(), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(role ? 403 : 401);
    expect(getDatabase).not.toHaveBeenCalled();
  });
  it.each([
    [null, 404],
    [{ state: "running" }, 409],
  ])("rejects foreign or nonterminal selection", async (scan, status) => {
    const saveSelection = vi.fn();
    const handler = createWebsiteScanSaveHandler({
      session: {
        resolve: async () => ({
          workspaceId: "own",
          actorId: "actor",
          role: "operator",
        }),
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_ws: string, work: any) =>
            work({
              websiteCatalog: { getScan: async () => scan, saveSelection },
            }),
        }) as any,
    });
    const response = await handler(req(), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(saveSelection).not.toHaveBeenCalled();
  });
  it.each([
    { keys: [] },
    { keys: ["key", "key"] },
    { keys: ["key"], products: [{ title: "forged" }] },
    { keys: ["x".repeat(4100)] },
  ])("rejects invalid selection", async (body) => {
    const getDatabase = vi.fn();
    const handler = createWebsiteScanSaveHandler({
      session: {
        resolve: async () => ({
          workspaceId: "own",
          actorId: "actor",
          role: "operator",
        }),
      },
      getDatabase,
    });
    const response = await handler(req(body), {
      params: Promise.resolve({ id }),
    });
    expect([400, 413]).toContain(response.status);
    expect(getDatabase).not.toHaveBeenCalled();
  });
});

it("accepts twenty bounded product keys even when selection JSON exceeds 4 KiB", async () => {
  const keys = Array.from(
    { length: 20 },
    (_, i) => `https://store.example/products/${i}-${"a".repeat(4000)}`,
  );
  const saveSelection = vi.fn(async () => ({
    savedIds: [],
    alreadySavedIds: [],
  }));
  const handler = createWebsiteScanSaveHandler({
    session: {
      resolve: async () => ({
        workspaceId: "own",
        actorId: "actor",
        role: "operator",
      }),
    },
    getDatabase: () =>
      ({
        forWorkspace: async (_ws: string, work: any) =>
          work({
            websiteCatalog: {
              getScan: async () => ({
                state: "ready",
                checkpoint: {
                  preview: { products: keys.map((key) => ({ key })) },
                },
              }),
              saveSelection,
            },
          }),
      }) as any,
  });
  expect(
    (await handler(req({ keys }), { params: Promise.resolve({ id }) })).status,
  ).toBe(200);
  expect(saveSelection).toHaveBeenCalledOnce();
});

it("rejects a save body over 96 KiB before touching the database", async () => {
  const getDatabase = vi.fn();
  const handler = createWebsiteScanSaveHandler({
    session: {
      resolve: async () => ({
        workspaceId: "own",
        actorId: "actor",
        role: "operator",
      }),
    },
    getDatabase,
  });
  const response = await handler(req({ keys: ["x".repeat(97 * 1024)] }), {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(413);
  expect(getDatabase).not.toHaveBeenCalled();
});
