import { describe, it, expect, vi } from "vitest";
import { createWorkbookProductHandler } from "./route";
const id = "00000000-0000-4000-8000-000000000901";
describe("workbook product read", () => {
  it("uses session workspace and returns only the saved observation", async () => {
    const read = vi.fn(async () => ({
      id,
      sourceType: "workbook",
      observation: { title: "Synthetic" },
    }));
    const scoped = vi.fn(async (_workspace: string, fn: any) =>
      fn({ workbookCatalog: { getProduct: read } }),
    );
    const handler = createWorkbookProductHandler({
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
        "https://app.example/api/workbook-products/" +
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
    const handler = createWorkbookProductHandler({
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
            fn({ workbookCatalog: { getProduct: read } }),
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

it("requires a session before reading workbook observations", async () => {
  const read = vi.fn();
  const handler = createWorkbookProductHandler({
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

it("does not cache errors or accept writes at the read endpoint", async () => {
  const read = vi.fn(async () => null);
  const handler = createWorkbookProductHandler({
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
          fn({ workbookCatalog: { getProduct: read } }),
      }) as never,
  });
  const missing = await handler(new Request("https://app.example"), {
    params: Promise.resolve({ id }),
  });
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect((await missing.json()).message).toBe("Workbook product not found.");
  const write = await handler(
    new Request("https://app.example", { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
  expect(write.status).toBe(405);
  expect(write.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledTimes(1);
});
