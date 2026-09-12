import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  PRODUCT_SHOT_LIMITS,
  usesProductShotWorkflow,
  type ShotCandidate,
  type ShotIdentity,
  type ShotObservation,
} from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import {
  listingDrafts,
  listingVersions,
  memberships,
  productShotAttempts as attempts,
  productShotSelections as selections,
  productShotPublications as publications,
  productShotApprovalUrls as approvalUrls,
  sourceAssets,
} from "../schema.js";
import { createAuditWriter } from "./audit.js";

export const PRODUCT_SHOT_LEASE_MS = 120_000;
type AttemptRow = typeof attempts.$inferSelect;
type PublicationRow = typeof publications.$inferSelect;
export type ProductShotAttempt = ShotIdentity & {
  attemptId: string;
  generation: number;
  state: AttemptRow["state"];
  actorId: string;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  dispatchedAt: Date | null;
  callCount: number;
  estimatedCostUsd: string | null;
  cutoutAssetId: string | null;
  cutoutDigest: string | null;
  candidate: ShotCandidate | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type ProductShotPublication = Omit<PublicationRow, "tokenHash"> & {
  publicationToken: string;
  publicUrl: string;
};
/** Metadata written by trusted byte-validation services, never copied from request JSON. */
export type ProductShotOutputMetadata = {
  role: "product_shot_cutout" | "product_shot_candidate";
  attemptId: string;
  sourceAssetId: string;
  sourceDigest: string;
  providerVersion: string;
  renderVersion: string;
  digest: string;
  mimeType: "image/png" | "image/jpeg";
  size: number;
  width?: number;
  height?: number;
  lowResolution?: boolean;
};
export type ProductShotClaim =
  | { kind: "claimed"; leaseToken: string; sourceAssetId: string }
  | { kind: "skip" | "budget_exhausted" | "outcome_unknown" };
export interface ProductShotRepository {
  requiresWorkflow(input: {
    listingId: string;
    provider?: string;
  }): Promise<boolean>;
  resolveApprovedProductImage(input: {
    workspaceId: string;
    listingId: string;
    versionId: string;
    assetId: string;
  }): Promise<string>;

  ensure(
    input: ShotIdentity & { actorId: string; explicitFreshAttempt: boolean },
  ): Promise<{ attemptId: string }>;
  claim(input: {
    attemptId: string;
    dailyLimit: number;
    now: Date;
    estimatedCostUsd?: number;
  }): Promise<ProductShotClaim>;
  saveCutout(input: {
    attemptId: string;
    leaseToken: string;
    assetId: string;
  }): Promise<void>;
  finishFailure(input: {
    attemptId: string;
    leaseToken: string;
    code: string;
    unknown: boolean;
  }): Promise<void>;
  /**
   * Ends an attempt no worker ever dispatched.
   *
   * `finishFailure` cannot serve this: it requires `processing` and a matching
   * lease token, and an attempt that was never claimed has neither. So a
   * message acknowledged without doing any work left the row `queued` with no
   * terminal state, no error code and no audit event -- the review panel
   * polled it for ever and no sweeper looked at it.
   *
   * The guard is what makes it safe. `queued` with no `dispatchedAt` and no
   * cutout is the proof that no provider call was made and therefore that
   * nothing can have been charged. Anything dispatched keeps flowing through
   * `finishFailure`, which can still reach `outcome_unknown`.
   */
  finishUndispatched(input: {
    attemptId: string;
    code: string;
  }): Promise<"ended" | "skipped">;
  saveCandidate(input: {
    attemptId: string;
    candidate: ShotCandidate;
  }): Promise<void>;
  approve(
    input: ShotObservation & { actorId: string },
  ): Promise<{ publicationToken: string }>;
  revoke(input: { publicationToken: string; actorId: string }): Promise<void>;
  get(attemptId: string): Promise<ProductShotAttempt | null>;
  currentForListing(listingId: string): Promise<ProductShotAttempt | null>;
  approvedForAsset(input: {
    listingId: string;
    versionId: string;
    assetId: string;
  }): Promise<ProductShotPublication | null>;
  /** Call AFTER factual promoteAndApprove, in the SAME forWorkspace transaction.
   * A new immutable URL binds the approved candidate to the promoted version.
   * This method never changes listing status or the historical publication. */
  bindApprovedVersion(input: {
    publicationToken: string;
    expectedVersionId: string;
    versionId: string;
    actorId: string;
  }): Promise<{ publicationToken: string }>;
}

export class ProductShotConflict extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductShotConflict";
  }
}
function conflict(code: string): never {
  throw new ProductShotConflict(code);
}
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function readCandidate(row: AttemptRow): ShotCandidate | null {
  if (!row.candidateAssetId) return null;
  if (
    row.candidateDigest === null ||
    row.candidateWidth === null ||
    row.candidateHeight === null ||
    row.candidateSize === null ||
    row.candidateLowResolution === null
  )
    return conflict("candidate_incomplete");
  return {
    assetId: row.candidateAssetId,
    digest: row.candidateDigest,
    width: row.candidateWidth,
    height: row.candidateHeight,
    size: row.candidateSize,
    lowResolution: row.candidateLowResolution,
  };
}
function readAttempt(row: AttemptRow): ProductShotAttempt {
  const {
    id,
    candidateAssetId: _a,
    candidateDigest: _d,
    candidateWidth: _w,
    candidateHeight: _h,
    candidateSize: _s,
    candidateLowResolution: _l,
    ...rest
  } = row;
  return { ...rest, attemptId: id, candidate: readCandidate(row) };
}
function sameCandidate(a: ShotCandidate, b: ShotCandidate): boolean {
  return (
    a.assetId === b.assetId &&
    a.digest === b.digest &&
    a.width === b.width &&
    a.height === b.height &&
    a.size === b.size &&
    a.lowResolution === b.lowResolution
  );
}
function readPublication(
  row: PublicationRow,
  publicUrl: string,
): ProductShotPublication {
  const { tokenHash: _hash, ...rest } = row;
  return {
    ...rest,
    publicationToken: new URL(publicUrl).pathname.slice(
      "/product-images/".length,
      -4,
    ),
    publicUrl,
  };
}
function publicationUrl(token: string, origin: string | undefined): string {
  let url: URL;
  try {
    url = new URL(origin ?? "");
  } catch {
    return conflict("publication_origin_required");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    return conflict("publication_origin_invalid");
  return new URL("/product-images/" + token + ".jpg", url.origin).href;
}

/** All operations use the caller's short workspace transaction. Never do I/O in it.
 * Lock order: listing review row -> current pointer -> attempt -> daily budget.
 * Holding the listing lock also serializes selection creation when no pointer exists. */
export function createProductShotRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
  publicOrigin?: string,
): ProductShotRepository {
  if (!workspaceId.trim()) throw new Error("workspaceId must not be empty");
  const audit = createAuditWriter(tx, workspaceId, scope);
  const byAttempt = (id: string) =>
    and(eq(attempts.workspaceId, workspaceId), eq(attempts.id, id));
  const byListing = (listingId: string) =>
    and(
      eq(listingDrafts.workspaceId, workspaceId),
      eq(listingDrafts.id, listingId),
    );
  async function event(
    row: Pick<AttemptRow, "id" | "listingId" | "actorId">,
    action: string,
    metadata: Record<string, unknown> = {},
    actorId = row.actorId,
  ) {
    await audit.write({
      workspaceId,
      actorId,
      entityId: row.listingId,
      action: "product_shot." + action,
      metadata: { attemptId: row.id, ...metadata },
    });
  }
  async function authorize(actorId: string, review = false) {
    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, actorId),
        ),
      )
      .for("share");
    const roles = review
      ? ["reviewer", "admin", "owner"]
      : ["operator", "reviewer", "admin", "owner"];
    if (!member || !roles.includes(member.role))
      conflict(review ? "reviewer_role_required" : "operator_role_required");
  }
  async function lockListing(listingId: string) {
    scope.assertOpen();
    const [listing] = await tx
      .select()
      .from(listingDrafts)
      .where(byListing(listingId))
      .for("update");
    if (!listing) return conflict("listing_not_found");
    return listing;
  }
  async function selection(listingId: string) {
    const [selected] = await tx
      .select()
      .from(selections)
      .where(
        and(
          eq(selections.workspaceId, workspaceId),
          eq(selections.listingId, listingId),
        ),
      )
      .for("update");
    return selected ?? null;
  }
  async function lockAttempt(attemptId: string, requireSelected = true) {
    scope.assertOpen();
    const [initial] = await tx
      .select()
      .from(attempts)
      .where(byAttempt(attemptId));
    if (!initial) return conflict("attempt_not_found");
    const listing = await lockListing(initial.listingId);
    const selected = await selection(initial.listingId);
    const [row] = await tx
      .select()
      .from(attempts)
      .where(byAttempt(attemptId))
      .for("update");
    if (!row) return conflict("attempt_not_found");
    if (requireSelected && selected?.attemptId !== row.id)
      return conflict("source_replaced");
    return { row, listing, selected };
  }
  async function source(identity: ShotIdentity) {
    const [asset] = await tx
      .select()
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.listingId, identity.listingId),
          eq(sourceAssets.id, identity.sourceAssetId),
        ),
      )
      .for("share");
    if (
      !asset ||
      !["image/jpeg", "image/png", "image/webp"].includes(asset.kind)
    )
      return conflict("source_asset_invalid");
    const metadata = asset.metadata as Record<string, unknown>;
    if (
      metadata.role === "product_shot_cutout" ||
      metadata.role === "product_shot_candidate" ||
      metadata.role === "product_shot_final"
    )
      conflict("source_asset_invalid");
    // clientSha256 from upload is only a client assertion. Never use it as byte evidence.
    if (
      metadata.verifiedSha256 !== undefined &&
      metadata.verifiedSha256 !== identity.sourceDigest
    )
      conflict("source_digest_changed");
  }
  async function output(
    row: AttemptRow,
    assetId: string,
    role: ProductShotOutputMetadata["role"],
  ) {
    const [asset] = await tx
      .select()
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.listingId, row.listingId),
          eq(sourceAssets.id, assetId),
        ),
      )
      .for("share");
    if (!asset || assetId === row.sourceAssetId)
      return conflict("output_asset_invalid");
    const m = asset.metadata as Record<string, unknown>;
    const mimeType =
      role === "product_shot_cutout" ? "image/png" : "image/jpeg";
    if (
      asset.kind !== mimeType ||
      m.mimeType !== mimeType ||
      m.role !== role ||
      m.attemptId !== row.id ||
      m.sourceAssetId !== row.sourceAssetId ||
      m.sourceDigest !== row.sourceDigest ||
      m.providerVersion !== row.providerVersion ||
      m.renderVersion !== row.renderVersion ||
      !validDigest(m.digest)
    )
      conflict("output_binding_changed");
    return m;
  }
  async function publish(
    row: AttemptRow,
    versionId: string,
    observedVersionId: string,
    actorId: string,
  ) {
    const image = readCandidate(row);
    if (!image) return conflict("candidate_not_ready");
    const [existing] = await tx
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.workspaceId, workspaceId),
          eq(publications.attemptId, row.id),
          eq(publications.versionId, versionId),
          eq(publications.candidateDigest, image.digest),
        ),
      );
    if (existing) {
      if (existing.revokedAt) return conflict("publication_revoked");
      const [binding] = await tx
        .select()
        .from(approvalUrls)
        .where(
          and(
            eq(approvalUrls.workspaceId, workspaceId),
            eq(approvalUrls.publicationId, existing.id),
          ),
        );
      if (!binding) return conflict("publication_url_missing");
      return {
        publicationToken: readPublication(existing, binding.publicUrl)
          .publicationToken,
        reused: true,
      };
    }
    const [asset] = await tx
      .select({ storageKey: sourceAssets.storageKey })
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.id, image.assetId),
        ),
      )
      .for("share");
    if (!asset) return conflict("candidate_not_found");
    const token = randomBytes(32).toString("base64url");
    const publicUrl = publicationUrl(token, publicOrigin);
    const [publication] = await tx
      .insert(publications)
      .values({
        workspaceId,
        listingId: row.listingId,
        attemptId: row.id,
        versionId,
        observedVersionId,
        assetId: image.assetId,
        storageKey: asset.storageKey,
        candidateDigest: image.digest,
        sourceAssetId: row.sourceAssetId,
        sourceDigest: row.sourceDigest,
        providerVersion: row.providerVersion,
        renderVersion: row.renderVersion,
        size: image.size,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        actorId,
      })
      .returning();
    if (!publication) return conflict("publication_insert_failed");
    await tx
      .insert(approvalUrls)
      .values({ workspaceId, publicationId: publication.id, publicUrl });
    await event(
      row,
      "approved",
      {
        versionId,
        observedVersionId,
        candidateDigest: image.digest,
        assetId: image.assetId,
      },
      actorId,
    );
    return { publicationToken: token, reused: false };
  }
  return {
    async requiresWorkflow(input) {
      await lockListing(input.listingId);
      const shot = await this.currentForListing(input.listingId);
      if (shot) return true;
      if (
        !usesProductShotWorkflow({
          hasSelection: false,
          hasLegacyCutout: false,
          provider: input.provider,
        })
      )
        return false;
      const assets = await tx
        .select({ kind: sourceAssets.kind, metadata: sourceAssets.metadata })
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            eq(sourceAssets.listingId, input.listingId),
          ),
        );
      const hasLegacyCutout = assets.some(
        (a) =>
          a.kind === "image/png" &&
          (a.metadata as Record<string, unknown>).role ===
            "product_shot_cutout",
      );
      return usesProductShotWorkflow({
        hasSelection: false,
        hasLegacyCutout,
        provider: input.provider,
      });
    },
    async resolveApprovedProductImage(input) {
      if (input.workspaceId !== workspaceId)
        return conflict("image_approval_required");
      const listing = await lockListing(input.listingId);
      const selected = await this.currentForListing(input.listingId);
      if (
        !["approved", "publishing", "published", "publish_failed"].includes(
          listing.status,
        ) ||
        listing.activeVersionId !== input.versionId ||
        !selected ||
        selected.state !== "approved" ||
        selected.candidate?.assetId !== input.assetId
      )
        return conflict("image_approval_required");
      const [version] = await tx
        .select()
        .from(listingVersions)
        .where(
          and(
            eq(listingVersions.workspaceId, workspaceId),
            eq(listingVersions.listingId, input.listingId),
            eq(listingVersions.id, input.versionId),
          ),
        );
      if (
        !version ||
        !Array.isArray(version.content.imageAssetIds) ||
        version.content.imageAssetIds.length !== 1 ||
        version.content.imageAssetIds[0] !== input.assetId
      )
        return conflict("image_approval_required");
      const publication = await this.approvedForAsset(input);
      if (
        !publication ||
        publication.attemptId !== selected.attemptId ||
        publication.candidateDigest !== selected.candidate.digest ||
        publication.sourceAssetId !== selected.sourceAssetId ||
        publication.sourceDigest !== selected.sourceDigest ||
        publication.providerVersion !== selected.providerVersion ||
        publication.renderVersion !== selected.renderVersion
      )
        return conflict("image_approval_required");
      return publication.publicUrl;
    },
    async get(attemptId) {
      scope.assertOpen();
      const [row] = await tx
        .select()
        .from(attempts)
        .where(byAttempt(attemptId));
      return row ? readAttempt(row) : null;
    },
    async currentForListing(listingId) {
      scope.assertOpen();
      const [result] = await tx
        .select({ row: attempts })
        .from(selections)
        .innerJoin(
          attempts,
          and(
            eq(attempts.workspaceId, selections.workspaceId),
            eq(attempts.listingId, selections.listingId),
            eq(attempts.id, selections.attemptId),
          ),
        )
        .where(
          and(
            eq(selections.workspaceId, workspaceId),
            eq(selections.listingId, listingId),
          ),
        );
      return result ? readAttempt(result.row) : null;
    },
    async ensure(input) {
      scope.assertOpen();
      if (
        input.workspaceId !== workspaceId ||
        !validDigest(input.sourceDigest) ||
        !input.providerVersion.trim() ||
        input.providerVersion.length > 100 ||
        !input.renderVersion.trim() ||
        input.renderVersion.length > 100 ||
        typeof input.explicitFreshAttempt !== "boolean"
      )
        return conflict("shot_identity_invalid");
      await authorize(input.actorId);
      await lockListing(input.listingId);
      const current = await selection(input.listingId);
      await source(input);
      const identityMatch = and(
        eq(attempts.workspaceId, workspaceId),
        eq(attempts.listingId, input.listingId),
        eq(attempts.sourceAssetId, input.sourceAssetId),
        eq(attempts.sourceDigest, input.sourceDigest),
        eq(attempts.providerVersion, input.providerVersion),
        eq(attempts.renderVersion, input.renderVersion),
      );
      const [prior] = await tx
        .select()
        .from(attempts)
        .where(identityMatch)
        .orderBy(desc(attempts.generation))
        .limit(1);
      let row = prior;
      if (!prior || input.explicitFreshAttempt) {
        [row] = await tx
          .insert(attempts)
          .values({
            workspaceId,
            listingId: input.listingId,
            sourceAssetId: input.sourceAssetId,
            sourceDigest: input.sourceDigest,
            providerVersion: input.providerVersion,
            renderVersion: input.renderVersion,
            generation: (prior?.generation ?? 0) + 1,
            actorId: input.actorId,
          })
          .returning();
        if (!row) return conflict("attempt_insert_failed");
        await event(
          row,
          "requested",
          {
            generation: row.generation,
            explicitFreshAttempt: input.explicitFreshAttempt,
          },
          input.actorId,
        );
      }
      if (!row) return conflict("attempt_not_found");
      if (current?.attemptId !== row.id) {
        // Selecting an earlier exact candidate reuses pixels, not its acceptance.
        // Immutable historical publications remain valid and are never revoked here.
        if (row.state === "approved")
          await tx
            .update(attempts)
            .set({ state: "candidate_ready", updatedAt: new Date() })
            .where(byAttempt(row.id));
        await tx
          .insert(selections)
          .values({ workspaceId, listingId: row.listingId, attemptId: row.id })
          .onConflictDoUpdate({
            target: [selections.workspaceId, selections.listingId],
            set: { attemptId: row.id, updatedAt: new Date() },
          });
        if (current)
          await event(
            row,
            "source_replaced",
            { previousAttemptId: current.attemptId },
            input.actorId,
          );
      }
      return { attemptId: row.id };
    },
    async claim(input) {
      const { row, selected } = await lockAttempt(input.attemptId, false);
      if (selected?.attemptId !== row.id) return { kind: "skip" };
      if (row.state === "processing") {
        if (!Number.isFinite(input.now.getTime()))
          return conflict("claim_time_invalid");
        if (
          row.leaseExpiresAt &&
          row.leaseExpiresAt <= input.now &&
          row.dispatchedAt
        ) {
          await tx
            .update(attempts)
            .set({
              state: "outcome_unknown",
              errorCode: "lease_expired",
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: input.now,
            })
            .where(byAttempt(row.id));
          await event(row, "outcome_unknown", { code: "lease_expired" });
          return { kind: "outcome_unknown" };
        }
        return { kind: "skip" };
      }
      if (row.state === "outcome_unknown") return { kind: "outcome_unknown" };
      if (row.state !== "queued" || row.dispatchedAt || row.cutoutAssetId)
        return { kind: "skip" };
      if (
        !Number.isInteger(input.dailyLimit) ||
        input.dailyLimit < 1 ||
        input.dailyLimit > 2_147_483_647
      )
        return { kind: "budget_exhausted" };
      if (
        !Number.isFinite(input.now.getTime()) ||
        (input.estimatedCostUsd !== undefined &&
          (!Number.isFinite(input.estimatedCostUsd) ||
            input.estimatedCostUsd < 0 ||
            input.estimatedCostUsd > 99999999))
      )
        return conflict("claim_input_invalid");
      await source(row);
      const day = input.now.toISOString().slice(0, 10);
      const budget = await tx.execute(
        sql`insert into product_shot_daily_dispatches(workspace_id,dispatch_day,dispatched_count) values (${workspaceId},${day}::date,1) on conflict(workspace_id,dispatch_day) do update set dispatched_count=product_shot_daily_dispatches.dispatched_count+1 where product_shot_daily_dispatches.dispatched_count<${input.dailyLimit} returning dispatched_count`,
      );
      if (!budget.length) return { kind: "budget_exhausted" };
      const leaseToken = randomUUID();
      await tx
        .update(attempts)
        .set({
          state: "processing",
          leaseToken,
          leaseExpiresAt: new Date(input.now.getTime() + PRODUCT_SHOT_LEASE_MS),
          dispatchedAt: input.now,
          callCount: 1,
          estimatedCostUsd: input.estimatedCostUsd?.toFixed(6) ?? null,
          updatedAt: input.now,
        })
        .where(byAttempt(row.id));
      await event(row, "dispatched", {
        callCount: 1,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        dispatchDay: day,
      });
      return { kind: "claimed", leaseToken, sourceAssetId: row.sourceAssetId };
    },
    async saveCutout(input) {
      // Preserve a paid in-flight result even if selection changed during I/O.
      const { row } = await lockAttempt(input.attemptId, false);
      if (
        row.state !== "processing" ||
        row.leaseToken !== input.leaseToken ||
        !row.leaseExpiresAt ||
        row.leaseExpiresAt <= new Date()
      )
        return conflict("lease_lost");
      await source(row);
      const m = await output(row, input.assetId, "product_shot_cutout");
      await tx
        .update(attempts)
        .set({
          state: "cutout_ready",
          cutoutAssetId: input.assetId,
          cutoutDigest: String(m.digest),
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(byAttempt(row.id));
      await event(row, "cutout_saved", {
        assetId: input.assetId,
        digest: m.digest,
      });
    },
    async finishFailure(input) {
      const { row } = await lockAttempt(input.attemptId, false);
      if (row.state !== "processing" || row.leaseToken !== input.leaseToken)
        return conflict("lease_lost");
      const code = [
        "rejected",
        "rate_limited",
        "invalid_output",
        "outcome_unknown",
      ].includes(input.code)
        ? input.code
        : "processing_failed";
      const state = input.unknown ? "outcome_unknown" : "failed";
      await tx
        .update(attempts)
        .set({
          state,
          errorCode: code,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(byAttempt(row.id));
      await event(row, state, { code });
    },
    async finishUndispatched(input) {
      const { row } = await lockAttempt(input.attemptId, false);
      // Not an error: a concurrent delivery may have claimed the attempt while
      // this one was deciding. That delivery owns the outcome, and a row that
      // reached a provider must never be recorded as a costless failure.
      if (row.state !== "queued" || row.dispatchedAt || row.cutoutAssetId)
        return "skipped";
      const code = [
        "provider_disabled",
        "budget_exhausted",
        "never_dispatched",
      ].includes(input.code)
        ? input.code
        : "never_dispatched";
      await tx
        .update(attempts)
        .set({
          state: "failed",
          errorCode: code,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(byAttempt(row.id));
      await event(row, "failed", { code });
      return "ended";
    },
    async saveCandidate(input) {
      const { row } = await lockAttempt(input.attemptId);
      await source(row);
      const image = input.candidate;
      if (
        !validDigest(image.digest) ||
        !Number.isInteger(image.width) ||
        image.width < 1 ||
        image.width > PRODUCT_SHOT_LIMITS.canvas ||
        image.height !== image.width ||
        !Number.isInteger(image.size) ||
        image.size < 1 ||
        image.size > PRODUCT_SHOT_LIMITS.outputBytes ||
        typeof image.lowResolution !== "boolean"
      )
        return conflict("candidate_invalid");
      const m = await output(row, image.assetId, "product_shot_candidate");
      if (
        m.digest !== image.digest ||
        m.width !== image.width ||
        m.height !== image.height ||
        m.size !== image.size ||
        m.lowResolution !== image.lowResolution
      )
        return conflict("candidate_binding_changed");
      const current = readCandidate(row);
      if (current) {
        if (sameCandidate(current, image)) return;
        return conflict("candidate_already_saved");
      }
      if (row.state !== "cutout_ready" || !row.cutoutAssetId)
        return conflict("cutout_not_ready");
      await tx
        .update(attempts)
        .set({
          state: "candidate_ready",
          candidateAssetId: image.assetId,
          candidateDigest: image.digest,
          candidateWidth: image.width,
          candidateHeight: image.height,
          candidateSize: image.size,
          candidateLowResolution: image.lowResolution,
          updatedAt: new Date(),
        })
        .where(byAttempt(row.id));
      await event(row, "candidate_saved", {
        assetId: image.assetId,
        candidateDigest: image.digest,
        renderVersion: row.renderVersion,
      });
    },
    async approve(input) {
      scope.assertOpen();
      await authorize(input.actorId, true);
      const { row, listing } = await lockAttempt(input.attemptId);
      if (
        listing.activeVersionId !== input.expectedVersionId ||
        !["in_review", "reopened", "approved"].includes(listing.status)
      )
        return conflict("stale_review_version");
      if (
        !["candidate_ready", "approved"].includes(row.state) ||
        row.candidateDigest !== input.candidateDigest ||
        !row.candidateAssetId
      )
        return conflict("stale_candidate");
      await source(row);
      await output(row, row.candidateAssetId, "product_shot_candidate");
      if (row.state !== "approved")
        await tx
          .update(attempts)
          .set({ state: "approved", updatedAt: new Date() })
          .where(byAttempt(row.id));
      const result = await publish(
        row,
        input.expectedVersionId,
        input.expectedVersionId,
        input.actorId,
      );
      if (row.state !== "approved" && result.reused)
        await event(
          row,
          "approved",
          {
            versionId: input.expectedVersionId,
            observedVersionId: input.expectedVersionId,
            candidateDigest: row.candidateDigest,
            assetId: row.candidateAssetId,
          },
          input.actorId,
        );
      return { publicationToken: result.publicationToken };
    },
    async bindApprovedVersion(input) {
      scope.assertOpen();
      await authorize(input.actorId, true);
      const [publication] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.workspaceId, workspaceId),
            eq(
              publications.tokenHash,
              createHash("sha256").update(input.publicationToken).digest("hex"),
            ),
          ),
        );
      if (
        !publication ||
        publication.revokedAt ||
        publication.versionId !== input.expectedVersionId
      )
        return conflict("publication_binding_changed");
      const { row, listing } = await lockAttempt(publication.attemptId);
      if (
        listing.status !== "approved" ||
        listing.activeVersionId !== input.versionId ||
        row.state !== "approved" ||
        row.candidateAssetId !== publication.assetId ||
        row.candidateDigest !== publication.candidateDigest
      )
        return conflict("approved_version_changed");
      const [version] = await tx
        .select()
        .from(listingVersions)
        .where(
          and(
            eq(listingVersions.workspaceId, workspaceId),
            eq(listingVersions.listingId, row.listingId),
            eq(listingVersions.id, input.versionId),
          ),
        );
      if (
        !version ||
        !Array.isArray(version.content.imageAssetIds) ||
        !version.content.imageAssetIds.includes(publication.assetId)
      )
        return conflict("approved_image_missing");
      // Refresh after the listing lock: a concurrent revoke uses the same lock.
      const [fresh] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.workspaceId, workspaceId),
            eq(publications.id, publication.id),
          ),
        );
      if (!fresh || fresh.revokedAt) return conflict("publication_revoked");
      await source(row);
      await output(row, publication.assetId, "product_shot_candidate");
      const result = await publish(
        row,
        input.versionId,
        input.expectedVersionId,
        input.actorId,
      );
      return { publicationToken: result.publicationToken };
    },
    async approvedForAsset(input) {
      scope.assertOpen();
      const [publication] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.workspaceId, workspaceId),
            eq(publications.listingId, input.listingId),
            eq(publications.versionId, input.versionId),
            eq(publications.assetId, input.assetId),
            isNull(publications.revokedAt),
          ),
        )
        .orderBy(desc(publications.createdAt))
        .limit(1);
      if (!publication) return null;
      const [binding] = await tx
        .select()
        .from(approvalUrls)
        .where(
          and(
            eq(approvalUrls.workspaceId, workspaceId),
            eq(approvalUrls.publicationId, publication.id),
          ),
        );
      return binding ? readPublication(publication, binding.publicUrl) : null;
    },
    async revoke(input) {
      scope.assertOpen();
      await authorize(input.actorId, true);
      const [publication] = await tx
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.workspaceId, workspaceId),
            eq(
              publications.tokenHash,
              createHash("sha256").update(input.publicationToken).digest("hex"),
            ),
          ),
        );
      if (!publication) return conflict("publication_not_found");
      const { row } = await lockAttempt(publication.attemptId, false);
      const updated = await tx
        .update(publications)
        .set({ revokedAt: new Date(), revokedBy: input.actorId })
        .where(
          and(
            eq(publications.workspaceId, workspaceId),
            eq(publications.id, publication.id),
            isNull(publications.revokedAt),
          ),
        )
        .returning();
      if (updated.length)
        await event(
          row,
          "revoked",
          {
            versionId: publication.versionId,
            candidateDigest: publication.candidateDigest,
            publicationId: publication.id,
          },
          input.actorId,
        );
    },
  };
}
