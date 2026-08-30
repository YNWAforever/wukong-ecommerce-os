import { describe, expect, it, vi } from "vitest";

import type { ListingFacts } from "@wukong/core";
import { hashCanonicalListing, type CommerceConnector } from "@wukong/shopline";
import {
  listing as canonicalListing,
  workspaceId,
} from "./pipeline-test-support.js";
import {
  PublishDeliveryError,
  publishApprovedProduct,
  SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT,
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
    existingLink: null,
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
            payloadDigest: hashCanonicalListing(canonicalListing),
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
    platformProducts: new Map<string, Record<string, unknown>>(),
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

function makeTransactionAwareHarness(
  status: PublishListingSnapshot["status"] = "approved",
  flags: PublishListingSnapshot["flags"] = [],
) {
  const harness = makeHarness(status, flags);
  harness.withWorkspace = async function <T>(
    _workspace: string,
    work: (repositories: PublishRepositories) => Promise<T>,
  ): Promise<T> {
    const transactionState = structuredClone(harness.state);
    const transactionAudits = structuredClone(harness.audits);
    const transactionRepositories = makeRepos(
      transactionState,
      transactionAudits,
    );
    const result = await work(transactionRepositories);
    Object.assign(harness.state.listing, transactionState.listing);
    harness.state.jobs.splice(
      0,
      harness.state.jobs.length,
      ...transactionState.jobs,
    );
    harness.audits.splice(0, harness.audits.length, ...transactionAudits);
    return result;
  };
  return harness;
}

function makeRepos(
  input: {
    listing: PublishListingSnapshot;
    jobs: Array<any>;
    platformProducts: Map<string, Record<string, unknown>>;
  },
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
      async recordRemoteProduct(key, leaseToken, remoteProductId) {
        const job = input.jobs.find((entry) => entry.idempotencyKey === key);
        if (!job || job.status !== "running" || job.leaseToken !== leaseToken) {
          throw new Error("publish job lease is not active");
        }
        // Mirrors the repository: the id lands while the job stays `running`
        // and keeps its lease, so a later delivery can reconcile against it.
        Object.assign(job, { remoteProductId });
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
    shoplineConnections: {
      async getById(id) {
        return id === VALID_CONNECTION_ID
          ? { id, workspaceId, verified: true }
          : null;
      },
    },
    platformProducts: {
      async getByListingId(listingId) {
        return (input.platformProducts.get(listingId) as never) ?? null;
      },
      async upsert(record) {
        input.platformProducts.set(record.listingId, { ...record });
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
  it("returns and audits stale_plan without persistence or connector work when the claimed job is missing", async () => {
    const harness = makeHarness();
    harness.state.jobs.splice(0);

    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toMatchObject({ code: "stale_plan" });

    expect(harness.state.jobs).toEqual([]);
    expect(harness.audits).toContainEqual(
      expect.objectContaining({
        action: "listing.publish_policy_rejected",
        metadata: expect.objectContaining({
          reason: "stale_plan",
          expectedVersionId: versionId,
          observedVersionId: null,
          observedPayloadDigest: null,
        }),
      }),
    );
    expect(harness.resolveImageUrls).not.toHaveBeenCalled();
    expect(harness.connector.getProductStatus).not.toHaveBeenCalled();
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it.each(["running", "failed"] as const)(
    "returns and audits stale_plan for a published listing with a %s job before connector work",
    async (jobStatus) => {
      const harness = makeHarness("published");
      harness.state.jobs[0].status = jobStatus;

      await expect(
        publishApprovedProduct(publishInput(), harness),
      ).rejects.toMatchObject({ code: "stale_plan" });

      if (jobStatus === "running") {
        expect(harness.state.jobs[0]).toMatchObject({
          status: "failed",
          error: "stale_plan",
        });
      }
      expect(harness.audits).toContainEqual(
        expect.objectContaining({
          action: "listing.publish_policy_rejected",
          metadata: expect.objectContaining({
            reason: "stale_plan",
            expectedVersionId: versionId,
            observedVersionId: versionId,
          }),
        }),
      );
      expect(harness.resolveImageUrls).not.toHaveBeenCalled();
      expect(harness.connector.getProductStatus).not.toHaveBeenCalled();
      expect(harness.connector.createProduct).not.toHaveBeenCalled();
    },
  );

  it("sanitizes stale_plan errors without leaking delivery details", () => {
    const error = new PublishDeliveryError(
      "stale_plan",
      "listing body, https://shopline.example/products/123, token=secret",
    );

    expect(error).toMatchObject({ code: "stale_plan" });
    expect(error.message).toBe(
      "The approved listing plan is no longer current",
    );
    expect(error.message).not.toMatch(/listing body|shopline\.example|secret/i);
  });

  it("marks a current-version mismatch as stale_plan with binding audit facts before connector work", async () => {
    const harness = makeHarness();
    if (!harness.state.listing.activeVersion)
      throw new Error("missing version");
    harness.state.listing.activeVersion = {
      ...harness.state.listing.activeVersion,
      id: "version_current",
    };

    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toMatchObject({
      code: "stale_plan",
    });

    expect(harness.state.jobs[0]).toMatchObject({
      status: "failed",
      error: "stale_plan",
    });
    expect(harness.audits).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          reason: "stale_plan",
          expectedVersionId: "version_current",
          observedVersionId: versionId,
        }),
      }),
    );
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it.each([null, "d".repeat(64)])(
    "marks persisted digest %j as stale_plan before connector work",
    async (persistedDigest) => {
      const harness = makeHarness();
      harness.state.jobs[0].payloadDigest = persistedDigest;

      await expect(
        publishApprovedProduct(publishInput(), harness),
      ).rejects.toMatchObject({
        code: "stale_plan",
      });

      expect(harness.state.jobs[0]).toMatchObject({
        status: "failed",
        error: "stale_plan",
      });
      expect(harness.audits).toContainEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            reason: "stale_plan",
            expectedPayloadDigest: hashCanonicalListing(canonicalListing),
            observedPayloadDigest: persistedDigest,
          }),
        }),
      );
      expect(harness.connector.createProduct).not.toHaveBeenCalled();
    },
  );

  it("commits every pre-connector terminal write before its error escapes", async () => {
    const staleVersion = makeTransactionAwareHarness();
    staleVersion.state.jobs[0].versionId = "version_stale";
    staleVersion.state.jobs[0].idempotencyKey =
      workspaceId + ":version_stale:shopline:create";

    const invalidState = makeTransactionAwareHarness("in_review");
    const blockingFlags = makeTransactionAwareHarness("approved", [
      {
        id: "flag_1",
        field: "description",
        rule: "health_claim",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      },
    ]);
    const invalidPayload = makeTransactionAwareHarness();
    if (!invalidPayload.state.listing.activeVersion) {
      throw new Error("missing active version");
    }
    invalidPayload.state.listing.activeVersion.content = {
      ...canonicalListing,
      sku: "",
    };
    invalidPayload.state.jobs[0].payloadDigest = hashCanonicalListing(
      invalidPayload.state.listing.activeVersion.content,
    );

    const scenarios = [
      {
        harness: staleVersion,
        input: publishInput({ expectedVersionId: "version_stale" }),
        code: "stale_plan",
      },
      {
        harness: invalidState,
        input: publishInput(),
        code: "not_approved",
      },
      {
        harness: blockingFlags,
        input: publishInput(),
        code: "blocking_flags",
      },
      {
        harness: invalidPayload,
        input: publishInput(),
        code: "invalid_payload",
      },
    ] as const;

    for (const scenario of scenarios) {
      await expect(
        publishApprovedProduct(scenario.input, scenario.harness),
      ).rejects.toMatchObject({ code: scenario.code });
      expect(scenario.harness.state.jobs[0]).toMatchObject({
        status: "failed",
        error: scenario.code,
        leaseToken: null,
      });
      expect(scenario.harness.connector.createProduct).not.toHaveBeenCalled();
    }
  });

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
          existingLink: null,
        } as never,
        harness,
      ),
    ).rejects.toMatchObject({ code: "stale_plan" });
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
          existingLink: null,
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
    harness.state.jobs[0].payloadDigest = hashCanonicalListing(
      harness.state.listing.activeVersion.content,
    );
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
    const payloadDigest = hashCanonicalListing(canonicalListing);
    const harness = makeHarness(
      "published",
      [],
      [
        {
          id: "job_1",
          idempotencyKey: key,
          status: "published",
          remoteProductId: "remote_existing",
          payloadDigest,
          error: null,
        },
      ],
    );
    const result = await publishApprovedProduct(publishInput(), harness);
    expect(result).toMatchObject({
      status: "published",
      remoteProductId: "remote_existing",
      payloadDigest,
    });
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("bounds the worst ambiguous remote sequence to the exported maximum", async () => {
    const calls: string[] = [];
    const connector = makeConnector({
      createProduct: vi.fn(async () => {
        calls.push("create");
        throw new PublishDeliveryError("remote_unavailable");
      }),
      getProductStatus: vi.fn(async () => {
        calls.push("status");
        if (calls.length === 1) return { exists: false, status: null };
        throw new PublishDeliveryError("remote_unavailable");
      }),
    });
    const key = workspaceId + ":" + versionId + ":shopline:create";
    const harness = makeHarness(
      "publishing",
      [],
      [
        {
          id: "job_1",
          idempotencyKey: key,
          status: "running",
          remoteProductId: "remote_ambiguous",
          payloadDigest: hashCanonicalListing(canonicalListing),
          error: null,
        },
      ],
    );
    harness.connector = connector;

    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toMatchObject({ code: "remote_unavailable" });
    expect(calls).toEqual(["status", "create", "status", "create"]);
    expect(calls).toHaveLength(SHOPLINE_MAX_REMOTE_CALLS_PER_ATTEMPT);
  });

  it("never re-creates a product when the write after a successful create fails", async () => {
    // normalizeConnectorError turns any unrecognised throw into
    // `remote_unavailable`, which does not break the create-retry loop. With
    // the completion write inside that loop, a database failure after a
    // successful create issued a second POST /products.
    const createProduct = vi.fn(async () => ({ remoteProductId: "prod_live" }));
    const harness = makeHarness("publishing");
    harness.connector = makeConnector({ createProduct });
    harness.repos.publishJobs.recordRemoteProduct = async () => {
      throw new Error("connection reset by peer");
    };

    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toThrow("connection reset by peer");

    expect(createProduct).toHaveBeenCalledTimes(1);
  });

  it("commits the remote product id before the completion write", async () => {
    const createProduct = vi.fn(async () => ({ remoteProductId: "prod_live" }));
    const harness = makeHarness("publishing");
    harness.connector = makeConnector({ createProduct });
    harness.repos.publishJobs.markPublished = async () => {
      throw new Error("connection reset by peer");
    };

    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toThrow("connection reset by peer");

    // The ledger now holds the id, so the next delivery reconciles against the
    // live product instead of creating a duplicate.
    expect(harness.state.jobs[0]?.remoteProductId).toBe("prod_live");
    expect(createProduct).toHaveBeenCalledTimes(1);
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
          payloadDigest: hashCanonicalListing(canonicalListing),
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
          payloadDigest: hashCanonicalListing(canonicalListing),
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
          payloadDigest: hashCanonicalListing(canonicalListing),
          error: null,
        },
      ],
    );
    await expect(
      publishApprovedProduct(publishInput(), harness),
    ).rejects.toThrow("Only the active approved version can be delivered");
    expect(harness.connector.createProduct).not.toHaveBeenCalled();
  });

  it("calls createProduct and records a created-origin platform_products row when no link exists", async () => {
    const harness = makeHarness();
    const connector = makeConnector({
      createProduct: vi.fn(async () => ({ remoteProductId: "remote_new_1" })),
    });

    const result = await publishApprovedProduct(publishInput(), {
      ...harness,
      connector,
    });

    expect(result.remoteProductId).toBe("remote_new_1");
    expect(connector.createProduct).toHaveBeenCalledOnce();
    expect(connector.updateProduct).not.toHaveBeenCalled();
    const link = await harness.repos.platformProducts.getByListingId(draftId);
    expect(link).toMatchObject({
      origin: "created",
      remoteProductId: "remote_new_1",
      sku: null,
      rawRow: null,
    });
  });

  it("calls updateProduct, not createProduct, and preserves import fields when a link already exists", async () => {
    const key = `${workspaceId}:${versionId}:shopline:update`;
    const harness = makeHarness(
      "approved",
      [],
      [
        {
          id: "job_1",
          idempotencyKey: key,
          status: "running",
          remoteProductId: null,
          payloadDigest: hashCanonicalListing(canonicalListing),
          error: null,
        },
      ],
    );
    // A distinct, non-null fixture (not the `canonicalListing`/`facts` fixture
    // used elsewhere in this file, which has its own producer/region/grape
    // values) so the final assertion can tell "correctly preserved" apart
    // from "correctly defaulted" or "accidentally sourced from elsewhere".
    const existingFactsPrefill: ListingFacts = {
      sku: "SKU-1",
      producer: "Imported Producer Co",
      productType: "wine",
      country: "Portugal",
      region: "Douro",
      vintage: 2018,
      grapeVarieties: ["Touriga Nacional"],
      volumeMl: 750,
      abvPercent: 14,
      packQuantity: 1,
      priceHkd: 320,
      stockQuantity: 7,
      criticScores: [],
      awards: [],
    };
    await harness.repos.platformProducts.upsert({
      connectionId: VALID_CONNECTION_ID,
      remoteProductId: "remote_existing_1",
      origin: "import",
      sku: "SKU-1",
      listingId: draftId,
      specVersion: "opak-2026-05",
      rawRow: { productId: "remote_existing_1", sku: "SKU-1" },
      factsPrefill: existingFactsPrefill,
      contentDigest: "d".repeat(64),
      sourceImportId: null,
    });
    const existingLink = {
      remoteProductId: "remote_existing_1",
      origin: "import" as const,
      sku: "SKU-1",
      specVersion: "opak-2026-05",
      rawRow: { productId: "remote_existing_1", sku: "SKU-1" },
      factsPrefill: existingFactsPrefill,
      contentDigest: "d".repeat(64),
    };
    const connector = makeConnector({
      updateProduct: vi.fn(async () => undefined),
    });

    const result = await publishApprovedProduct(
      publishInput({ existingLink }),
      { ...harness, connector },
    );

    expect(result.remoteProductId).toBe("remote_existing_1");
    expect(connector.updateProduct).toHaveBeenCalledWith(
      "remote_existing_1",
      expect.anything(),
      expect.stringContaining(":shopline:update"),
    );
    expect(connector.createProduct).not.toHaveBeenCalled();
    const link = await harness.repos.platformProducts.getByListingId(draftId);
    expect(link).toMatchObject({
      origin: "import",
      sku: "SKU-1",
      specVersion: "opak-2026-05",
      rawRow: { productId: "remote_existing_1", sku: "SKU-1" },
      factsPrefill: existingFactsPrefill,
      contentDigest: "d".repeat(64),
    });
  });
});
