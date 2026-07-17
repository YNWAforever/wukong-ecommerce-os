import { describe, expect, it, vi } from "vitest";

import { opakProfile, seedOpak, type OpakSeedStore } from "./seed-opak.js";

describe("Opak pilot seed", () => {
  it("defines the approved HKD bilingual premium claim policy", () => {
    expect(opakProfile.currency).toBe("HKD");
    expect(opakProfile.locales).toEqual(["en", "zh-Hant"]);
    expect(opakProfile.tone.toLowerCase()).toContain("premium");
    expect(opakProfile.tone.toLowerCase()).toContain("non-exaggerated");
    expect(opakProfile.claimPolicy).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ratings"),
        expect.stringContaining("awards"),
        expect.stringContaining("health"),
        expect.stringContaining("superlatives"),
      ]),
    );
  });

  it("upserts deterministically and never handles passwords or tokens", async () => {
    const store: OpakSeedStore = {
      upsertWorkspace: vi.fn(async () => "ws_opak"),
      upsertUser: vi.fn(async () => "user_opak_operator"),
      upsertMembership: vi.fn(async () => undefined),
      upsertProfile: vi.fn(async () => undefined),
      upsertPromptVersion: vi.fn(async () => undefined),
      upsertInvite: vi.fn(async () => undefined),
    };
    const first = await seedOpak(store, "laichiwillyjp@gmail.com");
    const second = await seedOpak(store, "laichiwillyjp@gmail.com");
    expect(first.promptVersion).toBe("1.0.0");
    expect(second).toEqual(first);
    expect(store.upsertWorkspace).toHaveBeenCalledTimes(2);
    expect(store.upsertUser).toHaveBeenCalledWith({ id: "user_opak_operator", email: "laichiwillyjp@gmail.com" });
    for (const call of vi.mocked(store.upsertUser).mock.calls) {
      expect(Object.keys(call[0]).sort()).toEqual(["email", "id"]);
      expect(call[0]).not.toHaveProperty("password");
    }
    expect(store.upsertMembership).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_opak", userId: "user_opak_operator", role: "operator" }),
    );
    expect(store.upsertInvite).toHaveBeenCalledWith({
      workspaceId: "ws_opak",
      email: "laichiwillyjp@gmail.com",
      role: "operator",
      status: "pending",
    });
  });

  it("rejects malformed operator emails", async () => {
    const store = {} as OpakSeedStore;
    await expect(seedOpak(store, "not-an-email")).rejects.toThrow(/email/i);
  });
});
