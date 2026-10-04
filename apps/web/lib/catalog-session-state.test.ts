// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  clearWorkSession,
  readCatalogSelection,
  writeCatalogSelection,
} from "./catalog-session-state";
it("keeps selection scoped to actor/workspace/role and clears work data on an identity switch", () => {
  sessionStorage.clear();
  const id = "11111111-1111-4111-8111-111111111111",
    digest = "a".repeat(64);
  writeCatalogSelection("scope-one", new Set([id]), new Map([[id, digest]]));
  expect(readCatalogSelection("scope-one")).toEqual({
    ids: [id],
    exports: [[id, digest]],
  });
  expect(readCatalogSelection("scope-two")).toEqual({ ids: [], exports: [] });
  sessionStorage.setItem("unrelated", "retained");
  clearWorkSession();
  expect(readCatalogSelection("scope-one").ids).toEqual([]);
  expect(sessionStorage.getItem("unrelated")).toBe("retained");
});
it("rejects malformed cached identities/digests without treating cache as authority", () => {
  sessionStorage.setItem(
    "wukong:catalog:selection:bad",
    '{"ids":["../foreign"],"exports":[["../foreign","anything"]]}',
  );
  expect(readCatalogSelection("bad")).toEqual({ ids: [], exports: [] });
});
it("clears old selection and scroll across workspace/role remount A to B to A", () => {
  sessionStorage.clear();
  const id = "11111111-1111-4111-8111-111111111111";
  readCatalogSelection("actor-A-role-operator");
  writeCatalogSelection("actor-A-role-operator", new Set([id]), new Map());
  sessionStorage.setItem(
    "wukong:catalog:scroll:actor-A-role-operator",
    '{"y":500}',
  );
  expect(readCatalogSelection("actor-A-role-operator").ids).toEqual([id]);
  expect(readCatalogSelection("actor-B-role-reviewer").ids).toEqual([]);
  expect(
    sessionStorage.getItem("wukong:catalog:scroll:actor-A-role-operator"),
  ).toBeNull();
  expect(readCatalogSelection("actor-A-role-operator").ids).toEqual([]);
});
