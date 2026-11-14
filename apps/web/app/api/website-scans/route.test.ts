import { describe, it, expect, vi } from "vitest";
import { createWebsiteScansHandler } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
const request = (
  body: unknown = { url: "https://store.example/", requestKey: "retry-key" },
) =>
  new Request("https://app.example/api/website-scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
export const fixtureScan = () => ({
  id,
  state: "queued",
  revision: 0,
  workspaceId: "session-workspace",
  requestedUrl: "https://store.example/",
  createdAt: new Date(),
  updatedAt: new Date(),
  nextEligibleAt: new Date(),
  dispatchStatus: "pending",
  dispatchAttempts: 0,
  dispatchAt: null as Date | null,
  leaseExpiresAt: null as Date | null,
  deadlineAt: new Date(Date.now() + 15 * 60_000),
  checkpoint: {
    preview: { products: [], warnings: [] },
    candidateUrls: [],
    visitedUrls: [],
  },
});
function dispatchRepository(
  scan: ReturnType<typeof fixtureScan>,
  createScan: () => Promise<ReturnType<typeof fixtureScan>>,
  recordDispatch: (input: unknown) => Promise<unknown>,
) {
  return {
    websiteCatalog: {
      createScan,
      getScan: async () => scan,
      claimDispatch: async (input: { expectedAttempts: number; now: Date }) => {
        if (scan.dispatchAttempts !== input.expectedAttempts) return null;
        scan.dispatchAttempts++;
        scan.dispatchAt = input.now;
        scan.dispatchStatus = "pending";
        return { ...scan };
      },
      recordDispatch: async (input: { status: string }) => {
        await recordDispatch(input);
        scan.dispatchStatus = input.status;
        return true;
      },
    },
  };
}
describe("start website scan", () => {
  it.each(["operator", "reviewer", "admin", "owner"])(
    "allows %s without a connection or encryption key",
    async (role) => {
      const scan = fixtureScan();
      const createScan = vi.fn(async () => scan);
      const recordDispatch = vi.fn();
      const enqueue = vi.fn(async () => ({ accepted: true }));
      const database = {
        forWorkspace: async (ws: string, work: any) => {
          expect(ws).toBe("session-workspace");
          return work(dispatchRepository(scan, createScan, recordDispatch));
        },
      };
      const handler = createWebsiteScansHandler({
        session: {
          resolve: async () => ({
            workspaceId: "session-workspace",
            actorId: "session-actor",
            role,
          }),
        } as any,
        getDatabase: () => database as any,
        enqueue,
      });
      const result = await handler(request());
      expect(result.status).toBe(202);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(createScan).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedBy: "session-actor",
          requestKey: "retry-key",
        }),
      );
      expect(enqueue).toHaveBeenCalledOnce();
      const projected = await result.json();
      expect(projected.dispatch).toMatchObject({ revision: 0, attempts: 1 });
      for (const privateField of [
        "workspaceId",
        "requestKey",
        "leaseToken",
        "checkpoint",
      ])
        expect(projected).not.toHaveProperty(privateField);
    },
  );
  it.each([null, "viewer"])(
    "rejects missing/insufficient session %s",
    async (role) => {
      const getDatabase = vi.fn();
      const handler = createWebsiteScansHandler({
        session: {
          resolve: async () =>
            role ? { workspaceId: "ws", actorId: "actor", role } : null,
        } as any,
        getDatabase,
        enqueue: vi.fn(),
      });
      const result = await handler(request());
      expect(result.status).toBe(role ? 403 : 401);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(getDatabase).not.toHaveBeenCalled();
    },
  );
  it.each([
    { url: "http://store.example/", requestKey: "a" },
    { url: "https://127.0.0.1/", requestKey: "a" },
    { url: "https://store.example/", requestKey: "a", workspaceId: "foreign" },
    { url: "https://store.example/" },
    "x".repeat(4097),
  ])("rejects invalid or oversized input", async (body) => {
    const getDatabase = vi.fn();
    const handler = createWebsiteScansHandler({
      session: {
        resolve: async () => ({
          workspaceId: "ws",
          actorId: "actor",
          role: "operator",
        }),
      },
      getDatabase,
      enqueue: vi.fn(),
    });
    const result = await handler(request(body));
    expect([400, 413]).toContain(result.status);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(getDatabase).not.toHaveBeenCalled();
  });
  it("retains durable scan identity when initial enqueue fails", async () => {
    const recordDispatch = vi.fn();
    const scan = fixtureScan();
    const createScan = vi.fn(async () => scan);
    const enqueue = vi.fn(async () => {
      throw new Error("secret diagnostic");
    });
    const handler = createWebsiteScansHandler({
      session: {
        resolve: async () => ({
          workspaceId: "ws",
          actorId: "actor",
          role: "operator",
        }),
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_ws: string, work: any) =>
            work(dispatchRepository(scan, createScan, recordDispatch)),
        }) as any,
      enqueue,
    });
    const response = await handler(request());
    expect(response.status).toBe(202);
    expect((await response.json()).id).toBe(id);
    expect(recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });
});

it("keeps framework-dispatched unsupported HTTP methods no-store", async () => {
  const modules = [
    await import("./route"),
    await import("./[id]/route"),
    await import("./[id]/save/route"),
    await import("./[id]/retry/route"),
  ];
  for (const [index, module] of modules.entries())
    for (const method of [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]) {
      if (method === (index === 1 ? "GET" : "POST")) continue;
      const handler = (module as Record<string, unknown>)[method];
      expect(handler).toBeTypeOf("function");
      const response = await (handler as () => Promise<Response>)();
      expect(response.status).toBe(405);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
});

it("accepts a canonical URL longer than 2048 characters within the creation body bound", async () => {
  const url = "https://store.example/products/" + "a".repeat(3000);
  const scan = fixtureScan();
  const createScan = vi.fn(async () => scan);
  const handler = createWebsiteScansHandler({
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
          work(dispatchRepository(scan, createScan, vi.fn())),
      }) as any,
    enqueue: vi.fn(),
  });
  expect((await handler(request({ url, requestKey: "long-key" }))).status).toBe(
    202,
  );
  expect(createScan).toHaveBeenCalledWith(expect.objectContaining({ url }));
});
