import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryAssetStore } from "@wukong/assets";
import { ProductShotProviderError } from "@wukong/ai";
import type {
  Database,
  ProductShotAttempt,
  WorkspaceRepositories,
} from "@wukong/db";
import {
  runProductShot,
  ProductShotBusyError,
  ProductShotBudgetError,
} from "./product-shot-pipeline.js";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = {
  kind: "product_shot" as const,
  workspaceId: "ws",
  draftId: id(1),
  attemptId: id(2),
};
const bytes = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAAAKUlEQVR4nGPQCKhgoAQzDE8D/hPAowaMGjBqwKgBowaMLAMYSMHDwAAAzPqfX45/w+sAAAAASUVORK5CYII=",
    "base64",
  ),
);
async function fixture() {
  let now = new Date("2026-09-07T23:59:00.000Z");
  let selected = id(2);
  let budget = true;
  const row = {
    ...job,
    listingId: job.draftId,
    sourceAssetId: id(3),
    sourceDigest: createHash("sha256").update(bytes).digest("hex"),
    providerVersion: "fake-v1",
    renderVersion: "white-v1",
    state: "queued",
    leaseToken: null,
    leaseExpiresAt: null,
    dispatchedAt: null,
    cutoutAssetId: null,
  } as unknown as ProductShotAttempt;
  const source = {
    id: id(3),
    workspaceId: "ws",
    listingId: job.draftId,
    storageKey: `ws/ws/sources/${id(3)}/source.png`,
    kind: "image/png",
    metadata: {},
  };
  const assets = [source];
  const store = new MemoryAssetStore();
  await store.writeObject("ws", source.storageKey, bytes, "image/png");
  const shots = {
    get: async () => ({ ...row }),
    currentForListing: async () =>
      selected === row.attemptId ? { ...row } : null,
    claim: vi.fn(async () => {
      if (selected !== row.attemptId) return { kind: "skip" };
      if (row.state === "processing") {
        if (row.leaseExpiresAt! <= now) {
          row.state = "outcome_unknown";
          row.leaseToken = null;
          return { kind: "outcome_unknown" };
        }
        return { kind: "skip" };
      }
      if (row.state !== "queued") return { kind: "skip" };
      if (!budget) return { kind: "budget_exhausted" };
      row.state = "processing";
      row.leaseToken = id(4);
      row.leaseExpiresAt = new Date(+now + 120000);
      row.dispatchedAt = now;
      return { kind: "claimed", leaseToken: id(4), sourceAssetId: source.id };
    }),
    saveCutout: vi.fn(async ({ assetId }: { assetId: string }) => {
      row.cutoutAssetId = assetId;
      row.state = "cutout_ready";
      row.leaseToken = null;
    }),
    finishFailure: vi.fn(async ({ unknown }: { unknown: boolean }) => {
      row.state = unknown ? "outcome_unknown" : "failed";
      row.leaseToken = null;
    }),
  };
  const repos = {
    productShots: shots,
    sourceAssets: {
      getByIds: async (ids: string[]) =>
        assets.filter((a) => ids.includes(a.id)),
      getByStorageKey: async (key: string) =>
        assets.find((a) => a.storageKey === key) ?? null,
      create: async (input: typeof source) => {
        const a = {
          ...input,
          id: id(5),
          workspaceId: "ws",
          listingId: null as unknown as string,
        };
        assets.push(a);
        return a;
      },
      attachToListing: async (listingId: string, ids: string[]) => {
        for (const a of assets) if (ids.includes(a.id)) a.listingId = listingId;
      },
    },
  } as unknown as WorkspaceRepositories;
  let tail = Promise.resolve();
  const forWorkspace: Database["forWorkspace"] = async (_ws, work) => {
    const before = tail;
    let release!: () => void;
    tail = new Promise((r) => (release = r));
    await before;
    try {
      return await work(repos);
    } finally {
      release();
    }
  };
  const provider = {
    generateProductShot: vi.fn(async () => ({
      cutoutPng: bytes,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        latencyMs: 0,
        model: "fake",
        promptVersion: "v1",
      },
    })),
  };
  const deps = {
    forWorkspace,
    assetStore: store,
    providerFor: () => provider,
    providerName: "fake" as "fake" | "disabled",
    dailyLimit: 5,
    now: () => now,
  };
  return {
    row,
    shots,
    store,
    provider,
    deps,
    assets,
    replace: () => (selected = id(9)),
    deny: () => (budget = false),
    allow: () => (budget = true),
    expire: () => (now = new Date(+now + 121000)),
  };
}
describe("durable product shot pipeline", () => {
  it("commits claim before I/O and calls provider once across concurrent and checkpoint redelivery", async () => {
    const f = await fixture();
    f.provider.generateProductShot.mockImplementation(async () => {
      expect(f.row.state).toBe("processing");
      return {
        cutoutPng: bytes,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          latencyMs: 0,
          model: "fake",
          promptVersion: "v1",
        },
      };
    });
    await Promise.allSettled([
      runProductShot(job, f.deps),
      runProductShot(job, f.deps),
    ]);
    await runProductShot(job, f.deps);
    expect(f.row.state).toBe("cutout_ready");
    expect(f.provider.generateProductShot).toHaveBeenCalledTimes(1);
    expect(f.assets[1]?.metadata).toMatchObject({
      role: "product_shot_cutout",
      attemptId: job.attemptId,
      sourceDigest: f.row.sourceDigest,
    });
  });
  it("records a timeout as unknown without automatic second dispatch", async () => {
    const f = await fixture();
    f.provider.generateProductShot.mockRejectedValue(
      new ProductShotProviderError("outcome_unknown"),
    );
    await runProductShot(job, f.deps);
    await runProductShot(job, f.deps);
    expect(f.row.state).toBe("outcome_unknown");
    expect(f.provider.generateProductShot).toHaveBeenCalledTimes(1);
  });
  it("keeps a live-lease duplicate retryable then reconciles original crash at expiry without billing again", async () => {
    const f = await fixture();
    await f.shots.claim();
    await expect(runProductShot(job, f.deps)).rejects.toBeInstanceOf(
      ProductShotBusyError,
    );
    f.expire();
    await runProductShot(job, f.deps);
    expect(f.row.state).toBe("outcome_unknown");
    expect(f.provider.generateProductShot).not.toHaveBeenCalled();
  });
  it("denies disabled, exhausted budget, replaced selection and changed source bytes before provider", async () => {
    for (const mode of ["disabled", "replaced", "digest"]) {
      const f = await fixture();
      if (mode === "disabled") f.deps.providerName = "disabled";
      if (mode === "budget") f.deny();
      if (mode === "replaced") f.replace();
      if (mode === "digest")
        await f.store.writeObject(
          "ws",
          f.assets[0]!.storageKey,
          new Uint8Array([1]),
          "image/png",
        );
      await runProductShot(job, f.deps);
      expect(f.provider.generateProductShot).not.toHaveBeenCalled();
    }
  });
  it("recovers deterministic stored output when checkpoint fails without calling provider again", async () => {
    const f = await fixture();
    f.shots.saveCutout.mockRejectedValueOnce(new Error("db failed"));
    await runProductShot(job, f.deps);
    await runProductShot(job, f.deps);
    expect(f.row.state).toBe("cutout_ready");
    expect(f.provider.generateProductShot).toHaveBeenCalledTimes(1);
  });
});

it("retries exhausted budget at the UTC boundary without provider invocation then can claim", async () => {
  const f = await fixture();
  f.deny();
  const denied = await runProductShot(job, f.deps).catch((e) => e);
  expect(denied).toBeInstanceOf(ProductShotBudgetError);
  expect(denied.retryAfterSeconds).toBe(60);
  expect(denied.retryAfterSeconds).toBeLessThanOrEqual(86400);
  expect(f.provider.generateProductShot).not.toHaveBeenCalled();
  expect(f.row.state).toBe("queued");
  f.allow();
  await runProductShot(job, f.deps);
  expect(f.provider.generateProductShot).toHaveBeenCalledOnce();
});
it("refuses a truncated deterministic PNG checkpoint", async () => {
  const f = await fixture();
  await f.shots.claim();
  await f.store.writeObject(
    "ws",
    `ws/ws/sources/${job.attemptId}/product-shot-cutout.png`,
    bytes.slice(0, 24),
    "image/png",
  );
  await expect(runProductShot(job, f.deps)).rejects.toBeInstanceOf(
    ProductShotBusyError,
  );
  expect(f.shots.saveCutout).not.toHaveBeenCalled();
  expect(f.provider.generateProductShot).not.toHaveBeenCalled();
});
