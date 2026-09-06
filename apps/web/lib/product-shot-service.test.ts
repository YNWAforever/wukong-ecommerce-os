import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { MemoryAssetStore } from "@wukong/assets";
import {
  prepareProductShot,
  readProductShot,
  approveProductShot,
} from "./product-shot-service";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const input = {
  workspaceId: "ws",
  listingId: id(1),
  actorId: "reviewer",
  expectedVersionId: id(2),
  attemptId: id(3),
};
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve("@wukong/assets"))("sharp");
async function fixture() {
  const png = await sharp({
    create: { width: 16, height: 32, channels: 4, background: "#a00000ff" },
  })
    .png()
    .toBuffer();
  const store = new MemoryAssetStore();
  let tx = false;
  let version = id(2);
  const attempt: any = {
    ...input,
    sourceAssetId: id(4),
    sourceDigest: "a".repeat(64),
    providerVersion: "fake:1.0.0",
    renderVersion: "white-v1",
    state: "cutout_ready",
    cutoutAssetId: id(5),
    cutoutDigest: digest(png),
    candidate: null,
    leaseToken: "SECRET",
    errorCode: null,
  };
  const assets: any[] = [
    {
      id: id(4),
      workspaceId: "ws",
      listingId: id(1),
      kind: "image/png",
      storageKey: `ws/ws/sources/${id(4)}/original.png`,
      metadata: {},
    },
    {
      id: id(5),
      workspaceId: "ws",
      listingId: id(1),
      kind: "image/png",
      storageKey: `ws/ws/sources/${id(3)}/cutout.png`,
      metadata: { role: "product_shot_cutout" },
    },
  ];
  await store.writeObject("ws", assets[1].storageKey, png, "image/png");
  const calls: string[] = [];
  const repos: any = {
    listings: {
      lockReviewState: async () => calls.push("lock"),
      getReviewSnapshot: async () => ({
        listing: { activeVersionId: version },
        activeVersion: { id: version },
      }),
    },
    sourceAssets: {
      listForListing: async () => assets,
      create: async (a: any) => {
        const row = { ...a, id: id(6), workspaceId: "ws", listingId: null };
        assets.push(row);
        return row;
      },
      attachToListing: async () => {
        assets.at(-1).listingId = id(1);
      },
    },
    productShots: {
      currentForListing: async () => attempt,
      get: async () => attempt,
      saveCandidate: async ({ candidate }: any) => {
        calls.push("save");
        attempt.candidate = candidate;
        attempt.state = "candidate_ready";
      },
      approve: vi.fn(async () => ({ publicationToken: "private-token" })),
    },
    audit: { write: async () => {} },
  };
  const forWorkspace: any = async (_ws: string, fn: any) => {
    expect(_ws).toBe("ws");
    tx = true;
    try {
      return await fn(repos);
    } finally {
      tx = false;
    }
  };
  for (const key of [
    "readObject",
    "writeObjectIfAbsent",
    "createReadUrl",
  ] as const) {
    const original = store[key].bind(store);
    (store as any)[key] = async (...args: any[]) => {
      expect(tx).toBe(false);
      return (original as any)(...args);
    };
  }
  return {
    deps: { forWorkspace, assetStore: store },
    repos,
    attempt,
    assets,
    store,
    calls,
    setVersion: (v: string) => (version = v),
  };
}
describe("exact product shot review service", () => {
  it("renders and stores actual JPEG outside transactions then converges on one candidate", async () => {
    const f = await fixture();
    const a = await prepareProductShot(input, f.deps);
    const b = await prepareProductShot(input, f.deps);
    expect(a.candidateDigest).toBe(b.candidateDigest);
    expect(f.calls.filter((x) => x === "save")).toHaveLength(1);
    const candidate = f.assets.find(
      (a) => a.id === f.attempt.candidate.assetId,
    );
    const bytes = await f.store.readObject("ws", candidate.storageKey);
    expect([...bytes.slice(0, 2)]).toEqual([255, 216]);
    expect(digest(bytes)).toBe(a.candidateDigest);
    expect(candidate.metadata).toMatchObject({
      role: "product_shot_candidate",
      mimeType: "image/jpeg",
      digest: a.candidateDigest,
    });
    expect(JSON.stringify(a)).not.toMatch(/SECRET|storageKey|publicationToken/);
  });
  it("rejects stale version and obsolete selected attempt before rendering", async () => {
    const f = await fixture();
    f.setVersion(id(99));
    await expect(prepareProductShot(input, f.deps)).rejects.toMatchObject({
      code: "version_conflict",
    });
    f.setVersion(id(2));
    f.attempt.attemptId = id(90);
    await expect(prepareProductShot(input, f.deps)).rejects.toMatchObject({
      code: "selection_changed",
    });
    expect(f.calls).not.toContain("save");
  });
  it("rechecks version after storage IO before candidate attachment", async () => {
    const f = await fixture();
    const write = f.store.writeObjectIfAbsent.bind(f.store);
    f.store.writeObjectIfAbsent = async (...args) => {
      const result = await write(...args);
      f.setVersion(id(99));
      return result;
    };
    await expect(prepareProductShot(input, f.deps)).rejects.toMatchObject({
      code: "version_conflict",
    });
    expect(f.assets).toHaveLength(2);
    expect(f.calls).not.toContain("save");
  });
  it("rejects invalid stored cutout bytes without persisting a candidate", async () => {
    const f = await fixture();
    await f.store.writeObject(
      "ws",
      f.assets[1].storageKey,
      new Uint8Array([1]),
      "image/png",
    );
    await expect(prepareProductShot(input, f.deps)).rejects.toMatchObject({
      code: "invalid_image",
    });
    expect(f.calls).not.toContain("save");
  });
  it("GET is read-only, returns eligible originals and never exposes internals", async () => {
    const f = await fixture();
    const view = await readProductShot(input, f.deps);
    expect(view.attemptId).toBe(id(3));
    expect(view.sources).toHaveLength(1);
    expect(view.allowedActions).toContain("prepare");
    expect(f.calls).toEqual([]);
    expect(view).not.toHaveProperty("leaseToken");
    expect(view).not.toHaveProperty("cutoutAssetId");
  });
  it("image approval verifies the route listing before repository approval", async () => {
    const f = await fixture();
    f.attempt.listingId = id(99);
    await expect(
      approveProductShot({ ...input, candidateDigest: "a".repeat(64) }, f.deps),
    ).rejects.toMatchObject({ code: "selection_changed" });
    expect(f.repos.productShots.approve).not.toHaveBeenCalled();
  });
});

it("rejects invalid renderer metadata before private candidate write", async () => {
  const f = await fixture();
  const render = vi.fn(async () => ({
    bytes: new Uint8Array([255, 216, 1]),
    mimeType: "image/jpeg" as const,
    width: 1600,
    height: 1600,
    lowResolution: false,
  }));
  await expect(
    prepareProductShot(input, { ...f.deps, render }),
  ).rejects.toMatchObject({ code: "invalid_image" });
  expect(f.calls).not.toContain("save");
});
it("discards a GET whose source selection changes while signed URLs are created", async () => {
  const f = await fixture();
  f.repos.productShots.currentForListing = async () => ({ ...f.attempt });
  const read = f.store.createReadUrl.bind(f.store);
  f.store.createReadUrl = async (...args) => {
    const result = await read(...args);
    f.attempt.attemptId = id(99);
    return result;
  };
  await expect(readProductShot(input, f.deps)).rejects.toMatchObject({
    code: "selection_changed",
  });
  expect(f.calls).toEqual([]);
});
it("rejects source replacement during candidate storage IO", async () => {
  const f = await fixture();
  f.repos.productShots.currentForListing = async () => ({ ...f.attempt });
  const write = f.store.writeObjectIfAbsent.bind(f.store);
  f.store.writeObjectIfAbsent = async (...args) => {
    const result = await write(...args);
    f.attempt.attemptId = id(99);
    return result;
  };
  await expect(prepareProductShot(input, f.deps)).rejects.toMatchObject({
    code: "selection_changed",
  });
  expect(f.assets).toHaveLength(2);
  expect(f.calls).not.toContain("save");
});
