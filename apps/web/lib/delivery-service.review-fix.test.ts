import { describe, expect, it, vi } from "vitest";

import { deliverListing } from "./delivery-service.js";

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
    connection: { id: "00000000-0000-4000-8000-000000000301", verified: true },
  };
}

describe("delivery audit and queue context", () => {
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

  it("blocks API delivery when a resolved blocking flag has a short reason", async () => {
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
    expect(result.kind).toBe("blocking_flags");
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

  it("returns an existing published outcome without resolving unused images", async () => {
    const harness = deps([], []);
    const imageUrls = vi.fn(async () => {
      throw new Error("images must not resolve");
    });
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
    expect(imageUrls).not.toHaveBeenCalled();
  });

  it("returns disconnected without resolving unused images", async () => {
    const harness = deps([], []);
    const imageUrls = vi.fn(async () => {
      throw new Error("images must not resolve");
    });
    harness.imageUrls = imageUrls;
    harness.connection = null;
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
    expect(imageUrls).not.toHaveBeenCalled();
  });
});
