import { describe, expect, it, vi } from "vitest";
import { assignListingItems } from "./listing-assignment-service";
import type { ListingAssignmentRepository } from "@wukong/db";
const listingId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const key = "00000000-0000-4000-8000-000000000010";
const context = {
  workspaceId: "synthetic",
  actorId: "operator",
  role: "operator" as const,
};
function repo() {
  return {
    apply: vi.fn(async (item) => ({
      listingId: item.listingId,
      outcome: "assigned" as const,
      assigneeUserId: item.assigneeUserId,
      assignmentRevision: 1,
      replayed: false,
    })),
  } as unknown as ListingAssignmentRepository;
}
describe("assignment authority and bulk outcomes", () => {
  it("denies viewer and operator arbitrary assignment before a mutation", async () => {
    const repository = repo();
    const items = [
      {
        listingId,
        assigneeUserId: "other",
        expectedRevision: 0,
        idempotencyKey: key,
        action: "assign" as const,
      },
    ];
    await expect(
      assignListingItems(repository, context, items),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      assignListingItems(repository, { ...context, role: "viewer" }, [
        { ...items[0]!, action: "claim" },
      ]),
    ).rejects.toMatchObject({ status: 403 });
    expect(repository.apply).not.toHaveBeenCalled();
  });
  it("operator can only claim self, while target membership is rechecked by the repository", async () => {
    const repository = repo();
    await expect(
      assignListingItems(repository, context, [
        {
          listingId,
          assigneeUserId: "other",
          expectedRevision: 0,
          idempotencyKey: key,
          action: "claim",
        },
      ]),
    ).rejects.toMatchObject({ status: 403 });
    await assignListingItems(repository, context, [
      {
        listingId,
        assigneeUserId: context.actorId,
        expectedRevision: 0,
        idempotencyKey: key,
        action: "claim",
      },
    ]);
    expect(repository.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: context.actorId,
        listingId,
        expectedRevision: 0,
      }),
    );
  });
  it("keeps partial conflicts visible and uses the current server actor", async () => {
    const repository = repo();
    vi.mocked(repository.apply)
      .mockResolvedValueOnce({
        listingId,
        outcome: "assigned",
        assigneeUserId: "reviewer",
        assignmentRevision: 1,
        replayed: false,
      })
      .mockResolvedValueOnce({
        listingId: secondId,
        outcome: "revision_conflict",
        assigneeUserId: null,
        assignmentRevision: 4,
        replayed: false,
      });
    const result = await assignListingItems(
      repository,
      { ...context, role: "reviewer" },
      [listingId, secondId].map((id) => ({
        listingId: id,
        assigneeUserId: "reviewer",
        expectedRevision: 0,
        idempotencyKey: key,
        action: "assign" as const,
      })),
    );
    expect(result.results.map((r) => r.outcome)).toEqual([
      "assigned",
      "revision_conflict",
    ]);
    expect(result).toMatchObject({ assigned: 1, failed: 1 });
  });
});

it("locks overlapping bulk items in listing order while preserving response order", async () => {
  const repository = repo();
  const items = [secondId, listingId].map((id) => ({
    listingId: id,
    assigneeUserId: "reviewer",
    expectedRevision: 0,
    idempotencyKey: key,
    action: "assign" as const,
  }));
  const result = await assignListingItems(
    repository,
    { ...context, role: "reviewer" },
    items,
  );
  expect(
    vi.mocked(repository.apply).mock.calls.map((call) => call[0].listingId),
  ).toEqual([listingId, secondId]);
  expect(result.results.map((item) => item.listingId)).toEqual([
    secondId,
    listingId,
  ]);
});
