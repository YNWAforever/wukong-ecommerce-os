import { expect, it, vi } from "vitest";
import { createAccountGetHandler } from "./route";
import type { Database } from "@wukong/db";
import type { SessionContext } from "../../../lib/session-context-port";
function harness(context: SessionContext | null) {
  const members = [
    {
      userId: "actor",
      email: "actor@local.invalid",
      name: "Synthetic actor",
      role: "reviewer" as const,
    },
    {
      userId: "admin",
      email: "admin@local.invalid",
      name: null,
      role: "admin" as const,
    },
  ];
  const listActiveMembers = vi.fn(async () => members);
  const forWorkspace = vi.fn(async (_ws, work) =>
    work({ assignments: { listActiveMembers } }),
  );
  return {
    handler: createAccountGetHandler({
      sessionContext: { resolve: async () => context },
      getDatabase: () => ({ forWorkspace }) as unknown as Database,
    }),
    forWorkspace,
    listActiveMembers,
  };
}
it("returns the actual account/current role and active admin contacts with no-store", async () => {
  const h = harness({
    workspaceId: "server-workspace",
    actorId: "actor",
    role: "operator",
  });
  const response = await h.handler(new Request("http://localhost/api/account"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    user: { userId: "actor", email: "actor@local.invalid" },
    role: "reviewer",
    contacts: [{ userId: "admin" }],
    workspaceId: "server-workspace",
  });
  expect(h.forWorkspace).toHaveBeenCalledWith(
    "server-workspace",
    expect.any(Function),
  );
});
it("refuses signed-out and removed-member sessions", async () => {
  const signedOut = harness(null);
  expect(
    (await signedOut.handler(new Request("http://localhost/api/account")))
      .status,
  ).toBe(401);
  expect(signedOut.forWorkspace).not.toHaveBeenCalled();
  const removed = harness({
    workspaceId: "server-workspace",
    actorId: "removed",
    role: "operator",
  });
  expect(
    (await removed.handler(new Request("http://localhost/api/account"))).status,
  ).toBe(401);
});
