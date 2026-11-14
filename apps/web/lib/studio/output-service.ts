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

/** Artifact kinds the Studio persists as versioned, digest-verified outputs. */
export type ReportOutputKind = "merchant_audit" | "gap_report" | "finding";

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

export function outputPayloadDigest(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function copyProposalDigest(payload: CopyProposalPayload): string {
  return outputPayloadDigest(payload);
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

/**
 * Persist a generic report artifact (plan Task 11).
 *
 * Same invariants as `createCopyProposalOutput`: one immutable version, a
 * canonical SHA-256 digest, and a readback check before the caller is told the
 * artifact exists. It never writes canonical listing data — a report is an
 * artifact, and applying anything still happens in the existing screens.
 */
export async function createReportOutput(
  deps: StudioOutputDeps,
  input: {
    workspaceId: string;
    actorId: string;
    threadId?: string | null;
    runId?: string | null;
    kind: ReportOutputKind;
    title: string;
    payload: Record<string, unknown>;
    asOf: Date;
    scope?: Record<string, unknown>;
  },
): Promise<CreatedOutput> {
  const contentDigest = createHash("sha256")
    .update(canonicalJson(input.payload))
    .digest("hex");
  const scope = input.scope ?? { workspaceScoped: true };
  return deps.getDatabase().forWorkspace(input.workspaceId, async (repos) => {
    const output = await repos.studio.outputs.create({
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      title: input.title.slice(0, 200),
      createdBy: input.actorId,
    });
    const written = await repos.studio.outputs.addVersion({
      outputId: output.id,
      payload: input.payload,
      contentDigest,
      asOf: input.asOf,
      scope,
      createdBy: input.actorId,
    });
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
        runId: input.runId ?? null,
        kind: input.kind,
        revision: written.version.revision,
        contentDigest,
      },
    });
    return {
      outputId: output.id,
      revision: written.version.revision,
      contentDigest,
    };
  });
}

/**
 * Persist a generic finding artifact (C1).
 *
 * A finding is a read-only, versioned observation (the first is the category
 * mapping proposal). It uses exactly the same digest/readback/audit invariants
 * as the report creator and never writes canonical data.
 */
export async function createFindingOutput(
  deps: StudioOutputDeps,
  input: {
    workspaceId: string;
    actorId: string;
    threadId?: string | null;
    runId?: string | null;
    title: string;
    payload: Record<string, unknown>;
    asOf: Date;
    scope?: Record<string, unknown>;
  },
): Promise<CreatedOutput> {
  return createReportOutput(deps, { ...input, kind: "finding" });
}
