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

it("observes current source only for same-target latest rejected members without changing original attestation", async () => {
  const original = [
    { listingId: "rejected", contentDigest: "original-source" },
  ];
  const observed: string[] = [];
  const handler = createExportDetailHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "ws",
        actorId: "reviewer",
        role: "reviewer",
      }),
    },
    getDatabase: () => ({
      forWorkspace: async (_ws: string, work: any) =>
        work({
          exportAttempts: {
            getById: async () => ({
              id,
              artifactStatus: "ready",
              sourceAttestation: original,
              manifest: ["accepted", "rejected", "retargeted"].map(
                (listingId) => ({
                  listingId,
                  versionId: "version",
                  outcome: "included",
                }),
              ),
              provenance: {
                evidence: ["accepted", "rejected", "retargeted"].map(
                  (listingId) => ({
                    listingId,
                    connectionId: "store",
                    remoteProductId: "remote-" + listingId,
                  }),
                ),
              },
            }),
          },
          importResults: {
            listForExportAttempts: async () =>
              ["accepted", "rejected", "retargeted"].map(
                (listingId, index) => ({
                  listingId,
                  versionId: "version",
                  mode: "export",
                  exportAttemptId: id,
                  revision: 1,
                  outcome: index ? "rejected" : "accepted",
                }),
              ),
          },
          platformProducts: {
            getByListingId: async (listingId: string) => {
              observed.push(listingId);
              return {
                origin: "import",
                sourceImportId: "current-import",
                contentDigest: "current-source",
                connectionId: "store",
                remoteProductId:
                  listingId === "retargeted"
                    ? "other-product"
                    : "remote-" + listingId,
              };
            },
          },
        }),
    }),
  } as never);
  const response = await handler(new Request("http://localhost"), {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(observed).toEqual(["rejected", "retargeted"]);
  expect(body.attempt.sourceAttestation).toEqual(original);
  expect(body.repairSourceObservations).toEqual([
    {
      listingId: "rejected",
      contentDigest: "current-source",
      sourceImportId: "current-import",
      remoteProductId: "remote-rejected",
    },
  ]);
});
