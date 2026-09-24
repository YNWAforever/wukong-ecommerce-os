import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
const publicCalls = vi.hoisted(() => ({
  lookupPublishedImage: vi.fn(async () => null),
  readObject: vi.fn(),
}));
vi.mock("../../../lib/intake-runtime", () => ({
  getDatabase: () => publicCalls,
  getAssetStore: () => publicCalls,
}));
import { GET, HEAD } from "./route";
it("opens only exact image capabilities through middleware", () => {
  expect(
    middleware(
      new NextRequest(
        "https://app.example/product-images/" + "a".repeat(43) + ".jpg",
      ),
    ).headers.get("x-middleware-next"),
  ).toBe("1");
  for (const path of [
    "/product-images",
    "/product-images/admin",
    "/product-images/" + "a".repeat(43) + ".jpg/extra",
    "/listings/private",
  ])
    expect(
      middleware(new NextRequest("https://app.example" + path)).status,
    ).toBe(307);
});
it("GET and HEAD return not found for unknown publication", async () => {
  for (const handler of [GET, HEAD])
    expect(
      (
        await handler(new Request("https://app.example"), {
          params: Promise.resolve({ file: "a".repeat(43) + ".jpg" }),
        })
      ).status,
    ).toBe(404);
});

it.each([".jpg", "bad.jpg", "invalid!.jpg", "a".repeat(42) + ".jpg"])(
  "returns anonymous GET/HEAD 404 for malformed filename %s without lookup",
  async (file) => {
    vi.clearAllMocks();
    for (const method of ["GET", "HEAD"]) {
      const request = new NextRequest(
        `https://app.example/product-images/${file}`,
        { method },
      );
      const boundary = middleware(request);
      expect(boundary.headers.get("x-middleware-next")).toBe("1");
      expect(boundary.headers.get("location")).toBeNull();
      expect(
        (await GET(request, { params: Promise.resolve({ file }) })).status,
      ).toBe(404);
    }
    expect(publicCalls.lookupPublishedImage).not.toHaveBeenCalled();
    expect(publicCalls.readObject).not.toHaveBeenCalled();
  },
);
