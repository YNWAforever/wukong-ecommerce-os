import { describe, it, expect, vi } from "vitest";
import { createListingInputsHandler } from "./route";
const id = "00000000-0000-4000-8000-000000000101";
function handler(role = "operator") {
  const save = vi.fn().mockResolvedValue({
    revision: 2,
    baseVersionId: null,
    workingContent: {},
    replayed: false,
  });
  const repos = { listingInputs: { save }, audit: { write: vi.fn() } };
  return {
    save,
    run: createListingInputsHandler({
      sessionContext: {
        resolve: async () => ({ workspaceId: "ws", actorId: "actor", role }),
      } as any,
      getDatabase: () =>
        ({ forWorkspace: async (_: string, fn: any) => fn(repos) }) as any,
    }),
  };
}
function request(body: unknown) {
  return new Request("https://test/api/listings/" + id + "/inputs", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "00000000-0000-4000-8000-000000000301",
    },
    body: JSON.stringify(body),
  });
}
describe("working input route", () => {
  it("saves null-base partial changes without model calls", async () => {
    const h = handler();
    const response = await h.run(
      request({
        expectedInputRevision: 1,
        baseVersionId: null,
        changes: [{ field: "priceHkd", value: null }],
        action: "save",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(h.save).toHaveBeenCalled();
  });
  it("forbids a viewer", async () => {
    const h = handler("viewer");
    expect(
      (await h.run(request({}), { params: Promise.resolve({ id }) })).status,
    ).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("rejects ownership injection", async () => {
    const h = handler();
    expect(
      (
        await h.run(
          request({
            expectedInputRevision: 1,
            baseVersionId: null,
            changes: [{ field: "priceHkd", value: 1, owner: "ai" }],
          }),
          { params: Promise.resolve({ id }) },
        )
      ).status,
    ).toBe(400);
  });
});

describe("wine paragraph input", () => {
  it("passes only typed bilingual section edits through the guarded save", async () => {
    const h = handler();
    const sectionChanges = [
      { key: "introduction", en: "Edited", "zh-Hant": "已修改", locked: true },
    ];
    const response = await h.run(
      request({
        expectedInputRevision: 1,
        baseVersionId: null,
        sectionChanges,
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(h.save.mock.calls[0]![0].sectionChanges).toEqual(sectionChanges);
  });
  it.each([{ owner: "automatic" }, { claimIds: ["claim"] }, { proof: {} }])(
    "rejects section authority injection %j",
    async (extra) => {
      const h = handler();
      const response = await h.run(
        request({
          expectedInputRevision: 1,
          baseVersionId: null,
          sectionChanges: [
            {
              key: "introduction",
              en: "Edited",
              "zh-Hant": "已修改",
              ...extra,
            },
          ],
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBe(400);
      expect(h.save).not.toHaveBeenCalled();
    },
  );
});

it("rejects duplicate section keys", async () => {
  const h = handler(),
    section = { key: "tasting", en: "a", "zh-Hant": "b" };
  const res = await h.run(
    request({
      expectedInputRevision: 1,
      baseVersionId: null,
      sectionChanges: [section, section],
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(400);
  expect(h.save).not.toHaveBeenCalled();
});
