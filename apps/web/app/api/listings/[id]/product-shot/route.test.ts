import { describe, it, expect, vi } from "vitest";
import { createProductShotHandler } from "./route";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = { sourceAssetId: id(3), expectedVersionId: id(2) };
const request = (data: any = body) =>
  new Request("http://localhost/api/listings/" + id(1) + "/product-shot", {
    method: "POST",
    body: JSON.stringify(data),
  });
const context = { params: Promise.resolve({ id: id(1) }) };
function fixture(role: string | null = "operator") {
  const requestShot = vi.fn(async () => ({ state: "queued" }));
  const repos: any = {
    listings: {
      getReviewSnapshot: async () => ({
        listing: { activeVersionId: id(2) },
        activeVersion: { id: id(2) },
      }),
    },
    productShots: { currentForListing: async () => null },
    sourceAssets: { listForListing: async () => [] },
  };
  const deps: any = {
    sessionContext: {
      resolve: async () =>
        role ? { workspaceId: "ws", actorId: "actor", role } : null,
    },
    getDatabase: () => ({
      forWorkspace: async (ws: string, fn: any) => {
        expect(ws).toBe("ws");
        return fn(repos);
      },
    }),
    getAssetStore: () => ({}),
    requestShot,
  };
  return { deps, requestShot, repos };
}
describe("strict scoped product shot routes", () => {
  it.each([
    [null, 401],
    ["viewer", 403],
    ["member", 403],
  ])("rejects request role %s", async (role, status) => {
    const f = fixture(role);
    expect(
      (await createProductShotHandler(f.deps, "request")(request(), context))
        .status,
    ).toBe(status);
    expect(f.requestShot).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, workspaceId: "foreign" },
    { ...body, sourceAssetId: [] },
    { ...body, sourceAssetId: [id(3), id(4)] },
    { ...body, expectedVersionId: "bad" },
    { ...body, sourceDigest: "a".repeat(64) },
  ])("rejects invalid input", async (data) => {
    const f = fixture();
    expect(
      (
        await createProductShotHandler(f.deps, "request")(
          request(data),
          context,
        )
      ).status,
    ).toBe(400);
    expect(f.requestShot).not.toHaveBeenCalled();
  });
  it("defaults fresh charge to false and only passes server workspace", async () => {
    const f = fixture();
    expect(
      (await createProductShotHandler(f.deps, "request")(request(), context))
        .status,
    ).toBe(200);
    expect(f.requestShot).toHaveBeenCalledWith({
      ...body,
      explicitFreshAttempt: false,
      workspaceId: "ws",
      actorId: "actor",
      listingId: id(1),
    });
  });
  it("rejects foreign listing before requesting", async () => {
    const f = fixture();
    f.repos.listings.getReviewSnapshot = async () => null;
    expect(
      (await createProductShotHandler(f.deps, "request")(request(), context))
        .status,
    ).toBe(404);
    expect(f.requestShot).not.toHaveBeenCalled();
  });
  it("allows deliberate fresh action", async () => {
    const f = fixture();
    await createProductShotHandler(f.deps, "request")(
      request({ ...body, explicitFreshAttempt: true }),
      context,
    );
    expect(f.requestShot).toHaveBeenCalledWith(
      expect.objectContaining({ explicitFreshAttempt: true }),
    );
  });
  it.each(["prepare", "approve"] as const)(
    "rejects malformed %s identity",
    async (action) => {
      const f = fixture("reviewer");
      expect(
        (
          await createProductShotHandler(f.deps, action)(
            request({ attemptId: "foreign", expectedVersionId: id(2) }),
            context,
          )
        ).status,
      ).toBe(400);
    },
  );
  it("requires reviewer for exact image acceptance", async () => {
    const f = fixture();
    expect(
      (
        await createProductShotHandler(f.deps, "approve")(
          request({
            attemptId: id(3),
            expectedVersionId: id(2),
            candidateDigest: "a".repeat(64),
          }),
          context,
        )
      ).status,
    ).toBe(403);
  });
});

it("does not advertise mutation actions to a viewer", async () => {
  const f = fixture("viewer");
  const response = await createProductShotHandler(f.deps, "read")(
    new Request("http://localhost"),
    context,
  );
  expect(response.status).toBe(200);
  expect((await response.json()).allowedActions).toEqual([]);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(f.requestShot).not.toHaveBeenCalled();
});
