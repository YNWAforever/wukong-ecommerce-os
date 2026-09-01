import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditContext, AuditWriter, CanonicalListing } from "@wukong/core";
import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const listingContent: CanonicalListing = {
  sku: "OPAK-001",
  producer: "Demo Estate",
  productType: "wine",
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: 4,
  criticScores: [],
  awards: [],
  title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
  description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  seo: {
    title: { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate Riesling" },
    description: { en: "A restrained German wine.", "zh-Hant": "德國葡萄酒。" },
  },
  tags: ["Riesling"],
  imageAssetIds: [],
};

describe("publish job repository", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  let context: AuditContext;
  let audit: AuditWriter;
  let listingId: string;
  let versionId: string;
  let connectionId: string;

  beforeAll(async () => {
    await admin.unsafe(
      "DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END $role$;",
    );
    await database.migrate();
    await admin.unsafe("TRUNCATE TABLE workspaces CASCADE");
    const created = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        const listing = await repos.listings.create({ target: "shopline" });
        context = {
          workspaceId: "ws_publish_repo",
          actorId: "test:publish",
          entityId: listing.id,
        };
        audit = repos.audit;
        const version = await repos.listings.appendVersion(
          listing.id,
          listingContent,
          context,
          audit,
        );
        return { listingId: listing.id, versionId: version.id };
      },
    );
    listingId = created.listingId;
    versionId = created.versionId;
    const [connection] =
      await admin`insert into shopline_connections (workspace_id, shop_domain, encrypted_access_token) values ('ws_publish_repo', 'opak.example', 'encrypted-test-token') returning id`;
    connectionId = connection.id as string;
    await admin`update listing_drafts set status = 'approved', active_version_id = ${versionId} where workspace_id = 'ws_publish_repo' and id = ${listingId}`;
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("loads the approved active version and blocking flags in tenant scope", async () => {
    const snapshot = await forWorkspace(database, "ws_publish_repo", (repos) =>
      repos.listings.requireForPublish(listingId),
    );
    expect(snapshot).toMatchObject({
      id: listingId,
      status: "approved",
      activeVersion: { id: versionId, sequence: 1, content: listingContent },
      flags: [],
    });
  });

  it("claims one queued delivery and requires its lease for publication", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:create`;
    const digest = "a".repeat(64);
    const now = new Date("2026-07-20T00:00:00.000Z");
    const result = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        const first = await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: key,
          payloadDigest: digest,
        });
        const second = await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: key,
          payloadDigest: digest,
        });
        expect(first.status).toBe("pending_enqueue");
        await repos.publishJobs.markQueued(key);
        const wrongVersion = await repos.publishJobs.claim({
          key,
          expectedVersionId: randomUUID(),
          now,
          leaseMs: 60_000,
        });
        const claimed = await repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now,
          leaseMs: 60_000,
        });
        const duplicate = await repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now,
          leaseMs: 60_000,
        });
        await expect(
          repos.publishJobs.markPublished(
            key,
            randomUUID(),
            "remote_123",
            digest,
          ),
        ).rejects.toThrow(/lease/i);
        await repos.publishJobs.markPublished(
          key,
          claimed.leaseToken!,
          "remote_123",
          digest,
        );
        return {
          first,
          second,
          wrongVersion,
          claimed,
          duplicate,
          final: await repos.publishJobs.getByIdempotencyKey(key),
        };
      },
    );
    expect(result.first.id).toBe(result.second.id);
    expect(result.wrongVersion).toEqual({
      claimed: false,
      job: null,
      leaseToken: null,
    });
    expect(result.claimed.claimed).toBe(true);
    expect(result.claimed.leaseToken).toBeTruthy();
    expect(result.claimed.job).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
    expect(result.duplicate).toEqual({
      claimed: false,
      job: null,
      leaseToken: null,
    });
    expect(result.final).toMatchObject({
      status: "published",
      remoteProductId: "remote_123",
      payloadDigest: digest,
    });
    expect(result.final?.leaseToken).toBeNull();
    expect(result.final?.leaseExpiresAt).toBeNull();
    await expect(
      forWorkspace(database, "ws_other_publish_repo", (repos) =>
        repos.publishJobs.getByIdempotencyKey(key),
      ),
    ).resolves.toBeNull();
  });

  it("rejects unsafe result updates and sanitizes terminal errors", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:failed`;
    await forWorkspace(database, "ws_publish_repo", (repos) =>
      repos.publishJobs.ensure({
        listingId,
        versionId,
        connectionId,
        idempotencyKey: key,
        payloadDigest: "b".repeat(64),
      }),
    );
    const lease = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        await repos.publishJobs.markQueued(key);
        return repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now: new Date(),
          leaseMs: 60_000,
        });
      },
    );
    await expect(
      forWorkspace(database, "ws_publish_repo", (repos) =>
        repos.publishJobs.markPublished(
          key,
          lease.leaseToken!,
          "remote",
          "not-a-digest",
        ),
      ),
    ).rejects.toThrow(/publish result is invalid/i);
    await forWorkspace(database, "ws_publish_repo", (repos) =>
      repos.publishJobs.markFailed(
        key,
        lease.leaseToken!,
        "token secret should not persist",
      ),
    );
    await expect(
      forWorkspace(database, "ws_publish_repo", (repos) =>
        repos.publishJobs.getByIdempotencyKey(key),
      ),
    ).resolves.toMatchObject({ status: "failed", error: "remote_unavailable" });
  });

  it("reclaims retryable failed jobs but rejects terminal failed jobs", async () => {
    const retryKey = `ws_publish_repo:${versionId}:shopline:retryable-failed`;
    const terminalKey = `ws_publish_repo:${versionId}:shopline:terminal-failed`;
    const now = new Date("2026-07-20T00:05:00.000Z");
    const result = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: retryKey,
          payloadDigest: "f".repeat(64),
        });
        await repos.publishJobs.markQueued(retryKey);
        const retryLease = await repos.publishJobs.claim({
          key: retryKey,
          expectedVersionId: versionId,
          now,
          leaseMs: 60_000,
        });
        await repos.publishJobs.markFailed(
          retryKey,
          retryLease.leaseToken!,
          "remote_unavailable",
        );
        const retried = await repos.publishJobs.claim({
          key: retryKey,
          expectedVersionId: versionId,
          now: new Date(now.getTime() + 30_000),
          leaseMs: 60_000,
        });
        await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: terminalKey,
          payloadDigest: "0".repeat(64),
        });
        await repos.publishJobs.markQueued(terminalKey);
        const terminalLease = await repos.publishJobs.claim({
          key: terminalKey,
          expectedVersionId: versionId,
          now,
          leaseMs: 60_000,
        });
        await repos.publishJobs.markFailed(
          terminalKey,
          terminalLease.leaseToken!,
          "invalid_credentials_or_permission",
        );
        const rejected = await repos.publishJobs.claim({
          key: terminalKey,
          expectedVersionId: versionId,
          now: new Date(now.getTime() + 30_000),
          leaseMs: 60_000,
        });
        return { retried, rejected };
      },
    );
    expect(result.retried.claimed).toBe(true);
    expect(result.retried.job).toMatchObject({
      status: "running",
      attemptCount: 2,
      error: null,
    });
    expect(result.rejected).toEqual({
      claimed: false,
      job: null,
      leaseToken: null,
    });
  });
  it("reclaims an expired lease and rejects the stale worker terminal update", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:reclaim`;
    const firstNow = new Date("2026-07-20T00:00:00.000Z");
    const secondNow = new Date("2026-07-20T00:01:00.001Z");
    const result = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: key,
          payloadDigest: "d".repeat(64),
        });
        await repos.publishJobs.markQueued(key);
        const first = await repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now: firstNow,
          leaseMs: 60_000,
        });
        const reclaimed = await repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now: secondNow,
          leaseMs: 60_000,
        });
        await expect(
          repos.publishJobs.markFailed(
            key,
            first.leaseToken!,
            "remote_unavailable",
          ),
        ).rejects.toThrow(/lease/i);
        await repos.publishJobs.markFailed(
          key,
          reclaimed.leaseToken!,
          "rate_limited",
        );
        return {
          first,
          reclaimed,
          final: await repos.publishJobs.getByIdempotencyKey(key),
        };
      },
    );
    expect(result.first.claimed).toBe(true);
    expect(result.reclaimed.claimed).toBe(true);
    expect(result.reclaimed.leaseToken).not.toBe(result.first.leaseToken);
    expect(result.reclaimed.job?.attemptCount).toBe(2);
    expect(result.final).toMatchObject({
      status: "failed",
      error: "rate_limited",
      attemptCount: 2,
    });
  });

  it("does not let markQueued regress a fast consumer claim", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:fast-consumer`;
    const result = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: key,
          payloadDigest: "e".repeat(64),
        });
        const claimed = await repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now: new Date(),
          leaseMs: 60_000,
        });
        await repos.publishJobs.markQueued(key);
        return {
          claimed,
          final: await repos.publishJobs.getByIdempotencyKey(key),
        };
      },
    );
    expect(result.claimed.claimed).toBe(true);
    expect(result.final).toMatchObject({ status: "running", attemptCount: 1 });
  });

  it("persists audited publishing and published transitions in one tenant scope", async () => {
    const key = `ws_publish_repo:${versionId}:shopline:lifecycle`;
    const digest = "c".repeat(64);
    const snapshot = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        await repos.listings.beginPublish(listingId, context, repos.audit);
        await repos.publishJobs.ensure({
          listingId,
          versionId,
          connectionId,
          idempotencyKey: key,
          payloadDigest: digest,
        });
        await repos.publishJobs.markQueued(key);
        const claimed = await repos.publishJobs.claim({
          key,
          expectedVersionId: versionId,
          now: new Date(),
          leaseMs: 60_000,
        });
        await repos.publishJobs.markPublished(
          key,
          claimed.leaseToken!,
          "remote_lifecycle",
          digest,
        );
        await repos.listings.markPublished(
          listingId,
          versionId,
          "remote_lifecycle",
          digest,
          context,
          repos.audit,
        );
        return {
          listing: await repos.listings.getById(listingId),
          job: await repos.publishJobs.getByIdempotencyKey(key),
        };
      },
    );
    expect(snapshot.listing?.status).toBe("published");
    expect(snapshot.job).toMatchObject({
      status: "published",
      remoteProductId: "remote_lifecycle",
    });
    const audits =
      await admin`select action from audit_events where workspace_id = 'ws_publish_repo' and entity_id = ${listingId} order by created_at`;
    expect(audits.map((row) => row.action)).toContain("listing.published");
  });

  it("lists workspace publish jobs newest first, isolated per workspace, with limit bounds enforced", async () => {
    // A workspace dedicated to just this test, not the shared "ws_publish_repo"
    // every other test in this file also writes into -- reusing that shared
    // workspace here would make `toEqual` below flaky against whatever rows
    // earlier tests happened to leave behind. Needs its own listing/version/
    // connection too, since publishJobs.ensure() requires real ids scoped to
    // this workspace.
    const listFixture = await forWorkspace(
      database,
      "ws_publish_repo_list",
      async (repos) => {
        const listing = await repos.listings.create({ target: "shopline" });
        const listContext: AuditContext = {
          workspaceId: "ws_publish_repo_list",
          actorId: "test:publish-list",
          entityId: listing.id,
        };
        const version = await repos.listings.appendVersion(
          listing.id,
          listingContent,
          listContext,
          repos.audit,
        );
        return { listingId: listing.id, versionId: version.id };
      },
    );
    const [listConnection] =
      await admin`insert into shopline_connections (workspace_id, shop_domain, encrypted_access_token) values ('ws_publish_repo_list', 'opak-list.example', 'encrypted-test-token-list') returning id`;

    const created = await forWorkspace(
      database,
      "ws_publish_repo_list",
      async (repos) => {
        const ids: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const job = await repos.publishJobs.ensure({
            listingId: listFixture.listingId,
            versionId: listFixture.versionId,
            connectionId: listConnection.id as string,
            idempotencyKey: `ws_publish_repo_list:list_order:${index}`,
            payloadDigest: "1".repeat(64),
          });
          ids.push(job.id);
        }
        return ids;
      },
    );
    // All three rows were inserted inside one transaction, so they would
    // otherwise share the exact same `now()` -- backdate them to distinct,
    // known instants so newest-first ordering is unambiguous.
    for (const [index, id] of created.entries()) {
      const backdated = new Date(
        Date.now() - (created.length - index) * 60_000,
      );
      await admin.unsafe(
        "UPDATE publish_jobs SET created_at = $1 WHERE id = $2",
        [backdated, id],
      );
    }

    // A second, fully independent workspace -- its own listing, version, and
    // connection -- proves a publish job never leaks across the tenancy
    // boundary, not merely that a query happens to filter on workspace_id.
    const otherListingId = await forWorkspace(
      database,
      "ws_publish_repo_other",
      async (repos) => {
        const listing = await repos.listings.create({ target: "shopline" });
        return listing.id;
      },
    );
    const otherContext: AuditContext = {
      workspaceId: "ws_publish_repo_other",
      actorId: "test:publish-other",
      entityId: otherListingId,
    };
    const otherVersionId = await forWorkspace(
      database,
      "ws_publish_repo_other",
      async (repos) => {
        const version = await repos.listings.appendVersion(
          otherListingId,
          listingContent,
          otherContext,
          repos.audit,
        );
        return version.id;
      },
    );
    const [otherConnection] =
      await admin`insert into shopline_connections (workspace_id, shop_domain, encrypted_access_token) values ('ws_publish_repo_other', 'other.example', 'encrypted-test-token-other') returning id`;
    const otherJobId = await forWorkspace(
      database,
      "ws_publish_repo_other",
      async (repos) => {
        const job = await repos.publishJobs.ensure({
          listingId: otherListingId,
          versionId: otherVersionId,
          connectionId: otherConnection.id as string,
          idempotencyKey: "ws_publish_repo_other:list_order:0",
          payloadDigest: "2".repeat(64),
        });
        return job.id;
      },
    );

    const listed = await forWorkspace(
      database,
      "ws_publish_repo_list",
      (repos) => repos.publishJobs.listForWorkspace(),
    );
    expect(listed.map((job) => job.id)).toEqual([...created].reverse());
    expect(listed.map((job) => job.id)).not.toContain(otherJobId);
    expect(listed.every((job) => job.createdAt instanceof Date)).toBe(true);

    await expect(
      forWorkspace(database, "ws_publish_repo_list", (repos) =>
        repos.publishJobs.listForWorkspace(0),
      ),
    ).rejects.toThrow(/limit must be between 1 and 100/i);
    await expect(
      forWorkspace(database, "ws_publish_repo_list", (repos) =>
        repos.publishJobs.listForWorkspace(101),
      ),
    ).rejects.toThrow(/limit must be between 1 and 100/i);
  });

  it("breaks a created_at tie deterministically by id when several publish jobs share one transaction's now()", async () => {
    // forWorkspace wraps every call in one Postgres transaction, and
    // Postgres's now() is fixed for the whole transaction (transaction-start
    // time, not per-statement) -- so all three jobs created below get the
    // exact same created_at with no backdating involved. This is the real
    // production shape (e.g. a bulk-publish action enqueuing several jobs in
    // one call), not a test artifact: without an id tiebreaker, ORDER BY
    // created_at DESC alone would leave these three in an arbitrary order.
    const created = await forWorkspace(
      database,
      "ws_publish_repo",
      async (repos) => {
        const jobs = [];
        for (let index = 0; index < 3; index += 1) {
          jobs.push(
            await repos.publishJobs.ensure({
              listingId,
              versionId,
              connectionId,
              idempotencyKey: `ws_publish_repo:tie_order:${index}`,
              payloadDigest: "3".repeat(64),
            }),
          );
        }
        return jobs;
      },
    );
    expect(new Set(created.map((job) => job.createdAt.getTime())).size).toBe(1);
    const ids = created.map((job) => job.id);

    const listed = await forWorkspace(database, "ws_publish_repo", (repos) =>
      repos.publishJobs.listForWorkspace(),
    );
    const tied = listed.filter((job) => ids.includes(job.id));
    expect(tied.map((job) => job.id)).toEqual([...ids].sort().reverse());
  });
});
