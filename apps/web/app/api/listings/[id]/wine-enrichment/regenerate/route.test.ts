import { expect, it, vi } from "vitest";
import { createWineOperationHandler } from "../../../../../../lib/wine-operation-route";
const id = "00000000-0000-4000-8000-000000000001",
  key = "00000000-0000-4000-8000-000000000002";
it.each([
  { mode: "copy", section: "tasting" },
  { mode: "section" },
  { mode: "full" },
  { mode: "section", section: "invalid" },
  { mode: "section", section: "tasting", claims: [] },
])(
  "rejects incorrect regeneration mode/section and client support",
  async (body) => {
    const database = vi.fn();
    const handler = createWineOperationHandler(
      {
        sessionContext: {
          resolve: async () => ({
            workspaceId: "ws",
            actorId: "operator",
            role: "operator",
          }),
        },
        getDatabase: database,
      },
      "regenerate",
    );
    const response = await handler(
      new Request("http://localhost/regenerate", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          expectedInputRevision: 1,
          baseVersionId: null,
          ...body,
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(400);
    expect(database).not.toHaveBeenCalled();
  },
);
