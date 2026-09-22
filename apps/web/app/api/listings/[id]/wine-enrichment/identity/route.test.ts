import { afterEach, expect, it, vi } from "vitest";
import { createWineOperationHandler } from "../../../../../../lib/wine-operation-route";
afterEach(() => vi.unstubAllEnvs());
const id = "00000000-0000-4000-8000-000000000001",
  key = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id }) };
function fixture(role: string | null = "operator") {
  const accept = vi.fn(async () => ({
    processing: { runId: "run" },
    outbox: [],
    run: {},
  }));
  const database = {
    forWorkspace: vi.fn(async (workspace: string, fn: any) => {
      expect(workspace).toBe("ws");
      return fn({});
    }),
  };
  const handler = createWineOperationHandler(
    {
      sessionContext: {
        resolve: async () =>
          role ? { workspaceId: "ws", actorId: "actor", role } : null,
      } as never,
      getDatabase: () => database as never,
      confirmIdentity: accept as never,
    },
    "identity",
  );
  return { handler, accept, database };
}
function request(
  body: unknown = {
    sourceRunId: id,
    sourceStage: "verification",
    sourceId: key,
    expectedInputRevision: 1,
    baseVersionId: null,
  },
  withKey = true,
) {
  return new Request("http://localhost/api/wine", {
    method: "POST",
    headers: withKey ? { "Idempotency-Key": key } : {},
    body: JSON.stringify(body),
  });
}
it.each([
  [null, 401],
  ["viewer", 403],
  ["member", 403],
] as const)("rejects role %s before DB", async (role, status) => {
  const f = fixture(role);
  expect((await f.handler(request(), context)).status).toBe(status);
  expect(f.database.forWorkspace).not.toHaveBeenCalled();
});
it.each(["operator", "reviewer", "admin", "owner"])(
  "accepts strict wine request for %s",
  async (role) => {
    vi.stubEnv("WINE_ENRICHMENT_ENABLED", "false");
    const f = fixture(role);
    const response = await f.handler(request(), context);
    expect(response.status).toBe(202);
    expect(f.accept).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sourceRunId: id,
        sourceStage: "verification",
        sourceId: key,
        operationKey: key,
        expectedInputRevision: 1,
        baseVersionId: null,
      }),
      {},
    );
  },
);
it("requires explicit idempotency key", async () => {
  const f = fixture();
  expect((await f.handler(request(undefined, false), context)).status).toBe(
    400,
  );
  expect(f.accept).not.toHaveBeenCalled();
});
it.each([
  {
    sourceRunId: id,
    sourceStage: "verification",
    sourceId: key,
    expectedInputRevision: 1,
  },
  {
    sourceRunId: id,
    sourceStage: "verification",
    sourceId: key,
    expectedInputRevision: 1,
    baseVersionId: null,
    identity: { producer: "forged" },
  },
  { mode: "section", expectedInputRevision: 1, baseVersionId: null },
])("rejects incomplete or injected payload", async (body) => {
  const f = fixture();
  expect((await f.handler(request(body), context)).status).toBe(400);
  expect(f.accept).not.toHaveBeenCalled();
});
