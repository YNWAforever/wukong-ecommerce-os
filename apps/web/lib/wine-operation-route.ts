import { z } from "zod";
import { sectionKeySchema } from "@wukong/core";
import type { Database } from "@wukong/db";
import { acceptListingOperation } from "./listing-operation-service";
import { prepareWineAdmission } from "./wine-enrichment-service";
import { preflightWineCapability } from "./wine-capability-client";
import { dispatchListingOperation } from "./dispatch-listing-operation";
import { requireListingRecovery } from "./listing-recovery-readiness";
import type { ListingPublisher } from "./listing-queue-runtime";
import type { SessionContextPort } from "./session-context-port";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "./route-support";
const uuid = z.uuid().transform((value) => value.toLowerCase());
const guard = {
  expectedInputRevision: z.number().int().positive(),
  baseVersionId: uuid.nullable(),
};
const operation = z
  .object({ ...guard, mode: z.enum(["full", "research"]) })
  .strict();
const regenerate = z
  .object({
    ...guard,
    mode: z.enum(["copy", "section"]),
    section: sectionKeySchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.mode === "section") === (value.section !== undefined),
    { message: "Select exactly one section for section processing." },
  );
export function createWineOperationHandler(
  deps: {
    sessionContext: SessionContextPort;
    getDatabase: () => Pick<Database, "forWorkspace">;
    publisher?: ListingPublisher;
    preflightWineCapability?: typeof preflightWineCapability;
    acceptProcessing?: typeof acceptListingOperation;
  },
  action: "operation" | "regenerate",
) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!["operator", "reviewer", "admin", "owner"].includes(session.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const rawId = (await context.params).id;
      if (!uuid.safeParse(rawId).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const id = rawId.toLowerCase();
      const body = (action === "operation" ? operation : regenerate).parse(
        await request.json(),
      );
      const operationKey = uuid.parse(request.headers.get("Idempotency-Key"));
      const database = deps.getDatabase();
      await requireListingRecovery(database);
      const admission = await prepareWineAdmission(
        database,
        session.workspaceId,
        body.mode,
        deps.preflightWineCapability,
      );
      const accepted = await database.forWorkspace(
        session.workspaceId,
        (repos) =>
          (deps.acceptProcessing ?? acceptListingOperation)(
            repos,
            {
              ...session,
              listingId: id,
              expectedInputRevision: body.expectedInputRevision,
              baseVersionId: body.baseVersionId,
              operationKey,
              wineMode: body.mode,
              wineOnly: true,
              ...("section" in body ? { wineSection: body.section } : {}),
            },
            admission,
          ),
      );
      if (deps.publisher)
        await dispatchListingOperation(
          database,
          session.workspaceId,
          accepted,
          deps.publisher,
        );
      return jsonResponse(202, { processing: accepted.processing });
    });
}
