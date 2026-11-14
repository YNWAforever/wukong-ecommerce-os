import type { SessionContextPort } from "../session-context-port";
import { parseCopyProposalPayload } from "./copy-proposal";
import { outputDigestMatches, proposalFreshness } from "./output-review";
import { buildStudioReadDeps } from "./read-deps";
import { studioServiceDeps } from "./route-deps";
import type { StudioDatabase } from "./session";
import { createStudioService } from "./turn-service";

/** Display-only proposal snapshot; it never seeds or writes the review form. */
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
  state: "current" | "stale" | "unpinned" | "unavailable";
  sourceHref: string;
  fields: ListingStudioHandoffField[];
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type ListingStudioHandoffDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => StudioDatabase;
  env?: NodeJS.ProcessEnv;
};

/** Exact links never retarget to the newest version; old ID-only links are labelled unpinned. */
export function copyProposalHandoffFromBundle(input: {
  listingId: string;
  pin?: { revision: number; digest: string };
  currentListingVersion?: { versionId: string; sequence: number } | null;
  bundle: {
    output: {
      outputId: string;
      kind: string;
      title: string;
      currentVersion?: number;
      threadId?: string | null;
    };
    versions: ReadonlyArray<{
      revision: number;
      payload: Record<string, unknown>;
      asOf: string;
      contentDigest?: string;
    }>;
  };
}): ListingStudioHandoff | undefined {
  const { listingId, bundle, pin } = input;
  if (bundle.output.kind !== "copy_proposal" || bundle.versions.length === 0)
    return undefined;
  const latest = bundle.versions.reduce((current, version) =>
    version.revision > current.revision ? version : current,
  );
  const requested = pin
    ? bundle.versions.find((version) => version.revision === pin.revision)
    : latest;
  const proposal = parseCopyProposalPayload((requested ?? latest).payload);
  if (!proposal || proposal.listingId !== listingId) return undefined;
  let state: ListingStudioHandoff["state"] = "unpinned";
  if (pin) {
    if (
      !requested ||
      requested.contentDigest !== pin.digest ||
      !outputDigestMatches(requested)
    )
      state = "unavailable";
    else if (bundle.output.currentVersion !== requested.revision)
      state = "stale";
    else
      state = proposalFreshness(
        requested.payload,
        input.currentListingVersion ?? null,
      );
  }
  return {
    outputId: bundle.output.outputId,
    title: bundle.output.title,
    revision: pin?.revision ?? latest.revision,
    asOf: requested?.asOf ?? "",
    state,
    sourceHref: bundle.output.threadId
      ? `/studio/t/${encodeURIComponent(bundle.output.threadId)}`
      : "/studio/outputs",
    fields:
      state === "unavailable"
        ? []
        : proposal.fields.map((field) => ({
            field: field.field,
            current: field.current,
            proposed: field.proposed,
          })),
  };
}

/** Invalid/foreign references fail closed; known outdated versions show an explicit read-only state. */
export async function loadListingStudioHandoff(input: {
  listingId: string;
  studioOutput: string | undefined;
  studioRevision?: string | undefined;
  studioDigest?: string | undefined;
  deps: ListingStudioHandoffDeps;
}): Promise<ListingStudioHandoff | undefined> {
  const studioOutput = input.studioOutput?.trim();
  if (!studioOutput || !UUID.test(studioOutput)) return undefined;
  let pin: { revision: number; digest: string } | undefined;
  if (input.studioRevision !== undefined || input.studioDigest !== undefined) {
    const revision = Number(input.studioRevision);
    if (
      !input.studioRevision ||
      !/^[1-9]\d*$/.test(input.studioRevision) ||
      !Number.isSafeInteger(revision) ||
      !input.studioDigest ||
      !/^[a-f0-9]{64}$/.test(input.studioDigest)
    )
      return undefined;
    pin = { revision, digest: input.studioDigest };
  }
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
    const listing = pin
      ? await input.deps
          .getDatabase()
          .forWorkspace(session.workspaceId, (repos) =>
            buildStudioReadDeps(repos).getListing(input.listingId),
          )
      : null;
    return copyProposalHandoffFromBundle({
      listingId: input.listingId,
      bundle,
      ...(pin
        ? { pin, currentListingVersion: listing?.activeVersion ?? null }
        : {}),
    });
  } catch {
    // This optional integration must not prevent the existing listing review page from loading.
    console.info(
      JSON.stringify({
        event: "studio.handoff.unavailable",
        category: "lookup_failed",
      }),
    );
    return undefined;
  }
}
