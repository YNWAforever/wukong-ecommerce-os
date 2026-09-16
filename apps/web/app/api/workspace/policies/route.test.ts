import { describe, it, expect, vi } from "vitest";
import { createPolicyHandlers } from "./route";
const policy = {
  name: "Second shop",
  tone: "Plain",
  claimPolicy: [],
  requiredFields: ["stockQuantity"],
  sourcePreferences: { allowedDomains: ["producer.example"] },
};
function fixture(role = "admin") {
  const profile = {
    ...policy,
    currency: "HKD",
    locales: ["en", "zh-Hant"],
    brandBackgroundColor: null,
  };
  const repos = {
    workspaces: {
      requireProfile: vi.fn().mockResolvedValue(profile),
      updateSettings: vi.fn().mockResolvedValue(profile),
      usageSummary: vi.fn().mockResolvedValue({
        heldUsd: "1.00",
        unknownHeldUsd: "2.00",
        settledUsd: "0.10",
        unknownRuns: 1,
        physicalCalls: 3,
      }),
    },
    audit: { write: vi.fn() },
  };
  const scope = vi.fn(async (_workspace: string, work: any) => work(repos));
  const handlers = createPolicyHandlers({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "second-workspace",
        actorId: "admin",
        role,
      }),
    } as never,
    getDatabase: () => ({ forWorkspace: scope }) as never,
  });
  return { handlers, repos, scope };
}
const request = (body: unknown) =>
  new Request("http://localhost/api/workspace/policies", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
describe("tenant policy boundary", () => {
  it("uses the session workspace and exposes unknown holds separately", async () => {
    const { handlers, scope } = fixture();
    const response = await handlers.GET(new Request("http://localhost"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(scope.mock.calls[0]?.[0]).toBe("second-workspace");
    expect(body.usage.unknownHeldUsd).toBe("2.00");
    expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.admission.enabled).toBe(false);
  });
  it("rejects a reviewer and tenant/capability injection before write", async () => {
    const reader = fixture("reviewer");
    expect(
      (
        await reader.handlers.PATCH(
          request({ expectedDigest: "a".repeat(64), policy }),
        )
      ).status,
    ).toBe(403);
    expect(reader.scope).not.toHaveBeenCalled();
    const admin = fixture();
    expect(
      (
        await admin.handlers.PATCH(
          request({
            expectedDigest: "a".repeat(64),
            policy: { ...policy, listingAi: {}, workspaceId: "other" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(admin.repos.workspaces.updateSettings).not.toHaveBeenCalled();
  });
  it("returns a conflict without overwriting a newer policy", async () => {
    const { handlers, repos } = fixture();
    repos.workspaces.updateSettings.mockRejectedValue(
      Object.assign(new Error("stale"), { code: "workspace_policy_conflict" }),
    );
    expect(
      (
        await handlers.PATCH(
          request({ expectedDigest: "a".repeat(64), policy }),
        )
      ).status,
    ).toBe(409);
    expect(repos.audit.write).not.toHaveBeenCalled();
  });
  it("audits selected fields without writing another tenant's policy", async () => {
    const { handlers, repos } = fixture();
    expect(
      (
        await handlers.PATCH(
          request({ expectedDigest: "a".repeat(64), policy }),
        )
      ).status,
    ).toBe(200);
    expect(repos.workspaces.updateSettings).toHaveBeenCalledWith(
      policy,
      "a".repeat(64),
    );
    expect(repos.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "second-workspace",
        action: "workspace.policy_updated",
      }),
    );
  });
});
