import { sql } from "drizzle-orm";

export const WORKSPACE_COOKIE_NAME = "wukong_workspace";

export type WorkspaceOption = { id: string; name: string };

export async function listUserWorkspaces(
  userId: string,
): Promise<WorkspaceOption[]> {
  const { getAuthDatabase } = await import("../auth");
  const rows = await getAuthDatabase().execute<{
    workspace_id: string;
    name: string;
  }>(sql`select workspace_id, name from auth_list_user_workspaces(${userId})`);
  return rows.map((row) => ({ id: row.workspace_id, name: row.name }));
}

export async function hasUserWorkspaceMembership(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const { getAuthDatabase } = await import("../auth");
  const rows = await getAuthDatabase().execute<{ workspace_id: string }>(
    sql`select workspace_id from auth_get_active_membership(${userId}, ${workspaceId})`,
  );
  return rows[0]?.workspace_id === workspaceId;
}
