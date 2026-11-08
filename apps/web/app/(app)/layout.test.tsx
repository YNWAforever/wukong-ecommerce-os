import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROLE_LABELS, SHELL_NAV_ITEMS } from "./shell-nav-items.js";

/**
 * The `(app)` shell is rendered on every authenticated route, so its Studio
 * change must be invisible when disabled and strictly additive when enabled.
 * The tests below render the real layout with the database, session and nav
 * client component mocked, and pin all three failure modes:
 *  - session missing -> redirect;
 *  - Studio disabled/malformed -> no nav item, every existing destination kept;
 *  - settings read throws -> shell still renders (fail closed, never broken).
 */
const state = vi.hoisted(() => ({
  session: null as {
    workspaceId: string;
    actorId: string;
    role: "owner" | "viewer";
  } | null,
  settings: null as {
    enabled: boolean;
    defaultHome: boolean;
    ai: unknown | null;
  } | null,
  settingsError: null as Error | null,
  settingsReads: 0,
  accountRole: "owner" as "owner" | "viewer",
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("../../lib/session-context", () => ({
  authSessionContext: { resolve: async () => state.session },
  requireWorkspaceRole: (required: string, actual: string) =>
    actual === "admin" || actual === "owner",
}));

vi.mock("../../lib/account-read", () => ({
  readWorkspaceAccount: async () => ({
    user: {
      userId: "actor",
      email: "actor@example.test",
      name: "Actor",
    },
    role: state.accountRole,
    contacts: [],
  }),
}));

vi.mock("../../lib/intake-runtime", () => ({
  getDatabase: () => ({
    forWorkspace: async (
      _workspaceId: string,
      callback: (repos: unknown) => unknown,
    ) =>
      callback({
        studio: {
          settings: {
            get: async () => {
              state.settingsReads += 1;
              if (state.settingsError) throw state.settingsError;
              return state.settings;
            },
          },
        },
      }),
  }),
}));

vi.mock("../../lib/workspace-selection", () => ({
  listUserWorkspaces: async () => [],
}));

vi.mock("./workspace-chrome", () => ({
  resolveWorkspaceChrome: async () => ({
    workspaceName: "Opak Cellar",
    roleLabel: { zh: "管理員", en: "Admin" },
  }),
}));

vi.mock("../../components/app-shell-nav", () => ({
  AppShellNav: (props: {
    navItems: ReadonlyArray<{ href: string; labelEn: string }>;
    isAdmin: boolean;
  }) => (
    <nav data-testid="shell-nav" data-admin={String(props.isAdmin)}>
      {props.navItems.map((item) => (
        <a key={item.href} href={item.href}>
          {item.labelEn}
        </a>
      ))}
    </nav>
  ),
}));

import AppLayout from "./layout";

function children() {
  return <p>page content</p>;
}

async function renderShell() {
  return renderToStaticMarkup(await AppLayout({ children: children() }));
}

beforeEach(() => {
  state.session = { workspaceId: "workspace", actorId: "actor", role: "owner" };
  state.settings = { enabled: true, defaultHome: false, ai: null };
  state.settingsError = null;
  state.settingsReads = 0;
  state.accountRole = "owner";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SHELL_NAV_ITEMS", () => {
  it("keeps the primary workflow and all existing tools in the approved order", () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/catalog",
      "/listings/import",
      "/jobs?kind=export",
      "/queue",
      "/batches",
      "/listings/new",
      "/jobs",
      "/quality",
      "/system-map",
    ]);
  });

  it("does not contain the flag-gated Studio destination", () => {
    expect(SHELL_NAV_ITEMS.map((item) => item.href)).not.toContain("/studio");
  });
});

describe("ROLE_LABELS", () => {
  it("has a bilingual label for every WorkspaceRole", () => {
    for (const role of [
      "viewer",
      "operator",
      "reviewer",
      "admin",
      "owner",
    ] as const) {
      expect(ROLE_LABELS[role].zh).toBeTruthy();
      expect(ROLE_LABELS[role].en).toBeTruthy();
    }
  });
});

describe("AppLayout Studio navigation", () => {
  it("redirects a missing session to sign-in before any settings read", async () => {
    state.session = null;

    await expect(AppLayout({ children: children() })).rejects.toThrow(
      "redirect:/signin",
    );
    expect(state.settingsReads).toBe(0);
  });

  it("omits Studio by default and keeps every existing destination", async () => {
    const html = await renderShell();

    expect(html).not.toContain('href="/studio"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/catalog"');
    expect(html).toContain("Opak Cellar");
    // Default-off shortcut: the shell never opens a Studio settings
    // transaction while the deployment flag is off.
    expect(state.settingsReads).toBe(0);
  });

  it("omits Studio when only the env flag is on and the workspace row is disabled", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.settings = { enabled: false, defaultHome: false, ai: null };

    expect(await renderShell()).not.toContain('href="/studio"');
    expect(state.settingsReads).toBe(1);
  });

  it("omits Studio for a malformed env value", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true ");

    expect(await renderShell()).not.toContain('href="/studio"');
    expect(state.settingsReads).toBe(0);
  });

  it("prepends Studio ahead of Workbench when the env flag and workspace row both enable it", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");

    const html = await renderShell();

    expect(html).toContain('href="/studio"');
    expect(html).toContain("Studio");
    expect(html.indexOf('href="/studio"')).toBeLessThan(
      html.indexOf('href="/dashboard"'),
    );
    expect(state.settingsReads).toBe(1);
  });

  it("shows Studio to a viewer (read-only Studio is the server's call)", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.accountRole = "viewer";

    const html = await renderShell();

    expect(html).toContain('href="/studio"');
    // Existing role gating is unchanged: a viewer still does not see the
    // operator-only destinations.
    expect(html).not.toContain('href="/listings/import"');
  });

  it("fails closed to no Studio item when the settings read throws, without breaking the shell", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.settingsError = new Error("connection string must never be rendered");

    const html = await renderShell();

    expect(html).not.toContain('href="/studio"');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Opak Cellar");
    expect(html).toContain("page content");
  });
});
