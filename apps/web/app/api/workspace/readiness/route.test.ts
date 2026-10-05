import { describe, expect, it, vi } from "vitest";
import { createReadinessHandler } from "./route";
describe("GET /api/workspace/readiness", () => {
  it("rejects operator before touching workspace observations", async () => {
    const getDatabase = vi.fn();
    const handler = createReadinessHandler({
      sessionContext: {
        async resolve() {
          return { workspaceId: "ws1", actorId: "u1", role: "operator" };
        },
      },
      getDatabase,
      now: () => new Date(),
      env: {},
    });
    const response = await handler(
      new Request("http://localhost/api/workspace/readiness"),
    );
    expect(response.status).toBe(403);
    expect(getDatabase).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      code: "insufficient_role",
      message: "Admin access is required.",
    });
  });
  it("returns only safe fixed statuses in the authenticated workspace", async () => {
    const handler = createReadinessHandler({
      sessionContext: {
        async resolve() {
          return { workspaceId: "ws-synthetic", actorId: "u1", role: "admin" };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async (id: string, work: any) => {
            expect(id).toBe("ws-synthetic");
            return work({
              workspaces: {
                requireProfile: async () => ({
                  name: "Synthetic",
                  currency: "HKD",
                  locales: ["en"],
                  tone: "Plain",
                  claimPolicy: [],
                  requiredFields: [],
                }),
                readinessObservations: async () => ({
                  reviewerCount: 1,
                  connectionPresent: true,
                  latestAi: null,
                  latestQueueStep: null,
                  secret: "never expose",
                }),
              },
            });
          },
        }) as any,
      now: () => new Date("2026-10-01T10:00:00Z"),
      env: { AI_PROVIDER: "fake" },
    });
    const response = await handler(
      new Request("http://localhost/api/workspace/readiness"),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(5);
    expect(JSON.stringify(body)).not.toContain("never expose");
    expect(
      body.items.every(
        (item: any) =>
          Object.keys(item).sort().join(",") ===
          "checkedAt,key,nextAction,safeReason,state",
      ),
    ).toBe(true);
  });
});
it("returns a safe 500 for denied database observations instead of pretending readiness is unknown", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const handler = createReadinessHandler({
      sessionContext: {
        async resolve() {
          return { workspaceId: "ws-synthetic", actorId: "u1", role: "admin" };
        },
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_id: string, work: any) =>
            work({
              workspaces: {
                requireProfile: async () => ({
                  name: "Synthetic",
                  currency: "HKD",
                  locales: ["en"],
                  tone: "Plain",
                  claimPolicy: [],
                  requiredFields: [],
                }),
                readinessObservations: async () => {
                  throw Object.assign(
                    new Error("synthetic-secret connection detail"),
                    { code: "42501" },
                  );
                },
              },
            }),
        }) as any,
      now: () => new Date("2026-10-01T10:00:00Z"),
      env: {},
    });
    const response = await handler(
      new Request("http://localhost/api/workspace/readiness"),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret");
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});
