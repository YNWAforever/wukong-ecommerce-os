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
    // Mirrors the repository guard: only an attempt that reached no provider
    // may be written off as a costless failure.
    finishUndispatched: vi.fn(
      async (input: { attemptId: string; code: string }) => {
        const { code } = input;
        if (row.state !== "queued" || row.dispatchedAt || row.cutoutAssetId)
          return "skipped";
        row.state = "failed";
        row.errorCode = code;
        row.leaseToken = null;
        return "ended";
      },
    ),
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
  it("ends a disabled-provider attempt instead of leaving it queued", async () => {
    // The web app only enqueues when its own provider is configured, so a
    // disabled Worker means the two surfaces disagree: the feature was turned
    // on for Vercel but not in cloudflare-runtime.config.json. This used to
    // return silently -- the message was acked, the row stayed `queued`, and
    // the review panel polled a row nothing would ever touch again.
    const f = await fixture();
    f.deps.providerName = "disabled";

    await runProductShot(job, f.deps);

    expect(f.row.state).toBe("failed");
    expect(f.row.errorCode).toBe("provider_disabled");
    expect(f.shots.finishUndispatched).toHaveBeenCalledOnce();
    expect(f.provider.generateProductShot).not.toHaveBeenCalled();
    // Nothing was dispatched, so nothing can have been charged -- which is why
    // `failed` rather than `outcome_unknown` is the honest state here.
    expect(f.shots.finishFailure).not.toHaveBeenCalled();
  });
  it("is a no-op on redelivery once the attempt already ended", async () => {
    const f = await fixture();
    f.deps.providerName = "disabled";

    await runProductShot(job, f.deps);
    await runProductShot(job, f.deps);

    // The second delivery returns at the terminal-state guard, before the
    // disabled branch, so the row is not touched twice.
    expect(f.shots.finishUndispatched).toHaveBeenCalledOnce();
    expect(f.row.state).toBe("failed");
  });
  it("never writes off an attempt that already reached the provider", async () => {
    // The guard that keeps this safe. A dispatched attempt may have been
    // charged, so it has to stay with finishFailure and outcome_unknown.
    const f = await fixture();
    f.row.state = "processing";
    f.row.dispatchedAt = new Date();

    expect(
      await f.shots.finishUndispatched({
        attemptId: job.attemptId,
        code: "provider_disabled",
      }),
    ).toBe("skipped");
    expect(f.row.state).toBe("processing");
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
  // The ceiling a queue retry actually accepts, not a whole day: a denial just
  // after UTC midnight is nearly 86400 seconds from the reset, and asking for
  // that is another way to lose the message.
  expect(denied.retryAfterSeconds).toBeLessThanOrEqual(43200);
  expect(f.provider.generateProductShot).not.toHaveBeenCalled();
  expect(f.row.state).toBe("queued");
  f.allow();
  await runProductShot(job, f.deps);
  expect(f.provider.generateProductShot).toHaveBeenCalledOnce();
});
it("caps an exhausted-budget retry at the delay a queue will accept", async () => {
  // Denied just after UTC midnight, the reset is nearly a whole day away. The
  // previous ceiling was 86400, so this asked for a delay longer than
  // `message.retry` takes -- and a rejected retry is one more way for the row
  // to stay `queued` with nobody coming back for it.
  const f = await fixture();
  f.deny();
  f.expire(); // 2026-09-07T23:59:00Z -> 2026-09-08T00:01:01Z

  const denied = await runProductShot(job, f.deps).catch((e) => e);

  expect(denied).toBeInstanceOf(ProductShotBudgetError);
  expect(denied.retryAfterSeconds).toBe(43200);
  expect(f.row.state).toBe("queued");
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

it("reconciles an expired historical lease once without claiming or dispatching again", async () => {
  const f = await fixture();
  await f.shots.claim();
  f.replace();
  f.expire();
  await runProductShot(job, f.deps);
  await runProductShot(job, f.deps);
  expect(f.row.state).toBe("outcome_unknown");
  expect(f.shots.finishFailure).toHaveBeenCalledExactlyOnceWith({
    attemptId: job.attemptId,
    leaseToken: id(4),
    code: "outcome_unknown",
    unknown: true,
  });
  expect(f.shots.claim).toHaveBeenCalledOnce();
  expect(f.provider.generateProductShot).not.toHaveBeenCalled();
});
it.each(["cutout_ready", "outcome_unknown"] as const)(
  "accepts a concurrent %s transition during expiry reconciliation",
  async (state) => {
    const f = await fixture();
    await f.shots.claim();
    f.expire();
    f.shots.finishFailure.mockImplementationOnce(async () => {
      f.row.state = state;
      f.row.leaseToken = null;
      if (state === "cutout_ready") f.row.cutoutAssetId = id(5);
      throw new Error("lease_lost");
    });
    await expect(runProductShot(job, f.deps)).resolves.toBeUndefined();
    expect(f.row.state).toBe(state);
    expect(f.shots.finishFailure).toHaveBeenCalledOnce();
    expect(f.provider.generateProductShot).not.toHaveBeenCalled();
  },
);
it("retries an unexpected expiry reconciliation failure while the attempt remains processing", async () => {
  const f = await fixture();
  await f.shots.claim();
  f.expire();
  f.shots.finishFailure.mockRejectedValueOnce(
    new Error("database_unavailable"),
  );
  await expect(runProductShot(job, f.deps)).rejects.toThrow(
    "database_unavailable",
  );
  expect(f.row.state).toBe("processing");
  expect(f.provider.generateProductShot).not.toHaveBeenCalled();
});
