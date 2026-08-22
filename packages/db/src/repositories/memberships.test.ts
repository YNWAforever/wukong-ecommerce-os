import { describe, expect, it, vi } from "vitest";

import {
  createMembershipRepository,
  MembershipGuardViolation,
} from "./memberships.js";

function fakeTransaction(rows: { userId: string; role: string }[]) {
  const state = { rows: [...rows] };
  return {
    state,
    transaction: {
      select: () => ({
        from: () => ({
          where: async () => state.rows,
          innerJoin: () => ({
            where: async () => [],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            /* not asserted at this layer -- covered by the integration test */
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          /* not asserted at this layer -- covered by the integration test */
        },
      }),
    } as unknown as import("../client.js").WorkspaceTransaction,
  };
}

const openScope = { assertOpen: vi.fn() };

describe("createMembershipRepository guard logic", () => {
  it("rejects self-action on updateRole regardless of role counts", async () => {
    const { transaction } = fakeTransaction([{ userId: "u1", role: "admin" }]);
    const repo = createMembershipRepository(transaction, "ws1", openScope);
    await expect(repo.updateRole("u1", "u1", "operator")).rejects.toThrow(
      MembershipGuardViolation,
    );
  });

  it("rejects self-action on remove regardless of role counts", async () => {
    const { transaction } = fakeTransaction([{ userId: "u1", role: "admin" }]);
    const repo = createMembershipRepository(transaction, "ws1", openScope);
    await expect(repo.remove("u1", "u1")).rejects.toThrow(MembershipGuardViolation);
  });
});
