import { z } from "zod";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  assignmentBulkSchema,
  assignListingItems,
} from "../../../../lib/listing-assignment-service";
import {
  ApiError,
  createRouteDiagnostics,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type AssignmentRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};
export function createAssignmentPostHandler(deps: AssignmentRouteDeps) {
  return async (request: Request) =>
    withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const body = assignmentBulkSchema.parse(await request.json());
      const result = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, (repos) =>
          assignListingItems(repos.assignments, context, body.items),
        );
      return jsonResponse(200, result);
    }, createRouteDiagnostics());
}
export function createAssignmentGetHandler(deps: AssignmentRouteDeps) {
  return async (request: Request) =>
    withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const query = z
        .object({ listingIds: z.string().max(3700).optional().default("") })
        .strict()
        .parse(Object.fromEntries(new URL(request.url).searchParams));
      const ids = query.listingIds
        ? z
            .array(
              z
                .string()
                .uuid()
                .transform((id) => id.toLowerCase()),
            )
            .max(100)
            .parse(query.listingIds.split(","))
        : [];
      const result = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repos) => {
          const [assignments, allMembers] = await Promise.all([
            repos.assignments.getMany(ids),
            repos.assignments.listActiveMembers(),
          ]);
          const actor = allMembers.find(
            (member) => member.userId === context.actorId,
          );
          if (!actor)
            throw new ApiError(
              401,
              "unauthenticated",
              "Your workspace membership is no longer active.",
            );
          return {
            assignments,
            members: allMembers.filter((member) => member.role !== "viewer"),
            actorId: actor.userId,
            role: actor.role,
          };
        });
      return jsonResponse(200, result);
    }, createRouteDiagnostics());
}
export const POST = createAssignmentPostHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
export const GET = createAssignmentGetHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
