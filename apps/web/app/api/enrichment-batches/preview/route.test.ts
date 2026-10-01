import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/route-support";
import { createBatchPreviewHandler } from "./route";

const input = {
  label: "Synthetic",
  budgetUsd: 1,
  waveSize: 2,
  selection: {
    mode: "explicit",
    listingIds: [randomUUID()],
    fields: ["nameZh"],
  },
};
const post = (body: unknown) =>
  new Request("http://localhost/api/enrichment-batches/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
function fixture(role = "operator") {
  const preview = vi.fn(async (_input: unknown) => ({
    previewId: randomUUID(),
    digest: "a".repeat(64),
    expiresAt: "2026-10-01T09:00:00Z",
    selectedCount: 1,
    eligibleCount: 1,
    skippedByReason: {},
    fields: ["nameZh" as const],
    budgetUsd: 1,
    waveSize: 2,
    maxCostUsd: 0,
  }));
  const handler = createBatchPreviewHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "owned",
        actorId: "operator",
        role: role as "operator",
      }),
    },
    preview,
  });
  return { handler, preview };
}
it("uses server workspace and actor for a read-only preview", async () => {
  const f = fixture();
  expect((await f.handler(post(input))).status).toBe(200);
  expect(f.preview).toHaveBeenCalledWith({
    ...input,
    workspaceId: "owned",
    actorId: "operator",
  });
});
it("refuses viewer and client workspace, protected fields, and duplicate identities before preview", async () => {
  const viewer = fixture("viewer");
  expect((await viewer.handler(post(input))).status).toBe(403);
  expect(viewer.preview).not.toHaveBeenCalled();
  for (const body of [
    { ...input, workspaceId: "foreign" },
    { ...input, selection: { ...input.selection, fields: ["sku"] } },
    {
      ...input,
      selection: {
        ...input.selection,
        listingIds: [
          input.selection.listingIds[0],
          input.selection.listingIds[0],
        ],
      },
    },
  ]) {
    const f = fixture();
    expect((await f.handler(post(body))).status).toBe(400);
    expect(f.preview).not.toHaveBeenCalled();
  }
});
it("keeps foreign identities and stale selection errors visible", async () => {
  for (const [status, code] of [
    [403, "selection_not_authorized"],
    [409, "batch_content_stale"],
  ] as const) {
    const f = fixture();
    f.preview.mockRejectedValueOnce(
      new ApiError(status, code, "Refresh the selection."),
    );
    const response = await f.handler(post(input));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
});
it("reports whole database or permission failure as 500 without exception content", async () => {
  for (const code of ["42501", "08006"]) {
    const f = fixture();
    const message = "PRIVATE_CUSTOMER_AND_CONNECTION";
    f.preview.mockRejectedValueOnce(
      Object.assign(new Error(message), { code }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await f.handler(post(input));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(message);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(message);
    } finally {
      spy.mockRestore();
    }
  }
});
