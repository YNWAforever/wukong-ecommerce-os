"use client";
import { useCallback, useEffect, useState } from "react";
/** URL-owned state, including native back/forward, without remounting work forms. */
export function useWorkQuery(initialSearch?: string) {
  const [search, setSearch] = useState(
    initialSearch ??
      (typeof window === "undefined" ? "" : window.location.search),
  );
  useEffect(() => {
    if (initialSearch !== undefined) setSearch(initialSearch);
  }, [initialSearch]);
  useEffect(() => {
    const restore = () => setSearch(window.location.search);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const navigate = useCallback(
    (query: string, mode: "replace" | "push" = "replace") => {
      const url = new URL(window.location.href);
      const next = new URLSearchParams(query);
      // Keep only contextual metadata already present, never selected product IDs.
      for (const key of ["returnTo", "attempt"]) {
        const value = url.searchParams.get(key);
        if (value) next.set(key, value);
      }
      const href = url.pathname + (next.size ? "?" + next : "");
      if (href !== url.pathname + url.search)
        window.history[mode === "push" ? "pushState" : "replaceState"](
          window.history.state,
          "",
          href,
        );
      setSearch(next.toString());
    },
    [],
  );
  return { search, navigate };
}
