import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../auth", () => ({ getAuthDatabase: () => ({ execute }) }));

import {
  hasUserWorkspaceMembership,
  listUserWorkspaces,
} from "./workspace-selection";

function missingFunction() {
  return Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("undefined function"), { code: "42883" }),
  });
}

beforeEach(() => {
  execute.mockReset();
});

describe("workspace selection rollout", () => {
  it("hides switching until the additive functions are migrated", async () => {
    execute.mockRejectedValue(missingFunction());
    await expect(listUserWorkspaces("user_1")).resolves.toEqual([]);
    await expect(
      hasUserWorkspaceMembership("user_1", "ws_second"),
    ).resolves.toBe(false);
  });

  it("surfaces unrelated database errors", async () => {
    execute.mockRejectedValue(new Error("connection lost"));
    await expect(listUserWorkspaces("user_1")).rejects.toThrow(
      "connection lost",
    );
  });
});
