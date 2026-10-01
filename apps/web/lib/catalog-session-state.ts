import { exactQueryId } from "./workbench-navigation";
export function readCatalogSelection(scope: string): {
  ids: string[];
  exports: Array<[string, string | null]>;
} {
  try {
    const previousScope = sessionStorage.getItem("wukong:catalog:active-scope");
    if (previousScope && previousScope !== scope) clearWorkSession();
    sessionStorage.setItem("wukong:catalog:active-scope", scope);
    const value: unknown = JSON.parse(
      sessionStorage.getItem("wukong:catalog:selection:" + scope) ?? "null",
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("ids" in value) ||
      !Array.isArray(value.ids) ||
      value.ids.length > 5000
    )
      return { ids: [], exports: [] };
    const ids = value.ids.filter(
      (id): id is string => typeof id === "string" && !!exactQueryId(id),
    );
    const ownedIds = new Set(ids);
    const saved =
      "exports" in value && Array.isArray(value.exports) ? value.exports : [];
    return {
      ids,
      exports: saved
        .slice(0, 5000)
        .filter(
          (pair): pair is [string, string | null] =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            ownedIds.has(pair[0]) &&
            (pair[1] === null ||
              (typeof pair[1] === "string" && /^[a-f0-9]{64}$/i.test(pair[1]))),
        ),
    };
  } catch {
    return { ids: [], exports: [] };
  }
}
export function writeCatalogSelection(
  scope: string,
  ids: ReadonlySet<string>,
  exports: ReadonlyMap<string, string | null>,
) {
  try {
    sessionStorage.setItem(
      "wukong:catalog:selection:" + scope,
      JSON.stringify({
        ids: [...ids].slice(0, 5000),
        exports: [...exports].slice(0, 5000),
      }),
    );
  } catch {
    /* Storage is optional; server fences remain authoritative. */
  }
}
export function clearWorkSession() {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith("wukong:")) sessionStorage.removeItem(key);
    }
  } catch {
    /* Restricted browser storage. */
  }
}
