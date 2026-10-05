import { expect, it } from "vitest";
import { decodeReadCursor, encodeReadCursor } from "./read-cursor";
const scope = {
  workspaceId: "owned",
  actorId: "operator",
  role: "operator",
  kind: "catalog",
  pageSize: 25,
  q: "000674",
  filter: "all",
};
const position = {
  at: "2026-01-01T00:00:00.123456+00:00",
  id: "00000000-0000-4000-8000-000000000001",
  tie: "platform",
  direction: "next" as const,
};
it("round-trips exact PostgreSQL microseconds without a JavaScript Date", () => {
  expect(decodeReadCursor(encodeReadCursor(position, scope), scope)).toEqual(
    position,
  );
});
it("rejects another workspace, actor, role, search, size or view", () => {
  const token = encodeReadCursor(position, scope);
  for (const change of [
    { workspaceId: "foreign" },
    { actorId: "other" },
    { role: "reviewer" },
    { q: "different" },
    { pageSize: 100 },
    { kind: "jobs" },
  ])
    expect(() => decodeReadCursor(token, { ...scope, ...change })).toThrow(
      "cursor",
    );
});
it("rejects malformed/unbounded position tokens rather than falling back to page one", () => {
  for (const value of [
    "bad",
    "x".repeat(1025),
    Buffer.from(
      JSON.stringify({ v: 1, position: { ...position, id: "../../foreign" } }),
    ).toString("base64url"),
  ])
    expect(() => decodeReadCursor(value, scope)).toThrow();
});
