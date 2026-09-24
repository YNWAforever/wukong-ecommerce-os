import { expect, it, vi } from "vitest";
import { createBatchControlHandler } from "./route.js";
const key = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: key }) };
const request = (body: unknown) =>
  new Request("http://localhost/control", {
    method: "POST",
    body: JSON.stringify(body),
  });
it("requires operator role before any lifecycle mutation", async () => {
  const control = vi.fn();
  const handler = createBatchControlHandler({
    control,
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws", actorId: "actor", role: "viewer" };
      },
    },
  });
  expect(
    (
      await handler(
        request({
          action: "cancel",
          expectedControlRevision: 0,
          idempotencyKey: key,
        }),
        context,
      )
    ).status,
  ).toBe(403);
  expect(control).not.toHaveBeenCalled();
});
it("accepts session scoped revisioned controls and rejects malformed retry selections", async () => {
  const control = vi.fn().mockResolvedValue({ controlRevision: 2 });
  const handler = createBatchControlHandler({
    control,
    sessionContext: {
      async resolve() {
        return {
          workspaceId: "session-workspace",
          actorId: "actor",
          role: "operator",
        };
      },
    },
  });
  expect(
    (
      await handler(
        request({
          action: "pause",
          expectedControlRevision: 1,
          idempotencyKey: key,
        }),
        context,
      )
    ).status,
  ).toBe(202);
  expect(control).toHaveBeenCalledWith({
    workspaceId: "session-workspace",
    actorId: "actor",
    batchId: key,
    action: "pause",
    expectedControlRevision: 1,
    idempotencyKey: key,
  });
  expect(
    (
      await handler(
        request({
          action: "retry_selected",
          expectedControlRevision: 1,
          idempotencyKey: key,
          itemIds: [key, key],
        }),
        context,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handler(
        request({
          action: "cancel",
          expectedControlRevision: 1,
          idempotencyKey: key,
          workspaceId: "other",
        }),
        context,
      )
    ).status,
  ).toBe(400);
  expect(control).toHaveBeenCalledTimes(1);
});
