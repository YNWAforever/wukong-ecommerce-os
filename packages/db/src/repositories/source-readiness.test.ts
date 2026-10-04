import { describe, expect, it, vi } from "vitest";
import { createWorkspaceReadRepository } from "./workspace-reads.js";

describe("bounded source readiness bundle", () => {
  it("uses one scoped SQL statement for one, twenty-five and one hundred IDs", async () => {
    for (const count of [1, 25, 100]) {
      const execute = vi.fn(async () => [{ listings: [], imports: [] }]);
      const reads = createWorkspaceReadRepository(
        { execute } as never,
        "owned",
        { assertOpen() {} } as never,
      );
      await reads.sourceReadinessBatch(
        Array.from(
          { length: count },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      );
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps a whole database failure outside item error classification", async () => {
    const failure = Object.assign(new Error("permission denied"), {
      code: "42501",
    });
    const reads = createWorkspaceReadRepository(
      {
        execute: async () => {
          throw failure;
        },
      } as never,
      "owned",
      { assertOpen() {} } as never,
    );
    await expect(
      reads.sourceReadinessBatch(["00000000-0000-4000-8000-000000000001"]),
    ).rejects.toBe(failure);
  });
  it("bounds requests and does not read for an empty batch", async () => {
    const execute = vi.fn();
    const reads = createWorkspaceReadRepository({ execute } as never, "owned", {
      assertOpen() {},
    } as never);
    expect(await reads.sourceReadinessBatch([])).toEqual({
      listings: [],
      imports: [],
    });
    expect(execute).not.toHaveBeenCalled();
    await expect(
      reads.sourceReadinessBatch(Array(101).fill("id")),
    ).rejects.toThrow("bounded");
  });
});
