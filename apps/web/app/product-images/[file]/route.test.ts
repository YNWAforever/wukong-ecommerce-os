import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";
vi.mock("../../../lib/intake-runtime", () => ({
  getDatabase: () => ({ lookupPublishedImage: async () => null }),
  getAssetStore: () => ({ readObject: vi.fn() }),
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
