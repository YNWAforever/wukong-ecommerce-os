import { expect, it } from "vitest";
import { readWorkspaceAccount } from "./account-read";
const context = {
  workspaceId: "synthetic",
  actorId: "operator",
  role: "operator" as const,
};
it("reads identity/current role and contact only from active workspace members", async () => {
  const members = [
    {
      userId: "operator",
      email: "actual@local.invalid",
      name: "Actual user",
      role: "reviewer" as const,
    },
    {
      userId: "admin",
      email: "admin@local.invalid",
      name: null,
      role: "admin" as const,
    },
    {
      userId: "viewer",
      email: "viewer@local.invalid",
      name: null,
      role: "viewer" as const,
    },
  ];
  const result = await readWorkspaceAccount(
    { assignments: { listActiveMembers: async () => members } } as any,
    context,
  );
  expect(result.user.email).toBe("actual@local.invalid");
  expect(result.role).toBe("reviewer");
  expect(result.contacts.map((c) => c.userId)).toEqual(["admin"]);
});
it("refuses a removed actor instead of showing a stale account", async () => {
  await expect(
    readWorkspaceAccount(
      { assignments: { listActiveMembers: async () => [] } } as any,
      context,
    ),
  ).rejects.toMatchObject({ status: 401 });
});
