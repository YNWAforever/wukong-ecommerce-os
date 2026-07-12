import { eq } from "drizzle-orm";
import { workspaceProfileSchema, type WorkspaceProfile } from "@wukong/core";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { workspaces } from "../schema.js";

export type WorkspaceRepository = { requireProfile(): Promise<WorkspaceProfile> };

export function createWorkspaceRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WorkspaceRepository {
  return {
    async requireProfile() {
      scope.assertOpen();
      const [workspace] = await transaction.select({ profile: workspaces.profile }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (!workspace) throw new Error("workspace not found");
      return workspaceProfileSchema.parse(workspace.profile);
    },
  };
}