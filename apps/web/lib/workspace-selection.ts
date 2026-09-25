import { sql } from "drizzle-orm";

export const WORKSPACE_COOKIE_NAME = "wukong_workspace";

export type WorkspaceOption = { id: string; name: string };

export function isMissingWorkspaceSelectionFunction(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") return false;
    if ("code" in current && current.code === "42883") return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export async function listUserWorkspaces(
  userId: string,
): Promise<WorkspaceOption[]> {
  const { getAuthDatabase } = await import("../auth");
  try {
    const rows = await getAuthDatabase().execute<{
      workspace_id: string;
      name: string;
    }>(
      sql`select workspace_id, name from auth_list_user_workspaces(${userId})`,
    );
    return rows.map((row) => ({ id: row.workspace_id, name: row.name }));
  } catch (error) {
    if (isMissingWorkspaceSelectionFunction(error)) return [];
    throw error;
  }
}

export async function hasUserWorkspaceMembership(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const { getAuthDatabase } = await import("../auth");
  try {
    const rows = await getAuthDatabase().execute<{ workspace_id: string }>(
      sql`select workspace_id from auth_get_active_membership(${userId}, ${workspaceId})`,
    );
    return rows[0]?.workspace_id === workspaceId;
  } catch (error) {
    if (isMissingWorkspaceSelectionFunction(error)) return false;
    throw error;
  }
}
