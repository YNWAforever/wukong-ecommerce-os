import type { AssignmentMember, WorkspaceRepositories } from "@wukong/db";
import { ApiError } from "./route-support";
import type { SessionContext } from "./session-context-port";
export type WorkspaceAccount = {
  user: Pick<AssignmentMember, "userId" | "email" | "name">;
  role: AssignmentMember["role"];
  contacts: Array<Pick<AssignmentMember, "userId" | "email" | "name">>;
};
export async function readWorkspaceAccount(
  repos: Pick<WorkspaceRepositories, "assignments">,
  context: SessionContext,
): Promise<WorkspaceAccount> {
  const members = await repos.assignments.listActiveMembers();
  const actor = members.find((member) => member.userId === context.actorId);
  if (!actor)
    throw new ApiError(
      401,
      "unauthenticated",
      "Your workspace membership is no longer active.",
    );
  const identity = (member: AssignmentMember) => ({
    userId: member.userId,
    email: member.email,
    name: member.name,
  });
  return {
    user: identity(actor),
    role: actor.role,
    contacts: members
      .filter((member) => member.role === "admin" || member.role === "owner")
      .map(identity),
  };
}
