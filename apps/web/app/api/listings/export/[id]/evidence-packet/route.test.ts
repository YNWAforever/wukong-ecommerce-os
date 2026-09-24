import { describe, it, expect, vi } from "vitest";
import { createExportEvidenceHandlers } from "./route";
const id = "11111111-1111-4111-8111-111111111111",
  comparisonId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id }) };
function setup(role: string | null = "reviewer") {
  const preview = vi.fn(async () => ({ comparisonId })),
    download = vi.fn(async () => ({
      json: '{"payload":{}}',
      filename: "evidence.json",
    }));
  return {
    preview,
    download,
    handlers: createExportEvidenceHandlers({
      sessionContext: {
        resolve: async () =>
          role ? ({ role, actorId: "actor", workspaceId: "ws" } as any) : null,
      },
      service: { preview, download } as any,
    }),
  };
}
const request = (method = "GET", body?: unknown) =>
  new Request(
    `http://localhost/api/listings/export/${id}/evidence-packet?comparisonId=${comparisonId}`,
    { method, ...(body ? { body: JSON.stringify(body) } : {}) },
  );
describe("evidence packet routes", () => {
  it("previews selected comparison under authenticated workspace, no-store", async () => {
    const f = setup();
    const response = await f.handlers.GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.preview).toHaveBeenCalledWith({
      workspaceId: "ws",
      exportAttemptId: id,
      comparisonId,
    });
    expect(f.download).not.toHaveBeenCalled();
  });
  it("downloads attachment only via explicit POST identity", async () => {
    const f = setup();
    const response = await f.handlers.POST(
      request("POST", { comparisonId, expectedSnapshotSha256: "a".repeat(64) }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"payload":{}}');
    expect(f.download).toHaveBeenCalledWith({
      workspaceId: "ws",
      actorId: "actor",
      exportAttemptId: id,
      comparisonId,
      expectedSnapshotSha256: "a".repeat(64),
    });
  });
  it.each([null, "viewer", "operator"])(
    "denies %s on both methods",
    async (role) => {
      const f = setup(role);
      expect((await f.handlers.GET(request(), context)).status).toBe(
        role ? 403 : 401,
      );
      expect((await f.handlers.POST(request("POST", {}), context)).status).toBe(
        role ? 403 : 401,
      );
      expect(f.preview).not.toHaveBeenCalled();
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it.each(["reviewer", "admin", "owner"])("allows %s", async (role) =>
    expect((await setup(role).handlers.GET(request(), context)).status).toBe(
      200,
    ),
  );
  it("validates exact IDs and snapshot digest", async () => {
    const f = setup();
    expect(
      (await f.handlers.GET(new Request("http://localhost"), context)).status,
    ).toBe(400);
    expect(
      (await f.handlers.POST(request("POST", { comparisonId }), context))
        .status,
    ).toBe(400);
    expect(
      (
        await f.handlers.GET(request(), {
          params: Promise.resolve({ id: "bad" }),
        })
      ).status,
    ).toBe(404);
    expect(f.preview).not.toHaveBeenCalled();
  });
  it("hides unexpected service errors", async () => {
    const f = setup();
    f.preview.mockRejectedValue(new Error("SECRET"));
    const response = await f.handlers.GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
  });
});
