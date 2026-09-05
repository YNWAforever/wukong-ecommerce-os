import { describe, it, expect, vi } from "vitest";
import { createFreshExportVerificationHandlers } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
function fixture(role = "reviewer") {
  const record = vi.fn(async () => ({
    verification: { id: "comparison" },
    replayed: false,
  }));
  const history = vi.fn(async () => ({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
  }));
  const detail = vi.fn(async () => ({ verification: { id: "comparison" } }));
  const handlers = createFreshExportVerificationHandlers({
    sessionContext: {
      resolve: async () =>
        role === "none"
          ? null
          : { workspaceId: "ws", actorId: "user", role: role as any },
    },
    service: { record, history, detail } as any,
  });
  return { ...handlers, record, history, detail };
}
const url = "http://localhost/api/listings/export/" + id + "/verifications";
const post = (
  query = "filename=synthetic.xlsx&merchantAttestedExportAt=2026-09-05T01%3A00%3A00Z&sameStoreAttested=true",
  body = new Uint8Array([1]),
) => new Request(url + "?" + query, { method: "POST", body });
describe("fresh export verification route", () => {
  it.each(["none", "viewer", "operator"])(
    "rejects %s before reading or writing evidence",
    async (role) => {
      const f = fixture(role);
      expect((await f.POST(post(), context)).status).toBe(
        role === "none" ? 401 : 403,
      );
      expect(f.record).not.toHaveBeenCalled();
    },
  );
  it.each(["reviewer", "admin", "owner"])(
    "accepts reviewer-or-higher %s with workspace from session",
    async (role) => {
      const f = fixture(role);
      const r = await f.POST(post(undefined), context);
      expect(r.status).toBe(201);
      expect(f.record).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws",
          actorId: "user",
          exportAttemptId: id,
          filename: "synthetic.xlsx",
          merchantAttestedExportAt: "2026-09-05T01:00:00Z",
          sameStoreAttested: true,
          body: new Uint8Array([1]),
        }),
      );
    },
  );
  it("returns 200 on exact evidence replay", async () => {
    const f = fixture();
    f.record.mockResolvedValue({
      verification: { id: "comparison" },
      replayed: true,
    });
    expect((await f.POST(post(), context)).status).toBe(200);
  });
  it("rejects oversized body without trusting content-length", async () => {
    const f = fixture();
    expect(
      (
        await f.POST(
          post(undefined, new Uint8Array(4 * 1024 * 1024 + 1)),
          context,
        )
      ).status,
    ).toBe(413);
    expect(f.record).not.toHaveBeenCalled();
  });
  it("passes attestation false when missing, never inferring store", async () => {
    const f = fixture();
    await f.POST(post("filename=x.xlsx"), context);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        sameStoreAttested: false,
        merchantAttestedExportAt: "",
      }),
    );
  });
  it("pages metadata and scopes selected detail to both attempt and workspace", async () => {
    const f = fixture();
    expect(
      (await f.GET(new Request(url + "?page=2&pageSize=5"), context)).status,
    ).toBe(200);
    expect(f.history).toHaveBeenCalledWith({
      workspaceId: "ws",
      exportAttemptId: id,
      page: 2,
      pageSize: 5,
    });
    await f.GET(new Request(url + "?verificationId=" + id), context);
    expect(f.detail).toHaveBeenCalledWith({
      workspaceId: "ws",
      exportAttemptId: id,
      verificationId: id,
    });
  });
  it.each([
    "page=0",
    "pageSize=21",
    "page=1.2",
    "page=abc",
    "verificationId=bad",
  ])("rejects malformed query %s", async (query) => {
    const f = fixture();
    expect((await f.GET(new Request(url + "?" + query), context)).status).toBe(
      400,
    );
    expect(f.history).not.toHaveBeenCalled();
  });
  it("does not expose reader or database internals", async () => {
    const f = fixture();
    f.record.mockRejectedValue(new Error("synthetic private database detail"));
    const r = await f.POST(post(), context);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("private");
  });
});
