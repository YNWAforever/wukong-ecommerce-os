import { describe, expect, it, vi } from "vitest";

import type { CommerceConnector } from "@wukong/shopline";
import { listing as canonicalListing, workspaceId } from "./pipeline-test-support.js";
import {
  PublishDeliveryError,
  publishApprovedProduct,
  type PublishListingSnapshot,
  type PublishRepositories,
} from "./publish-product.js";

const versionId = "version_approved";
const draftId = "draft_1";

function makeConnector(overrides: Partial<CommerceConnector> = {}): CommerceConnector {
  return {
    verifyConnection: vi.fn(async () => ({ merchantId: "merchant_1" })),
    createProduct: vi.fn(async () => ({ remoteProductId: "remote_123" })),
    updateProduct: vi.fn(async () => undefined),
    getProductStatus: vi.fn(async () => ({ exists: false, status: null })),
    ...overrides,
  };
}

function makeHarness(
  status: PublishListingSnapshot["status"] = "approved",
  flags: PublishListingSnapshot["flags"] = [],
  jobs: Parameters<typeof makeRepos>[0]["jobs"] = [],
) {
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const listing: PublishListingSnapshot = {
    id: draftId,
    target: "shopline",
    status,
    activeVersion: { id: versionId, sequence: 2, content: canonicalListing },
    flags,
  };
  const state = { listing, jobs: [...jobs] };
  const repos = makeRepos(state, audits);
  const deps = {
    connector: makeConnector(),
    async withWorkspace<T>(_workspace: string, work: (repositories: PublishRepositories) => Promise<T>) {
      return work(repos);
    },
  };
  return { ...deps, repos, state, audits };
}

function makeRepos(
  input: { listing: PublishListingSnapshot; jobs: Array<any> },
  audits: Array<{ action: string; metadata: Record<string, unknown> }>,
): PublishRepositories {
  return {
    listings: {
      async requireForPublish() { return input.listing; },
      async beginPublish() { input.listing.status = "publishing"; },
      async markPublished(_id, _versionId, _remoteId, _digest, _context, audit) {
        input.listing.status = "published";
        await audit.write({ workspaceId, actorId: "worker:shopline-publish", entityId: draftId, action: "listing.published", metadata: { remoteProductId: _remoteId, payloadDigest: _digest } });
      },
      async markPublishFailed(_id, _versionId, _errorCode, _context, audit) {
        input.listing.status = "publish_failed";
        await audit.write({ workspaceId, actorId: "worker:shopline-publish", entityId: draftId, action: "listing.publish_failed", metadata: { errorCode: _errorCode } });
      },
    },
    publishJobs: {
      async getByIdempotencyKey(key) { return input.jobs.find((job) => job.idempotencyKey === key) ?? null; },
      async ensure(inputJob) {
        const existing = input.jobs.find((job) => job.idempotencyKey === inputJob.idempotencyKey);
        if (existing) return existing;
        const created = { id: `job_${input.jobs.length + 1}`, ...inputJob, status: "queued", remoteProductId: null, error: null };
        input.jobs.push(created);
        return created;
      },
      async markRunning(key) { const job = input.jobs.find((entry) => entry.idempotencyKey === key); if (job) job.status = "running"; },
      async markPublished(key, remoteProductId, payloadDigest) { const job = input.jobs.find((entry) => entry.idempotencyKey === key); if (job) Object.assign(job, { status: "published", remoteProductId, payloadDigest }); },
      async markFailed(key, errorCode) { const job = input.jobs.find((entry) => entry.idempotencyKey === key); if (job) Object.assign(job, { status: "failed", error: errorCode }); },
    },
    audit: { async write(event) { audits.push({ action: event.action, metadata: event.metadata }); } },
  };
}

describe("publishApprovedProduct", () => {
  it("rejects delivery before approval without calling SHOPLINE", async () => {
    const harness = makeHarness("in_review");
    await expect(publishApprovedProduct({ workspaceId, draftId }, harness)).rejects.toThrow("Only the active approved version can be delivered");
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("rejects unresolved blocking flags before any connector call", async () => {
    const harness = makeHarness("approved", [{ id: "flag_1", field: "description", rule: "health_claim", severity: "blocking", status: "open", resolutionReason: null }]);
    await expect(publishApprovedProduct({ workspaceId, draftId }, harness)).rejects.toThrow(/blocking compliance flags/i);
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("publishes an approved active version and stores only digest and remote id", async () => {
    const harness = makeHarness();
    const result = await publishApprovedProduct({ workspaceId, draftId }, harness);
    expect(result).toMatchObject({ status: "published", remoteProductId: "remote_123", idempotencyKey: `${workspaceId}:${versionId}:shopline:create` });
    expect(result.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.connector.createProduct).toHaveBeenCalledTimes(1);
    expect(harness.state.listing.status).toBe("published");
    expect(harness.state.jobs[0]).toMatchObject({ status: "published", remoteProductId: "remote_123", payloadDigest: result.payloadDigest });
    expect(JSON.stringify(harness.state.jobs[0])).not.toContain("Demo Estate Riesling");
    expect(harness.audits.map((entry) => entry.action)).toContain("listing.published");
  });

  it("returns an existing published delivery without calling SHOPLINE twice", async () => {
    const key = `${workspaceId}:${versionId}:shopline:create`;
    const harness = makeHarness("published", [], [{ id: "job_1", idempotencyKey: key, status: "published", remoteProductId: "remote_existing", payloadDigest: "d".repeat(64), error: null }]);
    const result = await publishApprovedProduct({ workspaceId, draftId }, harness);
    expect(result).toMatchObject({ status: "published", remoteProductId: "remote_existing", payloadDigest: "d".repeat(64) });
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous write with remote status before retrying", async () => {
    const key = `${workspaceId}:${versionId}:shopline:create`;
    const connector = makeConnector({
      createProduct: vi.fn(async () => { throw new PublishDeliveryError("remote_unavailable"); }),
      getProductStatus: vi.fn(async () => ({ exists: true, status: false })),
    });
    const harness = makeHarness("publishing", [], [{ id: "job_1", idempotencyKey: key, status: "running", remoteProductId: "remote_existing", payloadDigest: null, error: null }]);
    harness.connector = connector;
    const result = await publishApprovedProduct({ workspaceId, draftId }, harness);
    expect(result.remoteProductId).toBe("remote_existing");
    expect(connector.getProductStatus).toHaveBeenCalledWith("remote_existing");
    expect(connector.createProduct).toHaveBeenCalledTimes(0);
  });

  it("marks terminal connector failures with a sanitized error code", async () => {
    const connector = makeConnector({ createProduct: vi.fn(async () => { throw new PublishDeliveryError("invalid_credentials_or_permission", "token leaked should not persist"); }) });
    const harness = makeHarness();
    harness.connector = connector;
    await expect(publishApprovedProduct({ workspaceId, draftId }, harness)).rejects.toMatchObject({ code: "invalid_credentials_or_permission" });
    expect(harness.state.listing.status).toBe("publish_failed");
    expect(harness.state.jobs[0]).toMatchObject({ status: "failed", error: "invalid_credentials_or_permission" });
    expect(JSON.stringify(harness.state.jobs[0])).not.toContain("token leaked");
  });
});
