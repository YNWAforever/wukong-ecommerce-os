import { describe, expect, it, vi } from "vitest";
import {
  createAssignmentGetHandler,
  createAssignmentPostHandler,
} from "./route";
import type { Database } from "@wukong/db";
import type { SessionContext } from "../../../../lib/session-context-port";
const id = "00000000-0000-4000-8000-000000000001",
  key = "00000000-0000-4000-8000-000000000010";
function harness(
  context: SessionContext | null = {
    workspaceId: "server-workspace",
    actorId: "server-user",
    role: "reviewer",
  },
) {
  const apply = vi.fn(async (input) => ({
    listingId: input.listingId,
    outcome: "assigned",
    assigneeUserId: input.assigneeUserId,
    assignmentRevision: 1,
    replayed: false,
  }));
  const getMany = vi.fn(async () => []),
    listActiveMembers = vi.fn(async () => []);
  const forWorkspace = vi.fn(async (_id, work) =>
    work({ assignments: { apply, getMany, listActiveMembers } }),
  );
  const deps = {
    sessionContext: { resolve: async () => context },
    getDatabase: () => ({ forWorkspace }) as unknown as Database,
  };
  return {
    post: createAssignmentPostHandler(deps),
    get: createAssignmentGetHandler(deps),
    apply,
    getMany,
    forWorkspace,
  };
}
const request = (items: unknown) =>
  new Request("http://localhost/api/listings/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
describe("assignment route boundaries", () => {
  it("requires a live session and never queries a workspace when membership is removed", async () => {
    const h = harness(null);
    expect((await h.post(request([]))).status).toBe(401);
    expect(h.forWorkspace).not.toHaveBeenCalled();
  });
  it("rejects request-supplied workspace/actor and duplicate items", async () => {
    const h = harness(),
      item = {
        listingId: id,
        assigneeUserId: "operator",
        expectedRevision: 0,
        idempotencyKey: key,
        action: "assign",
      };
    expect(
      (await h.post(request([{ ...item, workspaceId: "foreign" }]))).status,
    ).toBe(400);
    expect((await h.post(request([item, item]))).status).toBe(400);
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("scopes each mutation to the resolved workspace and returns a no-store receipt", async () => {
    const h = harness();
    const response = await h.post(
      request([
        {
          listingId: id,
          assigneeUserId: "operator",
          expectedRevision: 0,
          idempotencyKey: key,
          action: "assign",
        },
      ]),
    );
    expect(response.status).toBe(200);
    expect(h.forWorkspace).toHaveBeenCalledWith(
      "server-workspace",
      expect.any(Function),
    );
    expect(h.apply).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "server-user" }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("rejects more than 100 IDs and foreign input never controls read scope", async () => {
    const h = harness();
    expect(
      (
        await h.get(
          new Request(
            "http://localhost/api/listings/assign?listingIds=" +
              Array(101).fill(id).join(","),
          ),
        )
      ).status,
    ).toBe(400);
    const response = await h.get(
      new Request(
        "http://localhost/api/listings/assign?listingIds=" +
          id +
          "&workspaceId=foreign",
      ),
    );
    expect(response.status).toBe(400);
    expect(h.getMany).not.toHaveBeenCalled();
  });
  it("denies operator bulk reassignment and viewer claim at the server route", async () => {
    const item = {
      listingId: id,
      assigneeUserId: "operator",
      expectedRevision: 0,
      idempotencyKey: key,
      action: "assign",
    };
    const op = harness({
      workspaceId: "server-workspace",
      actorId: "operator",
      role: "operator",
    });
    expect((await op.post(request([item]))).status).toBe(403);
    expect(op.apply).not.toHaveBeenCalled();
    const viewer = harness({
      workspaceId: "server-workspace",
      actorId: "operator",
      role: "viewer",
    });
    expect(
      (await viewer.post(request([{ ...item, action: "claim" }]))).status,
    ).toBe(403);
  });
});
