import { describe, it, expect, vi } from "vitest";
import { createWebsiteProductHandler } from "./route";
const id = "00000000-0000-4000-8000-000000000901";
describe("website product read", () => {
  it("uses session workspace and returns only the saved observation", async () => {
    const read = vi.fn(async () => ({
      id,
      sourceType: "website",
      observation: { title: "Synthetic" },
    }));
    const scoped = vi.fn(async (_workspace: string, fn: any) =>
      fn({ reads: { websiteProduct: read } }),
    );
    const handler = createWebsiteProductHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "own",
          actorId: "viewer",
          role: "viewer",
        }),
      },
      getDatabase: () => ({ forWorkspace: scoped }) as never,
    });
    const response = await handler(
      new Request(
        "https://app.example/api/website-products/" +
          id +
          "?workspaceId=foreign",
      ),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(scoped.mock.calls[0]?.[0]).toBe("own");
    expect(read).toHaveBeenCalledWith(id);
  });
  it("returns controlled not found for foreign IDs and rejects malformed IDs", async () => {
    const read = vi.fn(async () => null);
    const handler = createWebsiteProductHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "own",
          actorId: "viewer",
          role: "viewer",
        }),
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_w: string, fn: any) =>
            fn({ reads: { websiteProduct: read } }),
        }) as never,
    });
    expect(
      (
        await handler(new Request("https://app.example"), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(new Request("https://app.example"), {
          params: Promise.resolve({ id: "bad" }),
        })
      ).status,
    ).toBe(400);
  });
});

it("requires a session before reading website observations", async () => {
  const read = vi.fn();
  const handler = createWebsiteProductHandler({
    sessionContext: { resolve: async () => null },
    getDatabase: read,
  });
  expect(
    (
      await handler(new Request("https://app.example"), {
        params: Promise.resolve({ id }),
      })
    ).status,
  ).toBe(401);
  expect(read).not.toHaveBeenCalled();
});
