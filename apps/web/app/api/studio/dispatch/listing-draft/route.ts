import { getSkill, skillsForRole } from "@wukong/core";
import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  createListingIntake,
  type ListingIntakeDeps,
} from "../../../../../lib/listing-intake-service";
import {
  listingPublisher,
  type ListingPublisher,
} from "../../../../../lib/listing-queue-runtime";
import {
  acceptSourceWithoutDecoding,
  requestProductShotFromProcess,
  type ProductShotRequestInput,
  type ProductShotRequestResult,
} from "../../../../../lib/product-shot-request";
import {
  ApiError,
  jsonResponse,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import {
  studioServiceDeps,
  type StudioRouteDeps,
} from "../../../../../lib/studio/route-deps";
import {
  requireStudioSession,
  studioNotFound,
} from "../../../../../lib/studio/session";
import { translatedLine } from "../../../../../lib/studio/types";
import type { preflightWineCapability } from "../../../../../lib/wine-capability-client";

/**
 * `POST /api/studio/dispatch/listing-draft` (plan Task 10).
 *
 * The only path that creates canonical listing data from Studio. It requires an
 * operator+, a visible thread, an explicit `confirmed: true` and at least one
 * owned source asset id, then calls the same extracted intake service the
 * listings route uses — never the listings route module itself (its product-shot
 * import chain is what the sharp-bundling guard watches).
 *
 * The response reports the honest queue outcome: `enqueued` only when the
 * queue confirmed the job, `queue_unavailable` when the listing exists but
 * processing has not started. Nothing here or in the turn can dispatch
 * automatically; a model or tool cannot call this route with a session.
 */

const UUID = z.string().uuid();

export const studioDispatchBodySchema = z.strictObject({
  threadId: UUID,
  /** The assistant turn that prepared this dispatch, for the trace event. */
  runId: UUID.optional(),
  assetIds: z
    .array(UUID)
    .min(1)
    .max(8)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Asset ids must be unique.",
    ),
  note: z.string().max(2000).optional(),
  skillKey: z.literal("listing.draft_from_sources").optional(),
  confirmed: z.literal(true),
});
export type StudioDispatchBody = z.infer<typeof studioDispatchBodySchema>;

export type StudioDispatchRouteDeps = StudioRouteDeps & {
  publisher: ListingPublisher;
  preflightWineCapability?: typeof preflightWineCapability;
  requestProductShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
};

const PRIVATE_THREAD_ADMIN_ROLES: readonly string[] = ["admin", "owner"];

export function createStudioDispatchHandler(deps: StudioDispatchRouteDeps) {
  const intakeDeps = (): ListingIntakeDeps => ({
    getDatabase: deps.getDatabase,
    publisher: deps.publisher,
    ...(deps.preflightWineCapability
      ? { preflightWineCapability: deps.preflightWineCapability }
      : {}),
    ...(deps.requestProductShot
      ? { requestProductShot: deps.requestProductShot }
      : {}),
  });

  return async function dispatchListingDraft(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      // Session, workspace settings and flags come before any body parsing or
      // domain read; a disabled Studio or a viewer never reaches the intake.
      const { session, settings, role } = await requireStudioSession(
        studioServiceDeps(deps),
        "operator",
      );

      let json: unknown;
      try {
        json = await request.json();
      } catch {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const parsed = studioDispatchBodySchema.safeParse(json);
      if (!parsed.success)
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      const body = parsed.data;

      const skill = getSkill(body.skillKey ?? "listing.draft_from_sources");
      if (!skill || skill.status !== "pilot")
        throw new ApiError(
          400,
          "skill_unavailable",
          "This skill is not available.",
        );
      if (
        settings.allowedSkills.length > 0 &&
        !settings.allowedSkills.includes(skill.key)
      )
        throw new ApiError(
          403,
          "skill_not_allowed",
          "This skill is not enabled for the workspace.",
        );
      if (!skillsForRole(role).some((entry) => entry.key === skill.key))
        throw new ApiError(403, "insufficient_role", "Insufficient role.");

      const bundle = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repos) =>
          repos.studio.threads.getWithMessages(body.threadId, {
            messageLimit: 1,
          }),
        );
      if (!bundle) throw studioNotFound();
      if (
        bundle.thread.visibility === "private" &&
        bundle.thread.createdBy !== session.actorId &&
        !PRIVATE_THREAD_ADMIN_ROLES.includes(role)
      )
        throw studioNotFound();
      const runId = body.runId;
      if (runId) {
        const run = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, (repos) =>
            repos.studio.runs.get(runId),
          );
        if (!run || run.threadId !== body.threadId) throw studioNotFound();
      }

      const result = await createListingIntake(intakeDeps(), {
        context: session,
        body: {
          sourceAssetIds: body.assetIds.map((id) => id.toLowerCase()),
          note: body.note ?? "",
          processingMode: "ai",
        },
        // The asset set is the natural idempotency key for asset-backed
        // creates; no client-supplied key is trusted here.
        requestKey: null,
      });

      // A reused asset set is a lost-response retry of the same dispatch: the
      // response says so honestly and the audit/trace are not duplicated, even
      // though the intake path re-enqueues (its original behaviour).
      const replayed =
        result.replayed === true || result.reusedExisting === true;

      if (!replayed) {
        await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repos) => {
            await repos.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: result.listing.id,
              action: "studio.dispatch.listing_draft",
              metadata: {
                threadId: body.threadId,
                listingId: result.listing.id,
                runId: result.processing?.runId ?? null,
                queueState: result.queueState,
                assetCount: body.assetIds.length,
                skillKey: skill.key,
              },
            });
            if (runId) {
              await repos.studio.runEvents.appendMany(runId, [
                {
                  kind: "dispatch",
                  state: "done",
                  toolId: null,
                  payload: translatedLine("studio.trace.dispatch.done", {
                    listingId: result.listing.id,
                    queueState: result.queueState,
                  }),
                  durationMs: null,
                },
              ]);
            }
          });
      }

      return jsonResponse(200, {
        listingId: result.listing.id,
        runId: result.processing?.runId ?? null,
        queueState: result.queueState,
        replayed,
      });
    });
  };
}

const handler = createStudioDispatchHandler({
  sessionContext: authSessionContext,
  getDatabase,
  publisher: listingPublisher,
  requestProductShot: (input) =>
    requestProductShotFromProcess(input, acceptSourceWithoutDecoding),
});

export const POST = handler;
