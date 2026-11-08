import { createHash } from "node:crypto";

import type { Database } from "@wukong/db";

/**
 * Versioned Studio output artifacts (plan Task 9).
 *
 * A copy proposal is stored as an immutable artifact version with a canonical
 * digest and a readback check. It never writes canonical listing data; the
 * existing listing review screen remains the only place an operator can apply
 * any proposed change.
 */

export type StudioOutputDeps = {
  getDatabase: () => Pick<Database, "forWorkspace">;
};

export type CopyProposalPayload = {
  listingId: string;
  activeVersionId: string;
  activeVersionSequence: number;
  fields: Array<{
    field: string;
    current: string | null;
    proposed: string;
    evidenceRefs: string[];
  }>;
  limitations: string[];
  asOf: string;
};

export type CreatedOutput = {
  outputId: string;
  revision: number;
  contentDigest: string;
};

/** Stable JSON with sorted object keys, so the digest is reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function copyProposalDigest(payload: CopyProposalPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function createCopyProposalOutput(
  deps: StudioOutputDeps,
  input: {
    workspaceId: string;
    actorId: string;
    threadId: string;
    runId: string;
    title: string;
    payload: CopyProposalPayload;
    asOf: Date;
  },
): Promise<CreatedOutput> {
  const contentDigest = copyProposalDigest(input.payload);
  const scope = {
    listingId: input.payload.listingId,
    activeVersionId: input.payload.activeVersionId,
    activeVersionSequence: input.payload.activeVersionSequence,
  };
  return deps.getDatabase().forWorkspace(input.workspaceId, async (repos) => {
    const output = await repos.studio.outputs.create({
      threadId: input.threadId,
      runId: input.runId,
      kind: "copy_proposal",
      title: input.title.slice(0, 200),
      createdBy: input.actorId,
    });
    const written = await repos.studio.outputs.addVersion({
      outputId: output.id,
      payload: input.payload as unknown as Record<string, unknown>,
      contentDigest,
      asOf: input.asOf,
      scope,
      createdBy: input.actorId,
    });
    // Completion is a persisted readback, not the in-memory write result.
    const readback = await repos.studio.outputs.get(output.id);
    const versions = await repos.studio.outputs.versions(output.id);
    const latest = versions.find(
      (version) => version.revision === written.version.revision,
    );
    if (
      !readback ||
      readback.currentVersion !== written.version.revision ||
      !latest ||
      latest.contentDigest !== contentDigest
    )
      throw new Error("studio_output_readback_mismatch");
    await repos.audit.write({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: output.id,
      action: "studio.output.proposed",
      metadata: {
        outputId: output.id,
        runId: input.runId,
        kind: "copy_proposal",
        revision: written.version.revision,
        contentDigest,
        listingId: input.payload.listingId,
        activeVersionId: input.payload.activeVersionId,
        fieldCount: input.payload.fields.length,
      },
    });
    return {
      outputId: output.id,
      revision: written.version.revision,
      contentDigest,
    };
  });
}
