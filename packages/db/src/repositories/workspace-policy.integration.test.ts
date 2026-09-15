import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { workspaceProfileSchema } from "@wukong/core";
import { createDatabase } from "../index.js";
describe("second workspace configuration", () => {
  const db = createDatabase(
    process.env.TEST_DATABASE_URL ??
      "postgres://wukong_app:wukong-app-local@localhost:54329/t01_compatibility",
    {
      migrationUrl:
        process.env.TEST_DATABASE_ADMIN_URL ??
        "postgres://wukong:wukong@localhost:54329/t01_compatibility",
    },
  );
  const first = `policy-${randomUUID()}`,
    second = `policy-${randomUUID()}`;
  const profile = workspaceProfileSchema.parse({
    name: "First",
    currency: "HKD",
    locales: ["en", "zh-Hant"],
    tone: "Plain",
    claimPolicy: [],
    requiredFields: [],
  });
  beforeAll(async () => {
    await db.migrate();
    await db.forWorkspace(first, (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    await db.forWorkspace(second, (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    await db.forWorkspace(first, (repos) =>
      repos.workspaces.updateProfile(profile),
    );
    await db.forWorkspace(second, (repos) =>
      repos.workspaces.updateProfile({ ...profile, name: "Second" }),
    );
  });
  afterAll(() => db.close());
  it("saves isolated policy through the app role and rejects stale writes", async () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(profile))
      .digest("hex");
    await db.forWorkspace(first, (repos) =>
      repos.workspaces.updateSettings(
        {
          tone: "Clear and concise",
          requiredFields: ["stockQuantity"],
          sourcePreferences: { allowedDomains: ["producer.example"] },
        },
        digest,
      ),
    );
    await expect(
      db.forWorkspace(first, (repos) =>
        repos.workspaces.updateSettings({ tone: "stale" }, digest),
      ),
    ).rejects.toMatchObject({ code: "workspace_policy_conflict" });
    expect(
      (
        await db.forWorkspace(second, (repos) =>
          repos.workspaces.requireProfile(),
        )
      ).tone,
    ).toBe("Plain");
    await db.forWorkspace(first, (repos) =>
      repos.workspaces.updateSettings({ brandBackgroundColor: "#112233" }),
    );
    const stored = await db.forWorkspace(first, (repos) =>
      repos.workspaces.requireProfile(),
    );
    expect(stored.tone).toBe("Clear and concise");
    expect(stored.requiredFields).toEqual(["stockQuantity"]);
  });
  it("does not include another workspace's reservation usage", async () => {
    expect(
      await db.forWorkspace(second, (repos) => repos.workspaces.usageSummary()),
    ).toMatchObject({
      heldUsd: "0",
      unknownHeldUsd: "0",
      settledUsd: "0",
      unknownRuns: 0,
      physicalCalls: 0,
    });
  });
});
