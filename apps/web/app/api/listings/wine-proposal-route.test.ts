import { expect, it, vi } from "vitest";
import * as routes from "../../../lib/wine-proposal-route";
const id = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id, runId }) };
function fixture(role: string | null = "operator") {
  const read = vi.fn(async () => ({ state: "available" }));
  const adopt = vi.fn(async () => ({ versionId: id, runId, inputRevision: 1 }));
  const repos = {
    listings: {
      getById: async () => ({ inputRevision: 1, activeVersionId: id }),
    },
  };
  const database = {
    forWorkspace: vi.fn(async (_ws: string, fn: any) => fn(repos)),
  };
  const deps = {
    sessionContext: {
      resolve: async () =>
        role ? { workspaceId: "ws", actorId: "actor", role } : null,
    },
    getDatabase: () => database,
    read,
    adopt,
  } as any;
  return { ...routes.createWineProposalHandlers(deps), read, adopt, database };
}
const body = {
  expectedInputRevision: 1,
  baseVersionId: id,
  selectedPaths: ["title.en"],
};
function request(value: unknown = body, key: string | null = id) {
  return new Request("http://localhost/proposals", {
    method: "POST",
    headers: key ? { "Idempotency-Key": key } : {},
    body: JSON.stringify(value),
  });
}
it.each([null, "viewer", "member"])(
  "rejects %s before proposal lookup/replay",
  async (role) => {
    const f = fixture(role);
    expect((await f.GET(new Request("http://localhost"), context)).status).toBe(
      role ? 403 : 401,
    );
    expect((await f.POST(request(), context)).status).toBe(role ? 403 : 401);
    expect(f.database.forWorkspace).not.toHaveBeenCalled();
  },
);
it("reads no-store and adopts only server actor/scope with exact guards", async () => {
  const f = fixture();
  expect(
    (await f.GET(new Request("http://localhost"), context)).headers.get(
      "cache-control",
    ),
  ).toBe("no-store");
  expect((await f.POST(request(), context)).status).toBe(200);
  expect(f.adopt).toHaveBeenCalledWith(expect.anything(), {
    ...body,
    workspaceId: "ws",
    actorId: "actor",
    listingId: id,
    runId,
    operationKey: id,
  });
});
it.each([
  { ...body, content: {} },
  { ...body, actorId: "forged" },
  { ...body, selectedPaths: [] },
  { ...body, selectedPaths: ["title.en", "title.en"] },
])("rejects forged/malformed body", async (value) => {
  const f = fixture();
  expect((await f.POST(request(value), context)).status).toBe(400);
  expect(f.adopt).not.toHaveBeenCalled();
});
it("rejects missing key and malformed route without lookup", async () => {
  const f = fixture();
  expect((await f.POST(request(body, null), context)).status).toBe(400);
  const response = await f.GET(new Request("http://localhost"), {
    params: Promise.resolve({ id, runId: "bad" }),
  });
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(f.read).not.toHaveBeenCalled();
});
it("maps known conflicts and conceals arbitrary error details", async () => {
  const f = fixture();
  f.adopt.mockRejectedValueOnce(Error("proposal_current_changed"));
  expect((await f.POST(request(), context)).status).toBe(409);
  f.read.mockRejectedValueOnce(Error("https://private.invalid?token=secret"));
  const response = await f.GET(new Request("http://localhost"), context);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private.invalid");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
