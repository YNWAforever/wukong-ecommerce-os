import { expect, it, vi } from "vitest";
import * as service from "./wine-adopted-service";
it("requires a server session before opening the wine dependency transaction", async () => {
  const database = { forWorkspace: vi.fn() };
  await expect(
    service.readAdoptedWineSupport(
      { database: database as never, session: { resolve: async () => null } },
      { listingId: "x", versionId: "y", inputRevision: 1 },
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(database.forWorkspace).not.toHaveBeenCalled();
});
it("rejects a caller workspace override before opening a transaction", async () => {
  const database = { forWorkspace: vi.fn() };
  await expect(
    service.readAdoptedWineSupport(
      {
        database: database as never,
        session: {
          resolve: async () => ({
            workspaceId: "trusted",
            actorId: "actor",
            role: "viewer",
          }),
        },
      },
      {
        workspaceId: "foreign",
        listingId: "00000000-0000-4000-8000-000000000001",
        versionId: "00000000-0000-4000-8000-000000000002",
        inputRevision: 1,
      },
    ),
  ).rejects.toThrow();
  expect(database.forWorkspace).not.toHaveBeenCalled();
});
it("uses only the session tenant and sanitizes transaction failures", async () => {
  const database = {
    forWorkspace: vi.fn(async () => {
      throw Error("private database detail");
    }),
  };
  expect(
    await service.readAdoptedWineSupport(
      {
        database: database as never,
        session: {
          resolve: async () => ({
            workspaceId: "trusted",
            actorId: "actor",
            role: "viewer",
          }),
        },
      },
      {
        listingId: "00000000-0000-4000-8000-000000000001",
        versionId: "00000000-0000-4000-8000-000000000002",
        inputRevision: 1,
      },
    ),
  ).toEqual({ status: "unavailable", code: "adopted_evidence_unavailable" });
  expect(database.forWorkspace).toHaveBeenCalledWith(
    "trusted",
    expect.any(Function),
  );
});
