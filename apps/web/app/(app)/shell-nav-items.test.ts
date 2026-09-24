/**
 * The shell offered every reader every destination.
 *
 * §8 of the integration plan chartered role-aware navigation "consistent with
 * the existing `requireWorkspaceRole` mechanism". It was never built: `NavItem`
 * carried no role, and the only gating was a binary `isAdmin` prop controlling
 * one extra row. A viewer saw Imports, New listing and Batches — three
 * destinations whose APIs refuse them, and in the case of Batches whose *read*
 * refuses them too, so the page renders nothing but a permission error.
 *
 * This is not a security boundary and must not be mistaken for one. Every route
 * and API enforces its own role server-side, exactly as `CLAUDE.md` says of the
 * middleware cookie check; hiding a link protects nobody. What it fixes is
 * truthfulness: an interface that offers work the reader cannot do.
 */
import { describe, expect, it } from "vitest";

import type { WorkspaceRole } from "../../lib/session-context";
import { SHELL_NAV_ITEMS, visibleNavItems } from "./shell-nav-items";

/**
 * Destinations whose server-side gate is `operator`, verified in the source:
 * `/api/listings/import` (route.ts:59), `/api/listings` (route.ts:63) and
 * `/api/enrichment-batches` (route.ts:50 and :84 — the GET as well as the POST,
 * which is why `batch-list.tsx` maps `insufficient_role` for a plain read).
 *
 * Pinned exactly, so that adding a destination here is a visible decision
 * rather than a silent one.
 */
const OPERATOR_ONLY = ["/listings/import", "/listings/new", "/batches"];

describe("shell navigation", () => {
  it("marks exactly the destinations whose server gate is operator", () => {
    const marked = SHELL_NAV_ITEMS.filter((item) => item.role).map(
      (item) => item.href,
    );

    expect(marked.sort()).toEqual([...OPERATOR_ONLY].sort());
    for (const item of SHELL_NAV_ITEMS) {
      if (!item.role) continue;
      expect(item.role).toBe("operator");
    }
  });

  it("hides from a viewer the work a viewer cannot do", () => {
    const hrefs = visibleNavItems("viewer").map((item) => item.href);

    for (const href of OPERATOR_ONLY) expect(hrefs).not.toContain(href);
    // Read surfaces stay: a viewer can legitimately read the catalog, the
    // queue, the ledger and the quality report.
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/catalog",
        "/queue",
        "/jobs",
        "/quality",
      ]),
    );
  });

  it.each<WorkspaceRole>(["operator", "reviewer", "admin", "owner"])(
    "shows every destination to %s",
    (role) => {
      // `requireWorkspaceRole` is an ordering, not an equality: anyone at or
      // above operator can do operator work.
      expect(visibleNavItems(role).map((item) => item.href)).toEqual(
        SHELL_NAV_ITEMS.map((item) => item.href),
      );
    },
  );

  it("shows only unrestricted destinations when there is no session", () => {
    // The layout resolves a session before rendering, so this guards a future
    // caller passing null rather than a state reachable today.
    const hrefs = visibleNavItems(null).map((item) => item.href);

    for (const href of OPERATOR_ONLY) expect(hrefs).not.toContain(href);
    expect(hrefs).toContain("/dashboard");
  });

  it("keeps every destination reachable by someone", () => {
    // A nav item nobody can see is a dead entry; this catches a typo in a role
    // that would silently hide a destination from every reader.
    const ownerHrefs = visibleNavItems("owner").map((entry) => entry.href);

    for (const item of SHELL_NAV_ITEMS) {
      expect(ownerHrefs).toContain(item.href);
    }
  });
});
