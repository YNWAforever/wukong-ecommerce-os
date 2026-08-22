import { describe, expect, it, vi } from "vitest";
import type { ComplianceFlag } from "@wukong/core";
import { evaluateDeliveryPolicy } from "@wukong/shopline";

vi.mock("@wukong/shopline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wukong/shopline")>();
  return {
    ...actual,
    evaluateDeliveryPolicy: vi.fn(actual.evaluateDeliveryPolicy),
  };
});

import {
  BULK_FORM_COLUMNS,
  SHOPLINE_BULK_FORM_SPEC_VERSION,
  shoplinePublishIdempotencyKey,
} from "@wukong/shopline";
import { readBulkFormSheet } from "@wukong/shopline/bulk-form-xlsx";
import {
  confirmShoplineQueued,
  createDeliverySnapshotReader,
  deliverListing,
  prepareShoplineDelivery,
} from "./delivery-service.js";

const content = {
  sku: "OPAK-001",
  producer: "Opak",
  productType: "wine" as const,
  country: "Germany",
  region: "Mosel",
  vintage: 2024,
  grapeVarieties: ["Riesling"],
  volumeMl: 750,
  abvPercent: 12.5,
  packQuantity: 1,
  priceHkd: 288,
  stockQuantity: null,
  criticScores: [],
  awards: [],
  title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
  description: { en: "Dry wine", "zh-Hant": "乾身葡萄酒" },
  seo: {
    title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
    description: { en: "Dry wine", "zh-Hant": "乾身葡萄酒" },
  },
  tags: ["wine"],
  imageAssetIds: [],
};

const readyAuditFacts = {
  workspaceId: "ws_opak",
  draftId: "listing_1",
  method: "shopline_api",
  phase: "request" as const,
  versionId: "version_1",
  payloadDigest: "a".repeat(64),
  connectionId: "00000000-0000-4000-8000-000000000301",
  reason: "ready",
};

function deps(audits: unknown[], jobs: unknown[]): any {
  return {
    listings: {
      async requireForPublish() {
        return {
          id: "listing_1",
          target: "shopline" as const,
          status: "approved" as const,
          activeVersion: { id: "version_1", sequence: 1, content },
          flags: [],
        };
      },
    },
    imageUrls: async () => [],
    audit: {
      async write(event: unknown) {
        audits.push(event);
      },
    },
    publisher: {
      async enqueue(input: unknown) {
        jobs.push(input);
        return "job_1";
      },
    },
    connection: async () => ({
      id: "00000000-0000-4000-8000-000000000301",
      verified: true,
    }),
  };
}

describe("delivery audit and queue context", () => {
  it("reads one workspace-scoped policy snapshot with images, connection, and publish job", async () => {
    const harness = deps([], []);
    const imageUrls = vi.fn(async () => ["https://signed.example/asset-a"]);
    const existingDelivery = vi.fn(async () => ({
      id: "job_1",
      versionId: "version_1",
      status: "pending_enqueue",
      idempotencyKey: "ws_opak:version_1:shopline:create",
      payloadDigest: "digest_1",
      connectionId: "connection_1",
      remoteProductId: null,
    }));

    const snapshot = await createDeliverySnapshotReader({
      ...harness,
      imageUrls,
      connection: async () => ({ id: "connection_1", verified: true }),
      existingDelivery,
    }).read({
      workspaceId: "ws_opak",
      draftId: "listing_1",
      method: "shopline_api",
    });

    expect(snapshot).toMatchObject({
      listing: { workspaceId: "ws_opak", draftId: "listing_1" },
      connection: {
        id: "connection_1",
        workspaceId: "ws_opak",
        verified: true,
      },
      job: { id: "job_1", versionId: "version_1", status: "pending_enqueue" },
      imageUrls: ["https://signed.example/asset-a"],
    });
    expect(imageUrls).toHaveBeenCalledWith("ws_opak", "listing_1", []);
    expect(existingDelivery).toHaveBeenCalledWith(
      "ws_opak:version_1:shopline:create",
    );
  });

  it.each(["csv", "shopline_api"] as const)(
    "keeps direct %s delivery eager with one policy decision",
    async (method) => {
      const audits: unknown[] = [];
      vi.mocked(evaluateDeliveryPolicy).mockClear();
      const harness = deps(audits, []);
      const imageUrls = vi.fn(async () => ["https://signed.example/asset-a"]);
      harness.imageUrls = imageUrls;
      harness.listings.requireForPublish = async () => ({
        id: "listing_1",
        target: "shopline" as const,
        status: "approved" as const,
        activeVersion: {
          id: "version_1",
          sequence: 1,
          content: { ...content, imageAssetIds: ["asset_a"] },
        },
        flags: [],
      });

      await deliverListing(
        {
          workspaceId: "ws_opak",
          actorId: "reviewer_1",
          draftId: "listing_1",
          method,
        },
        harness,
      );

      expect(imageUrls).toHaveBeenCalledTimes(1);
      expect(evaluateDeliveryPolicy).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(evaluateDeliveryPolicy).mock.calls[0]?.[0],
      ).toMatchObject({
        imageUrls: ["https://signed.example/asset-a"],
      });
    },
  );

  it("preflights Shopline preparation before resolving image URLs", async () => {
    const audits: unknown[] = [];
    vi.mocked(evaluateDeliveryPolicy).mockClear();
    const harness = deps(audits, []);
    const imageUrls = vi.fn(async () => ["https://signed.example/asset-a"]);
    harness.imageUrls = imageUrls;
    harness.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "approved" as const,
      activeVersion: {
        id: "version_1",
        sequence: 1,
        content: { ...content, imageAssetIds: ["asset_a"] },
      },
      flags: [],
    });
    harness.publishJobs = {
      async ensure(input: any) {
        return { ...input, id: "job_db_1", status: "pending_enqueue" };
      },
      async markQueued() {
        return true;
      },
    };

    await prepareShoplineDelivery(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );

    expect(imageUrls).toHaveBeenCalledTimes(1);
    expect(evaluateDeliveryPolicy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(evaluateDeliveryPolicy).mock.calls[0]?.[0]).toMatchObject({
      imageUrls: [],
    });
    expect(vi.mocked(evaluateDeliveryPolicy).mock.calls[1]?.[0]).toMatchObject({
      imageUrls: ["https://signed.example/asset-a"],
    });
  });

  it("persists pending enqueue and publish requested before queue ingress", async () => {
    const audits: any[] = [];
    const jobs: any[] = [];
    const harness = deps(audits, jobs);
    harness.publishJobs = {
      async ensure(input: any) {
        const job = { id: "job_db_1", status: "pending_enqueue", ...input };
        jobs.push(job);
        return job;
      },
      async markQueued() {
        throw new Error("confirmation must happen after ingress");
      },
    };

    await expect(
      prepareShoplineDelivery(
        {
          workspaceId: "ws_opak",
          actorId: "reviewer_1",
          draftId: "listing_1",
          method: "shopline_api",
        },
        harness,
      ),
    ).resolves.toEqual({
      kind: "publish_request",
      jobId: "job_db_1",
      versionId: "version_1",
      connectionId: "00000000-0000-4000-8000-000000000301",
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      draftId: "listing_1",
      idempotencyKey: "ws_opak:version_1:shopline:create",
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      auditFacts: expect.objectContaining({ reason: "ready" }),
    });
    expect(jobs[0]).toMatchObject({ status: "pending_enqueue" });
    expect(audits.map((event) => event.action)).toEqual([
      "listing.publish_requested",
    ]);
    expect(audits[0]).toMatchObject({
      metadata: expect.objectContaining({
        versionId: "version_1",
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reason: "ready",
      }),
    });
  });

  it("uses the persisted pending job connection when the default rotates", async () => {
    const audits: any[] = [];
    const harness = deps(audits, []);
    const persistedConnectionId = "00000000-0000-4000-8000-000000000302";
    harness.publishJobs = {
      async ensure(input: any) {
        return {
          ...input,
          id: "job_db_1",
          status: "pending_enqueue",
          connectionId: persistedConnectionId,
        };
      },
      async markQueued() {
        return true;
      },
    };

    const prepared = await prepareShoplineDelivery(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );
    expect(prepared).toMatchObject({
      kind: "publish_request",
      jobId: "job_db_1",
      connectionId: persistedConnectionId,
    });
    if (prepared.kind !== "publish_request")
      throw new Error("expected publish request");
    await confirmShoplineQueued(prepared, {
      audit: harness.audit,
      publishJobs: harness.publishJobs,
    });
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        metadata: expect.objectContaining({
          connectionId: persistedConnectionId,
        }),
      });
    }
  });

  it("returns retry required for a reused failed job before ingress", async () => {
    const audits: any[] = [];
    const harness = deps(audits, []);
    harness.publishJobs = {
      async ensure(input: any) {
        return {
          ...input,
          id: "job_db_1",
          status: "failed",
        };
      },
      async markQueued() {
        return false;
      },
    };

    await expect(
      prepareShoplineDelivery(
        {
          workspaceId: "ws_opak",
          actorId: "reviewer_1",
          draftId: "listing_1",
          method: "shopline_api",
        },
        harness,
      ),
    ).resolves.toEqual({
      kind: "retry_required",
      jobId: "job_db_1",
      versionId: "version_1",
    });
    expect(audits).toEqual([]);
  });

  it("returns retry required when a reused job fails before confirmation", async () => {
    const audits: any[] = [];
    const prepared = {
      kind: "publish_request" as const,
      jobId: "job_db_1",
      versionId: "version_1",
      connectionId: "00000000-0000-4000-8000-000000000301",
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      draftId: "listing_1",
      idempotencyKey: "ws_opak:version_1:shopline:create",
      payloadDigest: "a".repeat(64),
      auditFacts: readyAuditFacts,
    };

    await expect(
      confirmShoplineQueued(prepared, {
        audit: {
          async write(event: any) {
            audits.push(event);
          },
        },
        publishJobs: {
          async markQueued() {
            return false;
          },
          async getByIdempotencyKey() {
            return { id: "job_db_1", status: "failed" };
          },
        },
      }),
    ).resolves.toEqual({
      kind: "retry_required",
      jobId: "job_db_1",
      versionId: "version_1",
    });
    expect(audits).toEqual([]);
  });

  it("confirms a queued delivery only after ingress acceptance", async () => {
    const audits: any[] = [];
    const statuses = ["pending_enqueue"];
    const prepared = {
      kind: "publish_request" as const,
      jobId: "job_db_1",
      versionId: "version_1",
      connectionId: "00000000-0000-4000-8000-000000000301",
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      draftId: "listing_1",
      idempotencyKey: "ws_opak:version_1:shopline:create",
      payloadDigest: "a".repeat(64),
      auditFacts: readyAuditFacts,
    };

    await expect(
      confirmShoplineQueued(prepared, {
        audit: {
          async write(event: any) {
            audits.push(event);
          },
        },
        publishJobs: {
          async markQueued() {
            statuses.push("queued");
            return true;
          },
        },
      }),
    ).resolves.toEqual({
      kind: "queued",
      jobId: "job_db_1",
      versionId: "version_1",
    });
    expect(statuses).toEqual(["pending_enqueue", "queued"]);
    expect(audits.map((event) => event.action)).toEqual([
      "listing.publish_queued",
    ]);
    expect(audits[0]).toMatchObject({
      metadata: expect.objectContaining({
        versionId: "version_1",
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reason: "ready",
      }),
    });
  });

  it("does not regress or re-audit a fast consumer state during confirmation", async () => {
    const audits: any[] = [];
    const status = { value: "running" };
    await confirmShoplineQueued(
      {
        kind: "publish_request",
        jobId: "job_db_1",
        versionId: "version_1",
        connectionId: "00000000-0000-4000-8000-000000000301",
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        idempotencyKey: "ws_opak:version_1:shopline:create",
        payloadDigest: "a".repeat(64),
        auditFacts: readyAuditFacts,
      },
      {
        audit: {
          async write(event: any) {
            audits.push(event);
          },
        },
        publishJobs: {
          async markQueued() {
            return false;
          },
        },
      },
    );
    expect(status.value).toBe("running");
    expect(audits).toEqual([]);
  });

  it("includes actor and workspace in CSV audit", async () => {
    const audits: unknown[] = [];
    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "csv",
      },
      deps(audits, []),
    );
    expect(result.kind).toBe("csv");
    expect(audits[0]).toMatchObject({
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      entityId: "listing_1",
      action: "listing.csv_exported",
      metadata: expect.objectContaining({
        versionId: "version_1",
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
  });

  it("queues approved API delivery through the injected publisher with tenant identity", async () => {
    const audits: unknown[] = [];
    const jobs: unknown[] = [];
    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      deps(audits, jobs),
    );
    expect(result).toMatchObject({ kind: "queued", jobId: "job_1" });
    expect(jobs[0]).toMatchObject({
      workspaceId: "ws_opak",
      draftId: "listing_1",
      versionId: "version_1",
    });
    expect(audits[0]).toMatchObject({
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      entityId: "listing_1",
      action: "listing.publish_queued",
    });
  });

  it("follows policy by ignoring a resolved blocking flag", async () => {
    const audits: unknown[] = [];
    const harness = deps(audits, []);
    harness.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "approved" as const,
      activeVersion: { id: "version_1", sequence: 1, content },
      flags: [
        {
          id: "flag_1",
          field: "description",
          rule: "health_claim" as const,
          severity: "blocking" as const,
          status: "resolved" as const,
          resolutionReason: "too short",
        },
      ],
    });
    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );
    expect(result).toMatchObject({ kind: "queued", jobId: "job_1" });
  });

  it("does not enqueue a new job for a published listing without a stored result", async () => {
    const audits: unknown[] = [];
    const jobs: unknown[] = [];
    const harness = deps(audits, jobs);
    harness.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "published" as const,
      activeVersion: { id: "version_1", sequence: 1, content },
      flags: [],
    });
    harness.existingDelivery = async () => null;
    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );
    expect(result).toEqual({
      kind: "already_published",
      remoteProductId: null,
    });
    expect(jobs).toHaveLength(0);
  });

  it("writes ordered signed image URLs into CSV output", async () => {
    const audits: unknown[] = [];
    const harness = deps(audits, []);
    const imageUrls = vi.fn(async () => [
      "https://signed.example/asset-b",
      "https://signed.example/asset-a",
    ]);
    harness.imageUrls = imageUrls;
    harness.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "approved" as const,
      activeVersion: {
        id: "version_1",
        sequence: 1,
        content: {
          ...content,
          imageAssetIds: ["asset_b", "asset_a"],
        },
      },
      flags: [],
    });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "csv",
      },
      harness,
    );

    expect(imageUrls).toHaveBeenCalledWith("ws_opak", "listing_1", [
      "asset_b",
      "asset_a",
    ]);
    expect(result.kind).toBe("csv");
    if (result.kind !== "csv") throw new Error("expected CSV delivery");
    expect(result.body.indexOf("https://signed.example/asset-b")).toBeLessThan(
      result.body.indexOf("https://signed.example/asset-a"),
    );
  });

  it("keeps the queue digest stable when signed image URLs rotate", async () => {
    const firstJobs: unknown[] = [];
    const first = deps([], firstJobs);
    first.imageUrls = async () => ["https://signed.example/first"];
    first.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "approved" as const,
      activeVersion: {
        id: "version_1",
        sequence: 1,
        content: { ...content, imageAssetIds: ["asset_a"] },
      },
      flags: [],
    });

    const secondJobs: unknown[] = [];
    const second = deps([], secondJobs);
    second.imageUrls = async () => ["https://signed.example/second"];
    second.listings.requireForPublish = first.listings.requireForPublish;

    await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      first,
    );
    await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      second,
    );

    expect(firstJobs[0]).toMatchObject({
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(secondJobs[0]).toMatchObject({
      payloadDigest: (firstJobs[0] as { payloadDigest: string }).payloadDigest,
    });
  });

  it("resolves assets before returning an existing published outcome", async () => {
    const harness = deps([], []);
    const imageUrls = vi.fn(async () => ["https://signed.example/asset-a"]);
    harness.imageUrls = imageUrls;
    harness.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "published" as const,
      activeVersion: {
        id: "version_1",
        sequence: 1,
        content: { ...content, imageAssetIds: ["asset_a"] },
      },
      flags: [],
    });
    harness.existingDelivery = async () => ({
      status: "published",
      remoteProductId: "remote_existing",
    });

    await expect(
      deliverListing(
        {
          workspaceId: "ws_opak",
          actorId: "reviewer_1",
          draftId: "listing_1",
          method: "shopline_api",
        },
        harness,
      ),
    ).resolves.toEqual({
      kind: "already_published",
      remoteProductId: "remote_existing",
    });
    expect(imageUrls).toHaveBeenCalledOnce();
  });

  it("resolves assets before returning a disconnected outcome", async () => {
    const harness = deps([], []);
    const imageUrls = vi.fn(async () => ["https://signed.example/asset-a"]);
    harness.imageUrls = imageUrls;
    harness.connection = async () => null;
    harness.listings.requireForPublish = async () => ({
      id: "listing_1",
      target: "shopline" as const,
      status: "approved" as const,
      activeVersion: {
        id: "version_1",
        sequence: 1,
        content: { ...content, imageAssetIds: ["asset_a"] },
      },
      flags: [],
    });

    await expect(
      deliverListing(
        {
          workspaceId: "ws_opak",
          actorId: "reviewer_1",
          draftId: "listing_1",
          method: "shopline_api",
        },
        harness,
      ),
    ).resolves.toEqual({
      kind: "disconnected",
      csvFallback: {
        method: "csv",
        path: "/api/listings/listing_1/deliver",
      },
    });
    expect(imageUrls).toHaveBeenCalledOnce();
  });
});

describe("request-phase platform product link resolution", () => {
  it("computes an update idempotency key when the platform product link is present", async () => {
    const harness = deps([], []);
    harness.platformProducts = {
      async getByListingId() {
        return { remoteProductId: "remote_1", rawRow: null };
      },
    };
    harness.publishJobs = {
      async ensure(input: any) {
        return { ...input, id: "job_db_1", status: "pending_enqueue" };
      },
      async markQueued() {
        return true;
      },
    };

    const prepared = await prepareShoplineDelivery(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );

    if (prepared.kind !== "publish_request")
      throw new Error("expected publish request");
    expect(prepared.idempotencyKey).toBe(
      shoplinePublishIdempotencyKey("ws_opak", "version_1", "update"),
    );
  });

  it("computes a create idempotency key when the platform product link is absent", async () => {
    const harness = deps([], []);
    harness.platformProducts = {
      async getByListingId() {
        return null;
      },
    };
    harness.publishJobs = {
      async ensure(input: any) {
        return { ...input, id: "job_db_1", status: "pending_enqueue" };
      },
      async markQueued() {
        return true;
      },
    };

    const prepared = await prepareShoplineDelivery(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );

    if (prepared.kind !== "publish_request")
      throw new Error("expected publish request");
    expect(prepared.idempotencyKey).toBe(
      shoplinePublishIdempotencyKey("ws_opak", "version_1", "create"),
    );
  });

  it("looks up the existing delivery with the update idempotency key when the platform product link is present", async () => {
    const harness = deps([], []);
    harness.platformProducts = {
      async getByListingId() {
        return { remoteProductId: "remote_1", rawRow: null };
      },
    };
    const existingDelivery = vi.fn(async () => null);
    harness.existingDelivery = existingDelivery;
    harness.publishJobs = {
      async ensure(input: any) {
        return { ...input, id: "job_db_1", status: "pending_enqueue" };
      },
      async markQueued() {
        return true;
      },
    };

    const prepared = await prepareShoplineDelivery(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "shopline_api",
      },
      harness,
    );

    if (prepared.kind !== "publish_request")
      throw new Error("expected publish request");
    expect(existingDelivery).toHaveBeenCalledTimes(1);
    const calledKey = existingDelivery.mock.calls[0]?.[0];
    expect(calledKey).toBe(
      shoplinePublishIdempotencyKey("ws_opak", "version_1", "update"),
    );
    expect(calledKey).toMatch(/:shopline:update$/);
  });
});

describe("bulk-form export", () => {
  const platformProduct = {
    remoteProductId: "remote_1",
    rawRow: Object.fromEntries(
      BULK_FORM_COLUMNS.map((column) => [
        column.key,
        column.key === "nameEn" || column.key === "nameZh"
          ? "Demo Estate Riesling 2024"
          : "",
      ]),
    ),
  };

  function bulkFormDeps(
    options: {
      status?: "approved" | "published" | "in_review";
      hasLink?: boolean;
      flags?: ComplianceFlag[];
    } = {},
  ) {
    const audits: unknown[] = [];
    return {
      audits,
      deps: {
        listings: {
          async requireForPublish() {
            return {
              id: "listing_1",
              target: "shopline" as const,
              status: options.status ?? "approved",
              activeVersion: { id: "version_1", sequence: 1, content },
              flags: options.flags ?? [],
            };
          },
        },
        imageUrls: async () => [],
        audit: {
          async write(event: unknown) {
            audits.push(event);
          },
        },
        publisher: {
          async enqueue() {
            throw new Error("bulk_form must not enqueue a publish job");
          },
        },
        platformProducts: {
          async getByListingId() {
            return options.hasLink === false ? null : platformProduct;
          },
        },
      },
    };
  }

  it("exports an .xlsx workbook for an approved, linked listing", async () => {
    const { deps, audits } = bulkFormDeps();

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result.kind).toBe("bulk_form");
    if (result.kind !== "bulk_form") throw new Error("expected bulk_form");
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(result.body.length).toBeGreaterThan(0);
    expect(result.specVersion).toBe(SHOPLINE_BULK_FORM_SPEC_VERSION);
    expect(audits).toEqual([
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        action: "listing.bulk_form_exported",
        entityId: "listing_1",
        metadata: {
          specVersion: SHOPLINE_BULK_FORM_SPEC_VERSION,
          versionId: "version_1",
          remoteProductId: "remote_1",
        },
      },
    ]);
  });

  it("maps the canonical listing onto the eight enrichable columns", async () => {
    const { deps } = bulkFormDeps();

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    if (result.kind !== "bulk_form") throw new Error("expected bulk_form");
    const sheet = readBulkFormSheet(result.body);
    const header = sheet[0];
    const dataRow = sheet[2];
    if (!header || !dataRow) throw new Error("expected header and data rows");

    const expected: Record<string, string> = {
      "Product Name (Traditional Chinese)": content.title["zh-Hant"],
      "Product Summary (English)": content.description.en,
      "Product Summary (Traditional Chinese)": content.description["zh-Hant"],
      "SEO Title (English)": content.seo.title.en,
      "SEO Title (Traditional Chinese)": content.seo.title["zh-Hant"],
      "SEO Description (English)": content.seo.description.en,
      "SEO Description (Traditional Chinese)":
        content.seo.description["zh-Hant"],
      "SEO Keywords": content.tags.join(", "),
    };
    for (const [columnHeader, value] of Object.entries(expected)) {
      const index = header.indexOf(columnHeader);
      expect(
        index,
        `missing column header "${columnHeader}"`,
      ).toBeGreaterThanOrEqual(0);
      expect(dataRow[index]).toBe(value);
    }
  });

  it("throws when deps.platformProducts is not supplied at all", async () => {
    const audits: unknown[] = [];
    const deps = {
      listings: {
        async requireForPublish() {
          return {
            id: "listing_1",
            target: "shopline" as const,
            status: "approved" as const,
            activeVersion: { id: "version_1", sequence: 1, content },
            flags: [],
          };
        },
      },
      imageUrls: async () => [],
      audit: {
        async write(event: unknown) {
          audits.push(event);
        },
      },
      publisher: {
        async enqueue() {
          throw new Error("bulk_form must not enqueue a publish job");
        },
      },
      // platformProducts intentionally omitted — a wiring bug, not the
      // "no linked product" business case (which supplies the dep and has
      // it return null instead).
    };

    await expect(
      deliverListing(
        {
          workspaceId: "ws_opak",
          actorId: "reviewer_1",
          draftId: "listing_1",
          method: "bulk_form",
        },
        deps,
      ),
    ).rejects.toThrow("deliverBulkForm requires deps.platformProducts");
    expect(audits).toEqual([]);
  });

  it("refuses an unapproved listing", async () => {
    const { deps, audits } = bulkFormDeps({ status: "in_review" });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result).toEqual({ kind: "approval_required" });
    expect(audits).toEqual([]);
  });

  it("refuses a listing with no linked platform product", async () => {
    const { deps, audits } = bulkFormDeps({ hasLink: false });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result).toEqual({ kind: "no_remote_link" });
    expect(audits).toEqual([]);
  });

  it("refuses an approved listing with an open blocking compliance flag", async () => {
    const { deps, audits } = bulkFormDeps({
      flags: [
        {
          id: "flag_1",
          field: "description",
          rule: "health_claim",
          severity: "blocking",
          status: "open",
          resolutionReason: null,
        },
      ],
    });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result).toEqual({
      kind: "blocking_flags",
      issues: ["description: health_claim"],
    });
    expect(audits).toEqual([]);
  });

  it("still exports when the only flags are a warning or a resolved blocking flag", async () => {
    const { deps, audits } = bulkFormDeps({
      flags: [
        {
          id: "flag_1",
          field: "description",
          rule: "superlative",
          severity: "warning",
          status: "open",
          resolutionReason: null,
        },
        {
          id: "flag_2",
          field: "title",
          rule: "guarantee",
          severity: "blocking",
          status: "resolved",
          resolutionReason: "reviewed and cleared",
        },
      ],
    });

    const result = await deliverListing(
      {
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        draftId: "listing_1",
        method: "bulk_form",
      },
      deps,
    );

    expect(result.kind).toBe("bulk_form");
    expect(audits).toHaveLength(1);
  });
});
