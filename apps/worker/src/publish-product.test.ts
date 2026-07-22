import { describe, expect, it, vi } from "vitest";

import type { CommerceConnector } from "@wukong/shopline";
import {
  listing as canonicalListing,
  workspaceId,
} from "./pipeline-test-support.js";
import {
  PublishDeliveryError,
  publishApprovedProduct,
  type PublishListingSnapshot,
  type PublishRepositories,
} from "./publish-product.js";

const versionId = "version_approved";
const VALID_CONNECTION_ID = "00000000-0000-4000-8000-000000000001";
const LEASE_TOKEN = "lease_token_1";
const draftId = "draft_1";

function publishInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId,
    draftId,
    expectedVersionId: versionId,
    leaseToken: LEASE_TOKEN,
    ...overrides,
  };
}

function makeConnector(
  overrides: Partial<CommerceConnector> = {},
): CommerceConnector {
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
  connectorId: string | null = VALID_CONNECTION_ID,
) {
  const audits: Array<{ action: string; metadata: Record<string, unknown> }> =
    [];
  const listing: PublishListingSnapshot = {
    id: draftId,
    target: "shopline",
    status,
    activeVersion: { id: versionId, sequence: 2, content: canonicalListing },
    flags,
  };
  const initialJobs =
    jobs.length > 0
      ? jobs
      : [
          {
            id: "job_1",
            listingId: draftId,
            versionId,
            connectionId: VALID_CONNECTION_ID,
            idempotencyKey: `${workspaceId}:${versionId}:shopline:create`,
            status: "running",
            remoteProductId: null,
            payloadDigest: null,
            error: null,
            leaseToken: LEASE_TOKEN,
          },
        ];
  const state = {
    listing,
    jobs: initialJobs.map((job) => ({
      listingId: draftId,
      versionId,
      connectionId: VALID_CONNECTION_ID,
      leaseToken: LEASE_TOKEN,
      ...job,
    })),
  };
  const repos = makeRepos(state, audits);
  const deps = {
    connector: makeConnector(),
    connectionId: connectorId ?? undefined,
    resolveImageUrls: vi.fn(async () => []),
    async withWorkspace<T>(
      _workspace: string,
      work: (repositories: PublishRepositories) => Promise<T>,
    ) {
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
      async requireForPublish() {
        return input.listing;
      },
      async beginPublish() {
        input.listing.status = "publishing";
      },
      async markPublished(
        _id,
        _versionId,
        _remoteId,
        _digest,
        _context,
        audit,
      ) {
        input.listing.status = "published";
        await audit.write({
          workspaceId,
          actorId: "worker:shopline-publish",
          entityId: draftId,
          action: "listing.published",
          metadata: { remoteProductId: _remoteId, payloadDigest: _digest },
        });
      },
      async markPublishFailed(_id, _versionId, _errorCode, _context, audit) {
        input.listing.status = "publish_failed";
        await audit.write({
          workspaceId,
          actorId: "worker:shopline-publish",
          entityId: draftId,
          action: "listing.publish_failed",
          metadata: { errorCode: _errorCode },
        });
      },
    },
    publishJobs: {
      async getByIdempotencyKey(key) {
        return input.jobs.find((job) => job.idempotencyKey === key) ?? null;
      },
      async markPublished(key, leaseToken, remoteProductId, payloadDigest) {
        const job = input.jobs.find((entry) => entry.idempotencyKey === key);
        if (!job || job.status !== "running" || job.leaseToken !== leaseToken) {
          throw new Error("publish job lease is not active");
        }
        Object.assign(job, {
          status: "published",
          remoteProductId,
          payloadDigest,
          leaseToken: null,
        });
      },
      async markFailed(key, leaseToken, errorCode) {
        const job = input.jobs.find((entry) => entry.idempotencyKey === key);
        if (!job || job.status !== "running" || job.leaseToken !== leaseToken) {
          throw new Error("publish job lease is not active");
        }
        Object.assign(job, {
          status: "failed",
          error: errorCode,
          leaseToken: null,
        });
      },
    },
    audit: {
      async write(event) {
        audits.push({ action: event.action, metadata: event.metadata });
      },
    },
  };
}

describe("publishApprovedProduct", () => {
  it("rejects an active-version mismatch before connector work", async () => {
    const harness = makeHarness();
    const staleVersionId = "version_stale";
    harness.state.jobs[0].versionId = staleVersionId;
    harness.state.jobs[0].idempotencyKey = `${workspaceId}:${staleVersionId}:shopline:create`;

    await expect(
      publishApprovedProduct(
        {
          workspaceId,
          draftId,
          expectedVersionId: staleVersionId,
          leaseToken: LEASE_TOKEN,
        } as never,
        harness,
      ),
    ).rejects.toMatchObject({ code: "not_approved" });
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("supplies the active lease token to terminal credential persistence", async () => {
    const connector = makeConnector({
      createProduct: vi.fn(async () => {
        throw new PublishDeliveryError("invalid_credentials_or_permission");
      }),
    });
    const harness = makeHarness();
    harness.connector = connector;
    const markFailed = vi.spyOn(harness.repos.publishJobs, "markFailed");

    await expect(
      publishApprovedProduct(
        {
          workspaceId,
          draftId,
          expectedVersionId: versionId,
          leaseToken: LEASE_TOKEN,
        } as never,
        harness,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials_or_permission" });
    expect(markFailed).toHaveBeenCalledWith(
      `${workspaceId}:${versionId}:shopline:create`,
      LEASE_TOKEN,
      "invalid_credentials_or_permission",
    );
  });

  it("rejects delivery before approval without calling SHOPLINE", async () => {
    const harness = makeHarness("in_review");
    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toThrow("Only the active approved version can be delivered");
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("rejects unresolved blocking flags before any connector call", async () => {
    const harness = makeHarness("approved", [
      {
        id: "flag_1",
        field: "description",
        rule: "health_claim",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      },
    ]);
    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toThrow(/blocking compliance flags/i);
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("publishes an approved active version and stores only digest and remote id", async () => {
    const harness = makeHarness();
    const result = await publishApprovedProduct(publishInput(), harness);
    expect(result).toMatchObject({
      status: "published",
      remoteProductId: "remote_123",
      idempotencyKey: `${workspaceId}:${versionId}:shopline:create`,
    });
    expect(result.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.connector.createProduct).toHaveBeenCalledTimes(1);
    expect(harness.state.listing.status).toBe("published");
    expect(harness.state.jobs[0]).toMatchObject({
      status: "published",
      remoteProductId: "remote_123",
      payloadDigest: result.payloadDigest,
    });
    expect(harness.state.jobs[0].connectionId).toBe(VALID_CONNECTION_ID);
    expect(JSON.stringify(harness.state.jobs[0])).not.toContain(
      "Demo Estate Riesling",
    );
    expect(harness.audits.map((entry) => entry.action)).toContain(
      "listing.published",
    );
  });

  it("passes workspace, draft, and ordered asset IDs to image resolution", async () => {
    const harness = makeHarness();
    const resolveImageUrls = vi.fn(async () => [
      "https://signed.example/asset-1",
    ]);

    await publishApprovedProduct(publishInput(), {
      ...harness,
      resolveImageUrls,
    });

    expect(resolveImageUrls).toHaveBeenCalledWith(
      workspaceId,
      draftId,
      canonicalListing.imageAssetIds,
    );
  });

  it("publishes ordered resolved image URLs through the connector", async () => {
    const harness = makeHarness();
    if (!harness.state.listing.activeVersion)
      throw new Error("missing version");
    harness.state.listing.activeVersion.content = {
      ...canonicalListing,
      imageAssetIds: ["asset_b", "asset_a"],
    };
    const resolveImageUrls = vi.fn(async () => [
      "https://signed.example/asset-b",
      "https://signed.example/asset-a",
    ]);

    await publishApprovedProduct(publishInput(), {
      ...harness,
      resolveImageUrls,
    });

    expect(resolveImageUrls).toHaveBeenCalledWith(workspaceId, draftId, [
      "asset_b",
      "asset_a",
    ]);
    expect(harness.connector.createProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        product: expect.objectContaining({
          images: [
            "https://signed.example/asset-b",
            "https://signed.example/asset-a",
          ],
        }),
      }),
      `${workspaceId}:${versionId}:shopline:create`,
    );
  });

  it("fails closed when image resolution is unavailable", async () => {
    const harness = makeHarness();

    await expect(
      publishApprovedProduct(publishInput(), {
        ...harness,
        resolveImageUrls: undefined,
      } as never),
    ).rejects.toThrow();

    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });
  it("keeps the payload digest stable when signed image URLs rotate", async () => {
    const first = makeHarness();
    const second = makeHarness();

    const firstResult = await publishApprovedProduct(publishInput(), {
      ...first,
      resolveImageUrls: async () => ["https://signed.example/first"],
    });
    const secondResult = await publishApprovedProduct(publishInput(), {
      ...second,
      resolveImageUrls: async () => ["https://signed.example/second"],
    });

    expect(firstResult.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(secondResult.payloadDigest).toBe(firstResult.payloadDigest);
  });
  it("returns an existing published delivery without calling SHOPLINE twice", async () => {
    const key = `${workspaceId}:${versionId}:shopline:create`;
    const harness = makeHarness(
      "published",
      [],
      [
        {
          id: "job_1",
          idempotencyKey: key,
          status: "published",
          remoteProductId: "remote_existing",
          payloadDigest: "d".repeat(64),
          error: null,
        },
      ],
    );
    const result = await publishApprovedProduct(publishInput(), harness);
    expect(result).toMatchObject({
      status: "published",
      remoteProductId: "remote_existing",
      payloadDigest: "d".repeat(64),
    });
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous write with remote status before retrying", async () => {
    const key = `${workspaceId}:${versionId}:shopline:create`;
    const connector = makeConnector({
      createProduct: vi.fn(async () => {
        throw new PublishDeliveryError("remote_unavailable");
      }),
      getProductStatus: vi.fn(async () => ({ exists: true, status: false })),
    });
    const harness = makeHarness(
      "publishing",
      [],
      [
        {
          id: "job_1",
          idempotencyKey: key,
          status: "running",
          remoteProductId: "remote_existing",
          payloadDigest: null,
          error: null,
        },
      ],
    );
    harness.connector = connector;
    const result = await publishApprovedProduct(publishInput(), harness);
    expect(result.remoteProductId).toBe("remote_existing");
    expect(connector.getProductStatus).toHaveBeenCalledWith("remote_existing");
    expect(connector.createProduct).toHaveBeenCalledTimes(0);
  });

  it("marks terminal connector failures with a sanitized error code", async () => {
    const connector = makeConnector({
      createProduct: vi.fn(async () => {
        throw new PublishDeliveryError(
          "invalid_credentials_or_permission",
          "token leaked should not persist",
        );
      }),
    });
    const harness = makeHarness();
    harness.connector = connector;
    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toMatchObject({ code: "invalid_credentials_or_permission" });
    expect(harness.state.listing.status).toBe("publish_failed");
    expect(harness.state.jobs[0]).toMatchObject({
      status: "failed",
      error: "invalid_credentials_or_permission",
    });
    expect(JSON.stringify(harness.state.jobs[0])).not.toContain("token leaked");
  });

  it("publishes a reclaimed delivery with the same idempotency key", async () => {
    const key = `${workspaceId}:${versionId}:shopline:create`;
    const harness = makeHarness(
      "publish_failed",
      [],
      [
        {
          id: "job_retry",
          idempotencyKey: key,
          status: "running",
          remoteProductId: null,
          payloadDigest: null,
          error: "remote_unavailable",
        },
      ],
    );
    const result = await publishApprovedProduct(publishInput(), harness);
    expect(result.remoteProductId).toBe("remote_123");
    expect(harness.connector.createProduct).toHaveBeenCalledTimes(1);
    expect(harness.state.listing.status).toBe("published");
  });
  it("rejects missing or invalid connector identity before tenant mutation or HTTP", async () => {
    const missing = makeHarness("approved", [], [], null);
    await expect(
      publishApprovedProduct(publishInput(), missing),
    ).rejects.toMatchObject({ code: "invalid_connection" });
    expect(missing.state.jobs[0]).toMatchObject({ status: "running" });
    expect(missing.connector.createProduct).not.toHaveBeenCalled();

    const invalid = makeHarness("approved");
    await expect(
      publishApprovedProduct(
        publishInput({ connectionId: "shopline-default" }),
        invalid,
      ),
    ).rejects.toMatchObject({ code: "invalid_connection" });
    expect(invalid.state.jobs[0]).toMatchObject({ status: "running" });
    expect(invalid.connector.createProduct).not.toHaveBeenCalled();
  });

  it("does not return a published duplicate after the listing is reopened", async () => {
    const key = `${workspaceId}:${versionId}:shopline:create`;
    const harness = makeHarness(
      "reopened",
      [],
      [
        {
          id: "job_reopened",
          idempotencyKey: key,
          status: "running",
          remoteProductId: "remote_old",
          payloadDigest: "e".repeat(64),
          error: null,
        },
      ],
    );
    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toThrow("Only the active approved version can be delivered");
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });
});
