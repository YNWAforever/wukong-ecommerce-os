import { eq } from "drizzle-orm";
import { workspaceProfileSchema, type WorkspaceProfile } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { workspaces } from "../schema.js";

export type WorkspaceRepository = {
  requireProfile(): Promise<WorkspaceProfile>;
  updateProfile(profile: WorkspaceProfile): Promise<void>;
};

export function createWorkspaceRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceRepository {
  return {
    async requireProfile() {
      scope.assertOpen();
      const [workspace] = await transaction
        .select({ profile: workspaces.profile })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace) throw new Error("workspace not found");
      return workspaceProfileSchema.parse(workspace.profile);
    },
    async updateProfile(profile) {
      scope.assertOpen();
      const parsed = workspaceProfileSchema.parse(profile);
      const updated = await transaction
        .update(workspaces)
        .set({ profile: parsed })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      if (updated.length !== 1) throw new Error("workspace not found");
    },
  };
}
