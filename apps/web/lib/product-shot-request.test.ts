const runtimeMocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({
    forWorkspace: async (_ws: string, fn: (r: any) => Promise<unknown>) =>
      fn({
        productShots: { currentForListing: async () => null },
        sourceAssets: { listForListing: async () => [] },
      }),
  })),
  getAssetStore: vi.fn(() => ({})),
}));
vi.mock("./intake-runtime.js", () => runtimeMocks);
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { MemoryAssetStore } from "@wukong/assets";
import type { Database } from "@wukong/db";
import {
  attachProductShotSource,
  requestProductShot,
  requestProductShotFromProcess,
} from "./product-shot-request.js";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = { workspaceId: "ws", listingId: id(1), actorId: "actor" };
async function fixture(count = 1) {
  const store = new MemoryAssetStore(),
    bytes = new Uint8Array([1, 2, 3]);
  const assets = Array.from({ length: count }, (_, i) => ({
    id: id(i + 2),
    workspaceId: "ws",
    listingId: id(1),
    kind: "image/png",
    storageKey: `ws/ws/sources/${id(i + 2)}/input.png`,
    metadata: { clientSha256: "untrusted" },
  }));
  for (const a of assets)
    await store.writeObject("ws", a.storageKey, bytes, "image/png");
  let current: any = null;
  const ensure = vi.fn(async (data: any) => {
    current = { ...data, attemptId: id(9), state: "queued" };
    return { attemptId: id(9) };
  });
  const repos = {
    sourceAssets: { listForListing: async () => assets },
    productShots: {
      currentForListing: async () => current,
      ensure,
      get: async () => current,
    },
  };
  const forWorkspace: Database["forWorkspace"] = async (_ws, fn) =>
    fn(repos as never);
  const enqueue = vi.fn(async () => ({ accepted: true as const })),
    validateSource = vi.fn(async () => ({ width: 10, height: 20 }));
  return {
    ensure,
    assets,
    bytes,
    enqueue,
    validateSource,
    deps: {
      forWorkspace,
      assetStore: store,
      providerName: "fake" as "disabled" | "fake" | "photoroom",
      enqueue,
      validateSource,
    },
    setCurrent: (value: any) =>
      (current = {
        providerVersion: "fake:1.0.0",
        renderVersion: "white-v1",
        ...value,
      }),
  };
}
describe("independent selected-source request", () => {
  it("hashes stored bytes and ensures then queues one automatic selected source", async () => {
    const f = await fixture();
    const result = await requestProductShot(input, f.deps);
    expect(result).toEqual({ state: "queued", attemptId: id(9) });
    expect(f.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAssetId: id(2),
        sourceDigest: createHash("sha256").update(f.bytes).digest("hex"),
        explicitFreshAttempt: false,
      }),
    );
    expect(f.enqueue).toHaveBeenCalledWith({
      kind: "product_shot",
      workspaceId: "ws",
      draftId: id(1),
      attemptId: id(9),
    });
    expect(f.validateSource).toHaveBeenCalledOnce();
  });
  it("returns actionable selection feedback for multiple photos and preserves disabled legacy behavior", async () => {
    const f = await fixture(2);
    expect(await requestProductShot(input, f.deps)).toEqual({
      state: "source_selection_required",
    });
    expect(f.ensure).not.toHaveBeenCalled();
    f.deps.providerName = "disabled";
    expect(await requestProductShot(input, f.deps)).toEqual({
      state: "setup_required",
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("uses selected source without dispatching an unknown result again", async () => {
    const f = await fixture(2);
    f.setCurrent({
      attemptId: id(9),
      sourceAssetId: id(3),
      state: "outcome_unknown",
    });
    expect(await requestProductShot(input, f.deps)).toEqual({
      state: "outcome_unknown",
      attemptId: id(9),
    });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("rejects foreign or derived selection and invalid bytes before ensure", async () => {
    const f = await fixture();
    await expect(
      requestProductShot({ ...input, sourceAssetId: id(99) }, f.deps),
    ).rejects.toThrow("source_not_found");
    f.validateSource.mockRejectedValueOnce(new Error("invalid_image"));
    await expect(requestProductShot(input, f.deps)).rejects.toThrow(
      "invalid_image",
    );
    expect(f.ensure).not.toHaveBeenCalled();
  });
  it("retains a queued attempt on ingress failure so a later request can enqueue it", async () => {
    const f = await fixture();
    f.enqueue.mockRejectedValueOnce(new Error("queue_unavailable"));
    await expect(requestProductShot(input, f.deps)).rejects.toThrow(
      "queue_unavailable",
    );
    await expect(requestProductShot(input, f.deps)).resolves.toMatchObject({
      state: "queued",
    });
    expect(f.ensure).toHaveBeenCalledOnce();
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
});

it.each([
  ["photoroom", ""],
  ["photoroom", "2147483648"],
  ["photoroom", "9007199254740991"],
  ["fake", "2147483648"],
])(
  "refuses unavailable %s budget %s before opening runtime",
  async (provider, budget) => {
    runtimeMocks.getDatabase.mockClear();
    vi.stubEnv("PRODUCT_SHOT_PROVIDER", provider);
    vi.stubEnv("PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY", budget);
    vi.stubEnv("QUEUE_INGRESS_URL", "https://queue.example");
    vi.stubEnv("QUEUE_INGRESS_SECRET", "synthetic");
    try {
      expect(await requestProductShotFromProcess(input)).toEqual({
        state: "setup_required",
      });
      expect(runtimeMocks.getDatabase).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("accepts the maximum repository budget before opening request runtime", async () => {
  vi.stubEnv("PRODUCT_SHOT_PROVIDER", "photoroom");
  vi.stubEnv("PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY", "2147483647");
  vi.stubEnv("QUEUE_INGRESS_URL", "https://queue.example");
  vi.stubEnv("QUEUE_INGRESS_SECRET", "synthetic");
  try {
    expect(await requestProductShotFromProcess(input)).toEqual({
      state: "no_source",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("rejects a version change during source decode in the final locked selection transaction", async () => {
  const f = await fixture();
  let version = id(20);
  let locked = false;
  const base = f.deps.forWorkspace;
  f.deps.forWorkspace = async (ws, fn) =>
    base(ws, (r) =>
      fn({
        ...r,
        listings: {
          lockReviewState: async () => {
            locked = true;
          },
          getReviewSnapshot: async () => ({
            listing: { activeVersionId: version },
            activeVersion: { id: version },
          }),
        },
      } as never),
    );
  f.validateSource.mockImplementationOnce(async () => {
    version = id(21);
    return { width: 10, height: 20 };
  });
  await expect(
    requestProductShot({ ...input, expectedVersionId: id(20) }, f.deps),
  ).rejects.toMatchObject({ code: "version_conflict" });
  expect(locked).toBe(true);
  expect(f.ensure).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});

it("rejects repeated fresh-charge action once a queued attempt already exists", async () => {
  const f = await fixture();
  f.setCurrent({ attemptId: id(9), sourceAssetId: id(2), state: "queued" });
  await expect(
    requestProductShot(
      { ...input, sourceAssetId: id(2), explicitFreshAttempt: true },
      f.deps,
    ),
  ).rejects.toMatchObject({ code: "fresh_attempt_not_allowed" });
  expect(f.ensure).not.toHaveBeenCalled();
});

describe("same-draft source attachment", () => {
  function attachFixture(
    asset: {
      id: string;
      workspaceId: string;
      listingId: string | null;
      kind: string;
      metadata: Record<string, unknown>;
    } | null,
    snapshot: {
      listing: { activeVersionId: string; status: string };
      activeVersion: { id: string };
    } | null = {
      listing: { activeVersionId: id(20), status: "in_review" },
      activeVersion: { id: id(20) },
    },
  ) {
    let transactionOpen = false;
    const attachToListing = vi.fn(
      async (_listingId: string, _assetIds: string[]) => {},
    );
    const auditWrite = vi.fn(async () => {});
    const requestShot = vi.fn(async () => {
      expect(transactionOpen).toBe(false);
      return { state: "queued", attemptId: id(90) };
    });
    const repositories = {
      listings: {
        lockReviewState: vi.fn(async () => {}),
        getReviewSnapshot: vi.fn(async () => snapshot),
      },
      sourceAssets: {
        getByIds: vi.fn(async () => (asset ? [asset] : [])),
        attachToListing,
      },
      audit: { write: auditWrite },
    };
    const forWorkspace: Database["forWorkspace"] = async (_workspace, work) => {
      transactionOpen = true;
      try {
        return await work(repositories as never);
      } finally {
        transactionOpen = false;
      }
    };
    return {
      attachToListing,
      auditWrite,
      requestShot,
      repositories,
      deps: { forWorkspace, requestShot },
    };
  }

  const attachInput = {
    workspaceId: "ws",
    listingId: id(1),
    actorId: "actor",
    sourceAssetId: id(30),
    expectedVersionId: id(20),
  };
  const validAsset = {
    id: id(30),
    workspaceId: "ws",
    listingId: null,
    kind: "image/png",
    metadata: {},
  };

  it("commits an audited scoped attachment before requesting only image work", async () => {
    const f = attachFixture(validAsset);
    await expect(attachProductShotSource(attachInput, f.deps)).resolves.toEqual(
      { state: "queued", attemptId: id(90) },
    );
    expect(f.repositories.listings.lockReviewState).toHaveBeenCalledWith(id(1));
    expect(f.attachToListing).toHaveBeenCalledWith(id(1), [id(30)]);
    expect(f.auditWrite).toHaveBeenCalledWith({
      workspaceId: "ws",
      actorId: "actor",
      entityId: id(1),
      action: "product_shot.source_attached",
      metadata: { sourceAssetId: id(30) },
    });
    expect(f.requestShot).toHaveBeenCalledWith({
      ...attachInput,
      explicitFreshAttempt: false,
    });
  });

  it("resumes a same-draft attachment without another attach or audit", async () => {
    const f = attachFixture({ ...validAsset, listingId: id(1) });
    await attachProductShotSource(attachInput, f.deps);
    expect(f.attachToListing).not.toHaveBeenCalled();
    expect(f.auditWrite).not.toHaveBeenCalled();
    expect(f.requestShot).toHaveBeenCalledOnce();
  });

  it("keeps a committed attachment recoverable when the source request fails", async () => {
    const recoverable = {
      ...validAsset,
      listingId: null as string | null,
    };
    const f = attachFixture(recoverable);
    f.attachToListing.mockImplementation(async (listingId: string) => {
      recoverable.listingId = listingId;
    });
    f.requestShot
      .mockRejectedValueOnce(new Error("queue_unavailable"))
      .mockResolvedValueOnce({ state: "queued", attemptId: id(90) });

    await expect(attachProductShotSource(attachInput, f.deps)).rejects.toThrow(
      "queue_unavailable",
    );
    await expect(attachProductShotSource(attachInput, f.deps)).resolves.toEqual(
      { state: "queued", attemptId: id(90) },
    );
    expect(f.attachToListing).toHaveBeenCalledOnce();
    expect(f.auditWrite).toHaveBeenCalledOnce();
    expect(f.requestShot).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["foreign", null],
    ["another draft", { ...validAsset, listingId: id(2) }],
    ["non-image", { ...validAsset, kind: "application/pdf" }],
    [
      "derived image",
      { ...validAsset, metadata: { role: "product_shot_candidate" } },
    ],
  ])(
    "rejects a %s asset before attachment or request",
    async (_name, asset) => {
      const f = attachFixture(asset);
      await expect(
        attachProductShotSource(attachInput, f.deps),
      ).rejects.toMatchObject({ code: "source_asset_unavailable" });
      expect(f.attachToListing).not.toHaveBeenCalled();
      expect(f.requestShot).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "stale version",
      {
        listing: { activeVersionId: id(21), status: "in_review" },
        activeVersion: { id: id(21) },
      },
      "version_conflict",
    ],
    [
      "publishing",
      {
        listing: { activeVersionId: id(20), status: "publishing" },
        activeVersion: { id: id(20) },
      },
      "listing_publishing",
    ],
  ])("rejects %s before attachment", async (_name, snapshot, code) => {
    const f = attachFixture(validAsset, snapshot);
    await expect(
      attachProductShotSource(attachInput, f.deps),
    ).rejects.toMatchObject({ code });
    expect(f.attachToListing).not.toHaveBeenCalled();
    expect(f.requestShot).not.toHaveBeenCalled();
  });
});

it("rejects publishing after source I/O at the final request fence", async () => {
  const f = await fixture();
  let checks = 0;
  const base = f.deps.forWorkspace;
  f.deps.forWorkspace = async (ws, fn) =>
    base(ws, (r) =>
      fn({
        ...r,
        listings: {
          lockReviewState: async () => {},
          getReviewSnapshot: async () => ({
            listing: {
              activeVersionId: id(20),
              status: ++checks > 1 ? "publishing" : "in_review",
            },
            activeVersion: { id: id(20) },
          }),
        },
      } as never),
    );
  await expect(
    requestProductShot({ ...input, expectedVersionId: id(20) }, f.deps),
  ).rejects.toMatchObject({ code: "listing_publishing" });
  expect(f.ensure).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
});
