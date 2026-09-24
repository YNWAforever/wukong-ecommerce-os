import { it, expect } from "vitest";
import { createExportDetailHandler } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
it.each(["viewer", "operator", "reviewer"] as const)(
  "provides authorized detail and capabilities for %s",
  async (role) => {
    let workspace = "";
    let requested: unknown;
    const handler = createExportDetailHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "server-workspace",
          actorId: "actor",
          role,
        }),
      },
      getDatabase: () => ({
        forWorkspace: async (ws: string, work: any) => {
          workspace = ws;
          return work({
            exportAttempts: {
              getById: async () => ({
                id,
                manifest: [
                  {
                    listingId: "listing",
                    versionId: "version",
                    outcome: "included",
                  },
                ],
              }),
            },
            importResults: {
              listForExportAttempts: async (ids: unknown) => {
                requested = ids;
                return [];
              },
            },
          });
        },
      }),
    } as never);
    const response = await handler(
      new Request("http://localhost?workspaceId=foreign"),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(workspace).toBe("server-workspace");
    expect(requested).toEqual([id]);
    expect(await response.json()).toMatchObject({
      attempt: { id },
      reconciliation: {
        counts: { included: 1, unreported: 1 },
        verificationStatus: "unverified",
      },
      capabilities: {
        canRecordImportResult: role !== "viewer",
        canGenerateBulkUpdate: role === "reviewer",
      },
    });
  },
);
it("does not reveal foreign/missing attempts or query their results", async () => {
  const handler = createExportDetailHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "ws",
        actorId: "actor",
        role: "operator",
      }),
    },
    getDatabase: () => ({
      forWorkspace: async (_ws: string, work: any) =>
        work({
          exportAttempts: { getById: async () => null },
          importResults: {
            listForExportAttempts: () => {
              throw new Error("must not read");
            },
          },
        }),
    }),
  } as never);
  expect(
    (
      await handler(new Request("http://localhost"), {
        params: Promise.resolve({ id }),
      })
    ).status,
  ).toBe(404);
});
it("requires authentication before opening database", async () => {
  const handler = createExportDetailHandler({
    sessionContext: { resolve: async () => null },
    getDatabase: () => {
      throw new Error("must not open");
    },
  });
  expect(
    (
      await handler(new Request("http://localhost"), {
        params: Promise.resolve({ id }),
      })
    ).status,
  ).toBe(401);
});
