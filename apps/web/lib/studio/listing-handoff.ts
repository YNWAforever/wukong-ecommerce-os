import type { SessionContextPort } from "../session-context-port";
import { parseCopyProposalPayload } from "./copy-proposal";
import { studioServiceDeps } from "./route-deps";
import type { StudioDatabase } from "./session";
import { createStudioService } from "./turn-service";

/**
 * Read-only Studio copy-proposal handoff for the existing listing review page
 * (B2).
 *
 * The review page accepts an optional `studioOutput` query id. This resolver
 * turns that id into a minimal banner payload only when every condition holds:
 *
 *  - the id is a UUID (anything else is ignored before touching the database);
 *  - the caller has a session and the Studio is enabled for this workspace;
 *  - the artifact exists in that same workspace (the scoped service 404s a
 *    foreign id, exactly like the API);
 *  - the artifact kind is `copy_proposal` and its payload parses;
 *  - the payload names this same listing.
 *
 * Every lookup error, foreign/disabled/invalid case returns `undefined`, so
 * the page renders exactly as it did before. The handoff is display-only: it
 * never writes canonical data and is not used to seed the review form.
 */

export type ListingStudioHandoffField = {
  field: string;
  current: string | null;
  proposed: string;
};

export type ListingStudioHandoff = {
  outputId: string;
  title: string;
  revision: number;
  asOf: string;
  fields: ListingStudioHandoffField[];
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ListingStudioHandoffDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => StudioDatabase;
  /** Injectable env so tests never mutate `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Pure projection from a loaded output bundle to the banner payload.
 *
 * Kept separate from the service call so the validation rules can be tested
 * without a database or session.
 */
export function copyProposalHandoffFromBundle(input: {
  listingId: string;
  bundle: {
    output: { outputId: string; kind: string; title: string };
    versions: ReadonlyArray<{
      revision: number;
      payload: Record<string, unknown>;
      asOf: string;
    }>;
  };
}): ListingStudioHandoff | undefined {
  const { listingId, bundle } = input;
  if (bundle.output.kind !== "copy_proposal") return undefined;
  if (bundle.versions.length === 0) return undefined;
  const latest = bundle.versions.reduce((current, version) =>
    version.revision > current.revision ? version : current,
  );
  const proposal = parseCopyProposalPayload(latest.payload);
  if (!proposal) return undefined;
  if (proposal.listingId !== listingId) return undefined;
  return {
    outputId: bundle.output.outputId,
    title: bundle.output.title,
    revision: latest.revision,
    asOf: latest.asOf,
    fields: proposal.fields.map((field) => ({
      field: field.field,
      current: field.current,
      proposed: field.proposed,
    })),
  };
}

/**
 * Resolve the optional `studioOutput` query value into a banner payload.
 *
 * Fails closed to `undefined` in every case: not a UUID, no session, disabled
 * Studio, foreign/unknown artifact, wrong kind, invalid payload, wrong listing,
 * or any thrown service/database error.
 */
export async function loadListingStudioHandoff(input: {
  listingId: string;
  studioOutput: string | undefined;
  deps: ListingStudioHandoffDeps;
}): Promise<ListingStudioHandoff | undefined> {
  const studioOutput = input.studioOutput?.trim();
  if (!studioOutput || !UUID.test(studioOutput)) return undefined;
  try {
    const session = await input.deps.sessionContext.resolve();
    if (!session) return undefined;
    const service = createStudioService(
      studioServiceDeps({
        sessionContext: input.deps.sessionContext,
        getDatabase: input.deps.getDatabase,
        ...(input.deps.env ? { env: input.deps.env } : {}),
      }),
    );
    const bundle = await service.getOutput(studioOutput);
    return copyProposalHandoffFromBundle({
      listingId: input.listingId,
      bundle,
    });
  } catch {
    // The review page must never fail because an optional Studio handoff could
    // not be resolved (foreign id, Studio disabled, read error, invalid id).
    return undefined;
  }
}
