import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  normalizeWebsiteUrl,
  robotsPolicySchema,
  websiteScanEnvelopeSchema,
  websiteUrlSchema,
} from "@wukong/core";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import {
  memberships,
  websiteScans,
  websiteScanSteps,
  websiteProducts,
} from "../schema.js";
import { createAuditWriter } from "./audit.js";

const rootUrl = (url: string) => new URL(url).origin + "/";
const originSchema = websiteUrlSchema.refine((v) => rootUrl(v) === v);
const uniqueUrls = (max: number) =>
  z
    .array(websiteUrlSchema)
    .max(max)
    .refine((v) => new Set(v).size === v.length);
export const websiteCheckpointSchema = z.strictObject({
  seedUrl: websiteUrlSchema,
  canonicalOrigin: originSchema.nullable(),
  robotsPolicy: robotsPolicySchema.nullable(),
  pending: z
    .strictObject({
      url: websiteUrlSchema,
      kind: z.enum(["robots", "discovery", "product"]),
    })
    .nullable(),
  discoveryUrls: uniqueUrls(5),
  candidateUrls: uniqueUrls(20),
  visitedUrls: uniqueUrls(31),
  nextEligibleAt: z.iso.datetime({ offset: true }),
  deadlineAt: z.iso.datetime({ offset: true }),
  preview: websiteScanEnvelopeSchema,
});
export type WebsiteCheckpoint = z.infer<typeof websiteCheckpointSchema>;
export const websiteStepResultSchema = z
  .strictObject({
    documentUrl: websiteUrlSchema.nullable().optional(),
    state: z.enum(["running", "ready", "partial", "failed"]),
    checkpoint: websiteCheckpointSchema,
  })
  .superRefine((v, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(v)).byteLength > 1024 * 1024)
      ctx.addIssue({
        code: "custom",
        message: "Website checkpoint exceeds 1 MiB",
      });
    if ((v.state === "running") !== (v.checkpoint.pending !== null))
      ctx.addIssue({
        code: "custom",
        message: "Invalid terminal pending step",
      });
    if (
      (v.state === "ready" || v.state === "partial") &&
      !v.checkpoint.preview.products.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Saved preview must contain products",
      });
    if (v.state === "failed" && v.checkpoint.preview.products.length)
      ctx.addIssue({
        code: "custom",
        message: "Failed scan cannot contain products",
      });
  });
export type WebsiteStepResult = z.infer<typeof websiteStepResultSchema>;
export type WebsiteScan = typeof websiteScans.$inferSelect;
export type SavedWebsiteProduct = typeof websiteProducts.$inferSelect;
export type WebsiteStep = {
  scanId: string;
  revision: number;
  leaseToken: string;
  url: string;
  kind: "robots" | "discovery" | "product";
  lockedOrigin: string | null;
  notBefore: string;
};
export type WebsiteSaveResult = {
  savedIds: string[];
  alreadySavedIds: string[];
};
type LeaseInput = {
  scanId: string;
  revision: number;
  leaseToken: string;
  now: Date;
};
export type WebsiteDocumentFetchResult =
  | { status: "claimed"; step: WebsiteStep; scan: WebsiteScan }
  | { status: "in_progress" | "stale" }
  | { status: "completed"; result: WebsiteStepResult };
export type WebsiteCatalogRepository = {
  createScan(input: {
    url: string;
    requestedBy: string;
    requestKey: string;
    now?: Date;
  }): Promise<WebsiteScan>;
  getScan(id: string): Promise<WebsiteScan | null>;
  claimStep(input: {
    scanId: string;
    revision: number;
    now: Date;
  }): Promise<WebsiteStep | null>;
  beginDocumentFetch(input: LeaseInput): Promise<WebsiteDocumentFetchResult>;
  completeStep(
    input: LeaseInput & { observation: WebsiteStepResult },
  ): Promise<WebsiteScan>;
  recordDispatch(input: {
    scanId: string;
    revision: number;
    status: "sent" | "failed";
    now: Date;
  }): Promise<boolean>;
  listDispatchable(input: {
    now: Date;
    limit?: number;
  }): Promise<WebsiteScan[]>;
  saveSelection(input: {
    scanId: string;
    keys: string[];
    actorId: string;
  }): Promise<WebsiteSaveResult>;
  listProducts(input?: { limit?: number }): Promise<SavedWebsiteProduct[]>;
};
const active = (scan: WebsiteScan) =>
  scan.state === "queued" || scan.state === "running";
const instant = (date: Date) => z.date().parse(date);
const bound = (n: number) => z.number().int().min(1).max(100).parse(n);
const relatedOrigins = (a: string, b: string) =>
  new URL(a).hostname.replace(/^www\./, "") ===
  new URL(b).hostname.replace(/^www\./, "");

function validateProgress(
  scan: WebsiteScan,
  result: WebsiteStepResult,
  now: Date,
) {
  const old = scan.checkpoint,
    next = result.checkpoint,
    pending = old.pending;
  if (!pending) throw new Error("stale website step");
  const documentUrl =
    result.documentUrl === undefined ? pending.url : result.documentUrl;
  if (
    documentUrl &&
    (old.canonicalOrigin
      ? rootUrl(documentUrl) !== old.canonicalOrigin
      : !relatedOrigins(rootUrl(old.seedUrl), rootUrl(documentUrl)))
  )
    throw new Error("Foreign document origin");
  if (
    next.canonicalOrigin &&
    old.canonicalOrigin === null &&
    (!documentUrl || rootUrl(documentUrl) !== next.canonicalOrigin)
  )
    throw new Error("Canonical origin must match fetched document");
  if (next.seedUrl !== old.seedUrl || next.deadlineAt !== old.deadlineAt)
    throw new Error("Immutable scan identity/deadline");
  if (
    old.canonicalOrigin !== null &&
    next.canonicalOrigin !== old.canonicalOrigin
  )
    throw new Error("Canonical origin is locked");
  if (
    next.canonicalOrigin &&
    !relatedOrigins(rootUrl(old.seedUrl), next.canonicalOrigin)
  )
    throw new Error("Foreign canonical origin");
  if (
    !old.canonicalOrigin &&
    next.canonicalOrigin &&
    pending.kind !== "discovery" &&
    pending.kind !== "robots"
  )
    throw new Error("Canonical origin requires initial discovery or robots");
  if (
    result.state === "running" &&
    next.robotsPolicy &&
    next.robotsPolicy.state !== "ready"
  )
    throw new Error("Robots policy requires terminal scan");
  if (
    pending.kind === "robots" &&
    next.robotsPolicy?.state === "ready" &&
    documentUrl === null
  )
    throw new Error("Robots policy requires fetched document");
  const origin = next.canonicalOrigin ?? rootUrl(next.seedUrl);
  if (next.robotsPolicy && next.robotsPolicy.origin !== origin) {
    if (
      !next.canonicalOrigin ||
      next.pending?.kind !== "robots" ||
      rootUrl(next.pending.url) !== origin ||
      next.preview.products.length
    )
      throw new Error("Canonical origin requires robots reapproval");
  }
  if (
    !isDeepStrictEqual(old.robotsPolicy, next.robotsPolicy) &&
    pending.kind !== "robots"
  )
    throw new Error("Only robots step may update policy");
  if (
    pending.kind === "robots" &&
    next.robotsPolicy &&
    documentUrl &&
    next.robotsPolicy.origin !== rootUrl(documentUrl)
  )
    throw new Error("Robots policy must match document origin");
  if (
    next.pending?.kind === "robots" &&
    (new URL(next.pending.url).pathname !== "/robots.txt" ||
      new URL(next.pending.url).search)
  )
    throw new Error("Invalid robots target");
  for (const url of [
    ...next.discoveryUrls,
    ...next.candidateUrls,
    ...next.visitedUrls,
    ...next.preview.products.map((p) => p.sourceUrl),
    ...(next.pending ? [next.pending.url] : []),
  ]) {
    if (rootUrl(url) !== origin) throw new Error("Foreign checkpoint URL");
  }
  if (next.pending && next.pending.kind !== "robots") {
    if (
      next.robotsPolicy?.state !== "ready" ||
      next.robotsPolicy.origin !== rootUrl(next.pending.url)
    )
      throw new Error("Approved robots required");
    if (
      next.pending.kind === "product" &&
      (!next.canonicalOrigin || !next.candidateUrls.includes(next.pending.url))
    )
      throw new Error("Unbound product target");
    const minimum =
      now.getTime() + Math.max(1, next.robotsPolicy.crawlDelaySeconds) * 1000;
    if (Date.parse(next.nextEligibleAt) < minimum)
      throw new Error("Next request violates crawl interval");
  }
  if (
    next.pending &&
    Date.parse(next.nextEligibleAt) <
      Math.max(scan.nextEligibleAt.getTime(), now.getTime() + 1000)
  )
    throw new Error("Next request violates crawl interval");
  const oldProducts = new Map(old.preview.products.map((p) => [p.key, p]));
  for (const [key, product] of oldProducts)
    if (
      !isDeepStrictEqual(
        next.preview.products.find((p) => p.key === key),
        product,
      )
    )
      throw new Error("Preview observations are immutable");
  const added = next.preview.products.filter((p) => !oldProducts.has(p.key));
  if (
    added.length > 1 ||
    (added.length &&
      (pending.kind !== "product" ||
        added[0]!.sourceUrl !== documentUrl ||
        !next.canonicalOrigin ||
        next.robotsPolicy?.origin !== next.canonicalOrigin ||
        next.robotsPolicy.state !== "ready"))
  )
    throw new Error("Unbound product observation");
  if (Date.parse(next.nextEligibleAt) < Date.parse(old.nextEligibleAt))
    throw new Error("Scan clock cannot rewind");
  if (result.state === "running" && now >= scan.deadlineAt)
    throw new Error("Scan deadline exceeded");
}

export function createWebsiteCatalogRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): WebsiteCatalogRepository {
  const audit = createAuditWriter(transaction, workspaceId, scope);
  const whereScan = (id: string) =>
    and(
      eq(websiteScans.workspaceId, workspaceId),
      eq(websiteScans.id, z.uuid().parse(id)),
    );
  const whereStep = (id: string, revision: number) =>
    and(
      eq(websiteScanSteps.workspaceId, workspaceId),
      eq(websiteScanSteps.scanId, id),
      eq(websiteScanSteps.revision, revision),
    );
  const read = async (id: string, lock = false) => {
    scope.assertOpen();
    const query = transaction.select().from(websiteScans).where(whereScan(id));
    const [row] = await (lock ? query.for("update") : query);
    return row ?? null;
  };
  const event = async (
    scan: WebsiteScan,
    action: string,
    metadata: Record<string, unknown> = {},
    actorId = scan.requestedBy,
  ) =>
    audit.write({ workspaceId, actorId, entityId: scan.id, action, metadata });
  const requireOperator = async (actorId: string) => {
    const [member] = await transaction
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, actorId),
        ),
      )
      .for("share");
    if (
      !member ||
      !["operator", "reviewer", "admin", "owner"].includes(member.role)
    )
      throw new Error("Website catalog requires operator role");
  };
  const stepFor = (scan: WebsiteScan): WebsiteStep => ({
    scanId: scan.id,
    revision: scan.revision,
    leaseToken: scan.leaseToken!,
    url: scan.checkpoint.pending!.url,
    kind: scan.checkpoint.pending!.kind,
    lockedOrigin: scan.checkpoint.canonicalOrigin,
    notBefore: scan.nextEligibleAt.toISOString(),
  });
  const terminate = async (scan: WebsiteScan, now: Date, reason: string) => {
    const checkpoint = {
      ...scan.checkpoint,
      pending: null,
      preview: {
        ...scan.checkpoint.preview,
        warnings: [...scan.checkpoint.preview.warnings.slice(0, 29), reason],
      },
    };
    const state = checkpoint.preview.products.length ? "partial" : "failed";
    const [row] = await transaction
      .update(websiteScans)
      .set({
        state,
        checkpoint,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(whereScan(scan.id))
      .returning();
    await event(scan, "website.scan_finished", { state, reason });
    return row!;
  };
  const repository: WebsiteCatalogRepository = {
    async createScan(input) {
      scope.assertOpen();
      await requireOperator(input.requestedBy);
      const url = normalizeWebsiteUrl(input.url);
      if (!url) throw new Error("Invalid website URL");
      const requestKey = z.string().min(1).max(200).parse(input.requestKey),
        now = instant(input.now ?? new Date());
      const checkpoint: WebsiteCheckpoint = {
        seedUrl: url,
        canonicalOrigin: null,
        robotsPolicy: null,
        pending: { url: new URL("/robots.txt", url).href, kind: "robots" },
        discoveryUrls: [],
        candidateUrls: [],
        visitedUrls: [],
        nextEligibleAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        preview: { products: [], warnings: [] },
      };
      const [created] = await transaction
        .insert(websiteScans)
        .values({
          workspaceId,
          requestedUrl: url,
          requestedBy: input.requestedBy,
          requestKey,
          state: "queued",
          checkpoint,
          nextEligibleAt: now,
          deadlineAt: new Date(checkpoint.deadlineAt),
        })
        .onConflictDoNothing({
          target: [websiteScans.workspaceId, websiteScans.requestKey],
        })
        .returning();
      if (created) {
        await event(created, "website.scan_created");
        return created;
      }
      const [existing] = await transaction
        .select()
        .from(websiteScans)
        .where(
          and(
            eq(websiteScans.workspaceId, workspaceId),
            eq(websiteScans.requestKey, requestKey),
          ),
        );
      if (!existing || existing.requestedUrl !== url)
        throw new Error("Website request key conflict");
      return existing;
    },
    getScan: (id) => read(id),
    async claimStep({ scanId, revision, now }) {
      instant(now);
      z.number().int().min(0).parse(revision);
      const scan = await read(scanId, true);
      if (!scan || !active(scan) || scan.revision !== revision) return null;
      if (now >= scan.deadlineAt) {
        await terminate(scan, now, "scan_deadline");
        return null;
      }
      if (
        now < scan.nextEligibleAt ||
        (scan.leaseExpiresAt && scan.leaseExpiresAt > now)
      )
        return null;
      if (now >= scan.deadlineAt || scan.attempts >= 3) {
        await terminate(
          scan,
          now,
          now >= scan.deadlineAt ? "scan_deadline" : "step_attempts_exhausted",
        );
        return null;
      }
      const leaseToken = randomUUID();
      const [row] = await transaction
        .update(websiteScans)
        .set({
          state: "running",
          attempts: scan.attempts + 1,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + 60000),
          updatedAt: now,
        })
        .where(whereScan(scanId))
        .returning();
      await transaction
        .insert(websiteScanSteps)
        .values({
          workspaceId,
          scanId,
          revision,
          leaseToken,
          requestState: "idle",
        })
        .onConflictDoUpdate({
          target: [
            websiteScanSteps.workspaceId,
            websiteScanSteps.scanId,
            websiteScanSteps.revision,
          ],
          set: { leaseToken, requestState: "idle", result: null },
        });
      await event(row!, "website.scan_step_claimed", {
        revision,
        attempt: row!.attempts,
      });
      return stepFor(row!);
    },
    async beginDocumentFetch(input) {
      instant(input.now);
      const scan = await read(input.scanId, true);
      if (!scan) return { status: "stale" };
      const [step] = await transaction
        .select()
        .from(websiteScanSteps)
        .where(whereStep(input.scanId, input.revision));
      if (
        step?.leaseToken === input.leaseToken &&
        step.requestState === "completed" &&
        step.result
      )
        return { status: "completed", result: step.result };
      if (
        !active(scan) ||
        scan.revision !== input.revision ||
        scan.leaseToken !== input.leaseToken ||
        !scan.leaseExpiresAt ||
        scan.leaseExpiresAt <= input.now ||
        !step ||
        step.leaseToken !== input.leaseToken
      )
        return { status: "stale" };
      if (step.requestState === "fetching") return { status: "in_progress" };
      if (input.now >= scan.deadlineAt) {
        await terminate(scan, input.now, "scan_deadline");
        return { status: "stale" };
      }
      const kind = scan.checkpoint.pending!.kind;
      const field =
        kind === "robots"
          ? "robotsRequests"
          : kind === "discovery"
            ? "discoveryRequests"
            : "productRequests";
      const maximum = kind === "robots" ? 6 : kind === "discovery" ? 5 : 20;
      if (scan[field] >= maximum) {
        await terminate(scan, input.now, "request_budget_exhausted");
        return { status: "stale" };
      }
      const [updated] = await transaction
        .update(websiteScans)
        .set({
          [field]: scan[field] + 1,
          nextEligibleAt: new Date(
            input.now.getTime() +
              Math.max(
                1,
                scan.checkpoint.robotsPolicy?.crawlDelaySeconds ?? 1,
              ) *
                1000,
          ),
          updatedAt: input.now,
        })
        .where(whereScan(scan.id))
        .returning();
      await transaction
        .update(websiteScanSteps)
        .set({ requestState: "fetching" })
        .where(whereStep(scan.id, input.revision));
      await event(scan, "website.document_fetch_started", {
        revision: input.revision,
        kind,
      });
      return { status: "claimed", step: stepFor(scan), scan: updated! };
    },
    async completeStep(input) {
      instant(input.now);
      const scan = await read(input.scanId, true);
      if (!scan) throw new Error("stale website step");
      const [step] = await transaction
        .select()
        .from(websiteScanSteps)
        .where(whereStep(input.scanId, input.revision));
      if (
        step?.leaseToken === input.leaseToken &&
        step.requestState === "completed"
      )
        return scan;
      if (
        !active(scan) ||
        scan.revision !== input.revision ||
        scan.leaseToken !== input.leaseToken ||
        !scan.leaseExpiresAt ||
        scan.leaseExpiresAt <= input.now ||
        step?.leaseToken !== input.leaseToken ||
        step.requestState !== "fetching"
      )
        throw new Error("stale website step");
      const result = websiteStepResultSchema.parse(input.observation);
      validateProgress(scan, result, input.now);
      await transaction
        .update(websiteScanSteps)
        .set({ requestState: "completed", result })
        .where(whereStep(scan.id, input.revision));
      const [updated] = await transaction
        .update(websiteScans)
        .set({
          state: result.state,
          checkpoint: result.checkpoint,
          revision: scan.revision + 1,
          attempts: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          nextEligibleAt: new Date(result.checkpoint.nextEligibleAt),
          dispatchStatus: "pending",
          dispatchAt: null,
          updatedAt: input.now,
        })
        .where(whereScan(scan.id))
        .returning();
      await event(scan, "website.scan_step_completed", {
        revision: input.revision,
      });
      if (result.state !== "running")
        await event(scan, "website.scan_finished", { state: result.state });
      return updated!;
    },
    async recordDispatch({ scanId, revision, status, now }) {
      instant(now);
      z.enum(["sent", "failed"]).parse(status);
      const scan = await read(scanId, true);
      if (!scan || !active(scan) || scan.revision !== revision) return false;
      await transaction
        .update(websiteScans)
        .set({
          dispatchStatus: status,
          dispatchAt: now,
          dispatchAttempts: scan.dispatchAttempts + 1,
          updatedAt: now,
        })
        .where(whereScan(scanId));
      await event(scan, "website.scan_dispatched", { revision, status });
      return true;
    },
    async listDispatchable({ now, limit = 100 }) {
      scope.assertOpen();
      instant(now);
      bound(limit);
      return transaction
        .select()
        .from(websiteScans)
        .where(
          and(
            eq(websiteScans.workspaceId, workspaceId),
            or(
              eq(websiteScans.state, "queued"),
              eq(websiteScans.state, "running"),
            ),
            or(
              lte(websiteScans.deadlineAt, now),
              and(
                lte(websiteScans.nextEligibleAt, now),
                or(
                  isNull(websiteScans.leaseExpiresAt),
                  lte(websiteScans.leaseExpiresAt, now),
                ),
                or(
                  isNull(websiteScans.dispatchAt),
                  lte(websiteScans.dispatchAt, new Date(now.getTime() - 60000)),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(websiteScans.nextEligibleAt), asc(websiteScans.id))
        .limit(limit);
    },
    async saveSelection({ scanId, keys, actorId }) {
      scope.assertOpen();
      await requireOperator(actorId);
      z.array(websiteUrlSchema)
        .min(1)
        .max(20)
        .refine((v) => new Set(v).size === v.length)
        .parse(keys);
      const scan = await read(scanId, true);
      if (!scan || !["ready", "partial"].includes(scan.state))
        throw new Error("Website preview unavailable");
      const products = keys.map((key) => {
        const p = scan.checkpoint.preview.products.find((p) => p.key === key);
        if (!p) throw new Error("Unknown website product key");
        return p;
      });
      const result: WebsiteSaveResult = { savedIds: [], alreadySavedIds: [] };
      // Stable order also avoids deadlocks when two scans save overlapping URL sets.
      for (const observation of products.sort((a, b) =>
        a.key.localeCompare(b.key),
      )) {
        const [created] = await transaction
          .insert(websiteProducts)
          .values({
            workspaceId,
            canonicalSourceUrl: observation.sourceUrl,
            sourceScanId: scan.id,
            sourceKey: observation.key,
            observation,
            savedBy: actorId,
          })
          .onConflictDoNothing({
            target: [
              websiteProducts.workspaceId,
              websiteProducts.canonicalSourceUrl,
            ],
          })
          .returning();
        if (created) result.savedIds.push(created.id);
        else {
          const [existing] = await transaction
            .select({ id: websiteProducts.id })
            .from(websiteProducts)
            .where(
              and(
                eq(websiteProducts.workspaceId, workspaceId),
                eq(websiteProducts.canonicalSourceUrl, observation.sourceUrl),
              ),
            );
          if (!existing) throw new Error("Website save conflict");
          result.alreadySavedIds.push(existing.id);
        }
      }
      if (result.savedIds.length)
        await event(
          scan,
          "website.products_saved",
          { productIds: result.savedIds },
          actorId,
        );
      return result;
    },
    async listProducts({ limit = 100 } = {}) {
      scope.assertOpen();
      bound(limit);
      return transaction
        .select()
        .from(websiteProducts)
        .where(eq(websiteProducts.workspaceId, workspaceId))
        .orderBy(asc(websiteProducts.createdAt), asc(websiteProducts.id))
        .limit(limit);
    },
  };
  return repository;
}
