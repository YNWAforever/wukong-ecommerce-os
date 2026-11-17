import { describe, expect, it } from "vitest";

import type { StudioSessionDeps } from "./session";
import { createStudioOnboardingService } from "./onboarding-service";

const SETTINGS = {
  workspaceId: "workspace",
  enabled: true,
  allowedSkills: [],
  monthlyBudgetUsd: null,
  runCeilingUsd: null,
  retentionDays: null,
  defaultHome: false,
  ai: null,
};

const COUNTS = {
  received: 2,
  processing: 0,
  needs_info: 0,
  in_review: 0,
  approved: 1,
  reopened: 0,
  publishing: 0,
  published: 0,
  publish_failed: 0,
  failed: 0,
};

function createDeps(
  options: {
    failOutputs?: boolean;
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  } = {},
): StudioSessionDeps {
  const role = options.role ?? "owner";
  const repos = {
    workspaces: {
      readinessObservations: async () => ({ connectionPresent: true }),
    },
    memberships: {
      listForWorkspace: async () => [
        { userId: "owner", role: "owner" },
        { userId: "reviewer", role: "reviewer" },
      ],
      listInvites: async () => [{ id: "invite-1" }],
    },
    listings: { countByStatus: async () => COUNTS },
    studio: {
      settings: { get: async () => SETTINGS },
      outputs: {
        list: async (input?: { status?: string }) => {
          if (options.failOutputs) throw new Error("outputs down");
          return {
            items: input?.status === "signed_off" ? [] : [{ id: "artifact-1" }],
            truncated: false,
          };
        },
      },
    },
    exportAttempts: { listForWorkspace: async () => [{ id: "export-1" }] },
  };
  return {
    sessionContext: {
      resolve: async () => ({
        workspaceId: "workspace",
        actorId: "actor",
        role,
      }),
    } as StudioSessionDeps["sessionContext"],
    getDatabase: () =>
      ({
        forWorkspace: async (
          _workspaceId: string,
          callback: (value: typeof repos) => unknown,
        ) => callback(repos),
      }) as unknown as ReturnType<StudioSessionDeps["getDatabase"]>,
    isStudioEnabled: () => true,
    env: {},
  };
}

describe("studioOnboardingService", () => {
  it("reduces durable records to step states and counts only", async () => {
    const service = createStudioOnboardingService(createDeps());
    const result = await service.onboarding();
    expect(result.status).toBe("ready");
    expect(result.done).toBe(5);
    expect(result.steps.find((step) => step.key === "signoff")?.state).toBe(
      "todo",
    );
    expect(result.steps.find((step) => step.key === "store")?.state).toBe(
      "done",
    );
  });

  it("marks only the unreadable source unknown and keeps the rest of the card", async () => {
    const service = createStudioOnboardingService(
      createDeps({ failOutputs: true }),
    );
    const result = await service.onboarding();
    expect(result.unknown).toBe(2);
    expect(result.done).toBe(4);
    expect(result.status).toBe("ready");
  });

  it("reports seats, pending invites and catalog size for an admin", async () => {
    const service = createStudioOnboardingService(createDeps());
    await expect(service.planUsage()).resolves.toEqual({
      members: 2,
      pendingInvites: 1,
      catalog: 3,
    });
  });

  it("gates plan usage to administrators", async () => {
    const service = createStudioOnboardingService(
      createDeps({ role: "operator" }),
    );
    await expect(service.planUsage()).rejects.toMatchObject({ status: 403 });
  });
});
