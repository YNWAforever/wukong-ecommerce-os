import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublishedImageHandler } from "./product-image-publication";
import { createHash } from "node:crypto";
const token = "a".repeat(43);
const bytes = new Uint8Array([255, 216, 255, 217]);
const digest = createHash("sha256").update(bytes).digest("hex");
afterEach(() => vi.useRealTimers());
describe("public approved image bytes", () => {
  it("serves GET/HEAD with revocable headers after signed URL TTL", async () => {
    let active = true;
    const handler = createPublishedImageHandler({
      lookupPublishedImage: async (value) =>
        value === token && active
          ? { workspaceId: "ws", storageKey: "key", digest, size: 4 }
          : null,
      readObject: async () => bytes,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2035-01-01"));
    for (const method of ["GET", "HEAD"]) {
      const r = await handler(
        new Request("https://images.example/product-images/" + token + ".jpg", {
          method,
        }),
        { params: Promise.resolve({ file: token + ".jpg" }) },
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/jpeg");
      expect(r.headers.get("content-length")).toBe("4");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("location")).toBeNull();
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(
        method === "GET" ? bytes : new Uint8Array(),
      );
    }
    active = false;
    expect(
      (
        await handler(new Request("https://images.example"), {
          params: Promise.resolve({ file: token + ".jpg" }),
        })
      ).status,
    ).toBe(404);
  });
  it.each([
    "bad.jpg",
    "a".repeat(64) + ".jpg",
    token + ".png",
    token + ".jpg/extra",
  ])("rejects invalid filename %s", async (file) => {
    const lookupPublishedImage = vi.fn();
    const handler = createPublishedImageHandler({
      lookupPublishedImage,
      readObject: vi.fn(),
    });
    expect(
      (
        await handler(new Request("https://images.example"), {
          params: Promise.resolve({ file }),
        })
      ).status,
    ).toBe(404);
    expect(lookupPublishedImage).not.toHaveBeenCalled();
  });
  it("does not serve substituted bytes", async () => {
    const handler = createPublishedImageHandler({
      lookupPublishedImage: async () => ({
        workspaceId: "ws",
        storageKey: "key",
        digest,
        size: 4,
      }),
      readObject: async () => new Uint8Array([1, 2, 3, 4]),
    });
    expect(
      (
        await handler(new Request("https://images.example"), {
          params: Promise.resolve({ file: token + ".jpg" }),
        })
      ).status,
    ).toBe(404);
  });
});
