import { describe, expect, it } from "vitest";

import { ROLE_LABELS } from "./shell-nav-items.js";
import {
  FALLBACK_WORKSPACE_NAME,
  resolveWorkspaceChrome,
} from "./workspace-chrome.js";

describe("resolveWorkspaceChrome", () => {
  it("falls back to the generic workspace name and the viewer role label when there is no session", async () => {
    const result = await resolveWorkspaceChrome(null);
    expect(result.workspaceName).toBe(FALLBACK_WORKSPACE_NAME);
    expect(result.roleLabel).toEqual(ROLE_LABELS.viewer);
  });

  it("returns the workspace profile's name and the session's role label on success", async () => {
    const requireProfile = async () => ({ name: "Distinct Test Workspace" });
    const result = await resolveWorkspaceChrome(
      { workspaceId: "ws_opak", role: "admin" },
      {
        getDatabase: () =>
          ({
            forWorkspace: async (_id: string, work: any) =>
              work({ workspaces: { requireProfile } }),
          }) as any,
      },
    );
    expect(result.workspaceName).toBe("Distinct Test Workspace");
    expect(result.roleLabel).toEqual(ROLE_LABELS.admin);
  });

  it("degrades to the fallback workspace name, without throwing, when the workspace-profile read fails", async () => {
    const result = await resolveWorkspaceChrome(
      { workspaceId: "ws_opak", role: "operator" },
      {
        getDatabase: () =>
          ({
            forWorkspace: async () => {
              throw new Error("connection refused");
            },
          }) as any,
      },
    );
    expect(result.workspaceName).toBe(FALLBACK_WORKSPACE_NAME);
    // The role label still comes from the session, which is already
    // resolved and doesn't depend on the failing DB read.
    expect(result.roleLabel).toEqual(ROLE_LABELS.operator);
  });
});
