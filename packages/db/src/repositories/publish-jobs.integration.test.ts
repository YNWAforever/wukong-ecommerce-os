import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, AuditWriter, CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "../index.js";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl = process.env.TEST_DATABASE_URL ?? "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const listingContent: CanonicalListing = {
  sku: "OPAK-001", producer: "Demo Estate", productType: "wine", country: "Germany", region: "Mosel", vintage: 2024,
  grapeVarieties: ["Riesling"], volumeMl: 750, abvPercent: 12.5, packQuantity: 1, priceHkd: 288, stockQuantity: 4,
  criticScores: [], awards: [], title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: { title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" }, description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" } },
  tags: ["Riesling"], imageAssetIds: [],
};

describe("publish job repository", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined, prepare: false });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  let context: AuditContext;
  let audit: AuditWriter;
  let listingId: string;
  let versionId: string;
  let connectionId: string;

  beforeAll(async () => {
    await admin.unsafe("DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;");
    await database.migrate();
    await admin.unsafe("TRUNCATE TABLE workspaces CASCADE");
    const created = await forWorkspace(database, "ws_publish_repo", async (repos) => {
      const listing = await repos.listings.create({ target: "shopline" });
      context = { workspaceId: "ws_publish_repo", actorId: "test:publish", entityId: listing.id };
      audit = repos.audit;
      const version = await repos.listings.appendVersion(listing.id, listingContent, context, audit);
      return { listingId: listing.id, versionId: version.id };
    });
    listingId = created.listingId;
    versionId = created.versionId;
    const [connection] = await admin`insert into shopline_connections (workspace_id, shop_domain, encrypted_access_token) values ('ws_publish_repo', 'opak.example', 'encrypted-test-token') returning id`;
    connectionId = connection.id as string;
    await admin`update listing_drafts set status = 'approved', active_version_id = ${versionId} where workspace_id = 'ws_publish_repo' and id = ${listingId}`;
  });

  afterAll(async () => { await database.close(); await admin.end(); });

  it("loads the approved active version and blocking flags in tenant scope", async () => {
    const snapshot = await forWorkspace(database, "ws_publish_repo", (repos) => repos.listings.requireForPublish(listingId));
    expect(snapshot).toMatchObject({ id: listingId, status: "approved", activeVersion: { id: versionId, sequence: 1, content: listingContent }, flags: [] });
  });

  it("claims one queued delivery and requires its lease for publication", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:create`;
    const digest = "a".repeat(64);
    const now = new Date("2026-07-20T00:00:00.000Z");
    const result = await forWorkspace(database, "ws_publish_repo", async (repos) => {
      const first = await repos.publishJobs.ensure({ listingId, versionId, connectionId, idempotencyKey: key, payloadDigest: digest });
      const second = await repos.publishJobs.ensure({ listingId, versionId, connectionId, idempotencyKey: key, payloadDigest: digest });
      expect(first.status).toBe("pending_enqueue");
      await repos.publishJobs.markQueued(key);
      const wrongVersion = await repos.publishJobs.claim({ key, expectedVersionId: randomUUID(), now, leaseMs: 60_000 });
      const claimed = await repos.publishJobs.claim({ key, expectedVersionId: versionId, now, leaseMs: 60_000 });
      const duplicate = await repos.publishJobs.claim({ key, expectedVersionId: versionId, now, leaseMs: 60_000 });
      await expect(repos.publishJobs.markPublished(key, randomUUID(), "remote_123", digest)).rejects.toThrow(/lease/i);
      await repos.publishJobs.markPublished(key, claimed.leaseToken!, "remote_123", digest);
      return { first, second, wrongVersion, claimed, duplicate, final: await repos.publishJobs.getByIdempotencyKey(key) };
    });
    expect(result.first.id).toBe(result.second.id);
    expect(result.wrongVersion).toEqual({ claimed: false, job: null, leaseToken: null });
    expect(result.claimed.claimed).toBe(true);
    expect(result.claimed.leaseToken).toBeTruthy();
    expect(result.claimed.job).toMatchObject({ status: "running", attemptCount: 1 });
    expect(result.duplicate).toEqual({ claimed: false, job: null, leaseToken: null });
    expect(result.final).toMatchObject({ status: "published", remoteProductId: "remote_123", payloadDigest: digest });
    expect(result.final?.leaseToken).toBeNull();
    expect(result.final?.leaseExpiresAt).toBeNull();
    await expect(forWorkspace(database, "ws_other_publish_repo", (repos) => repos.publishJobs.getByIdempotencyKey(key))).resolves.toBeNull();
  });

  it("rejects unsafe result updates and sanitizes terminal errors", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:failed`;
    await forWorkspace(database, "ws_publish_repo", (repos) => repos.publishJobs.ensure({ listingId, versionId, connectionId, idempotencyKey: key, payloadDigest: "b".repeat(64) }));
    const lease = await forWorkspace(database, "ws_publish_repo", async (repos) => {
      await repos.publishJobs.markQueued(key);
      return repos.publishJobs.claim({ key, expectedVersionId: versionId, now: new Date(), leaseMs: 60_000 });
    });
    await expect(forWorkspace(database, "ws_publish_repo", (repos) => repos.publishJobs.markPublished(key, lease.leaseToken!, "remote", "not-a-digest"))).rejects.toThrow(/publish result is invalid/i);
    await forWorkspace(database, "ws_publish_repo", (repos) => repos.publishJobs.markFailed(key, lease.leaseToken!, "token secret should not persist"));
    await expect(forWorkspace(database, "ws_publish_repo", (repos) => repos.publishJobs.getByIdempotencyKey(key))).resolves.toMatchObject({ status: "failed", error: "remote_unavailable" });
  });

  it("reclaims an expired lease and rejects the stale worker terminal update", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:reclaim`;
    const firstNow = new Date("2026-07-20T00:00:00.000Z");
    const secondNow = new Date("2026-07-20T00:01:00.001Z");
    const result = await forWorkspace(database, "ws_publish_repo", async (repos) => {
      await repos.publishJobs.ensure({ listingId, versionId, connectionId, idempotencyKey: key, payloadDigest: "d".repeat(64) });
      await repos.publishJobs.markQueued(key);
      const first = await repos.publishJobs.claim({ key, expectedVersionId: versionId, now: firstNow, leaseMs: 60_000 });
      const reclaimed = await repos.publishJobs.claim({ key, expectedVersionId: versionId, now: secondNow, leaseMs: 60_000 });
      await expect(repos.publishJobs.markFailed(key, first.leaseToken!, "remote_unavailable")).rejects.toThrow(/lease/i);
      await repos.publishJobs.markFailed(key, reclaimed.leaseToken!, "rate_limited");
      return { first, reclaimed, final: await repos.publishJobs.getByIdempotencyKey(key) };
    });
    expect(result.first.claimed).toBe(true);
    expect(result.reclaimed.claimed).toBe(true);
    expect(result.reclaimed.leaseToken).not.toBe(result.first.leaseToken);
    expect(result.reclaimed.job?.attemptCount).toBe(2);
    expect(result.final).toMatchObject({ status: "failed", error: "rate_limited", attemptCount: 2 });
  });

  it("does not let markQueued regress a fast consumer claim", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:fast-consumer`;
    const result = await forWorkspace(database, "ws_publish_repo", async (repos) => {
      await repos.publishJobs.ensure({ listingId, versionId, connectionId, idempotencyKey: key, payloadDigest: "e".repeat(64) });
      const claimed = await repos.publishJobs.claim({ key, expectedVersionId: versionId, now: new Date(), leaseMs: 60_000 });
      await repos.publishJobs.markQueued(key);
      return { claimed, final: await repos.publishJobs.getByIdempotencyKey(key) };
    });
    expect(result.claimed.claimed).toBe(true);
    expect(result.final).toMatchObject({ status: "running", attemptCount: 1 });
  });

  it("persists audited publishing and published transitions in one tenant scope", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:lifecycle`;
    const digest = "c".repeat(64);
    const snapshot = await forWorkspace(database, "ws_publish_repo", async (repos) => {
      await repos.listings.beginPublish(listingId, context, repos.audit);
      await repos.publishJobs.ensure({ listingId, versionId, connectionId, idempotencyKey: key, payloadDigest: digest });
      await repos.publishJobs.markQueued(key);
      const claimed = await repos.publishJobs.claim({ key, expectedVersionId: versionId, now: new Date(), leaseMs: 60_000 });
      await repos.publishJobs.markPublished(key, claimed.leaseToken!, "remote_lifecycle", digest);
      await repos.listings.markPublished(listingId, versionId, "remote_lifecycle", digest, context, repos.audit);
      return { listing: await repos.listings.getById(listingId), job: await repos.publishJobs.getByIdempotencyKey(key) };
    });
    expect(snapshot.listing?.status).toBe("published");
    expect(snapshot.job).toMatchObject({ status: "published", remoteProductId: "remote_lifecycle" });
    const audits = await admin`select action from audit_events where workspace_id = 'ws_publish_repo' and entity_id = ${listingId} order by created_at`;
    expect(audits.map((row) => row.action)).toContain("listing.published");
  });});
