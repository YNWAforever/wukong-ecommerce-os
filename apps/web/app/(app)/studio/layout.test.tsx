import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio` gate tests.
 *
 * The layout is the security-adjacent UX gate (the APIs re-check everything):
 * session -> workspace settings row -> env flags, and every failure mode ends
 * in a 404 rather than a crash or a half-rendered shell. The recent-thread read
 * happens after the gate and must degrade to the rail's empty state instead of
 * taking the enabled surface down.
 */

const state = vi.hoisted(() => ({
  session: null as {
    workspaceId: string;
    actorId: string;
    role: "admin" | "viewer";
  } | null,
  settings: null as {
    enabled: boolean;
    defaultHome: boolean;
    ai: unknown | null;
  } | null,
  settingsError: null as Error | null,
  locale: undefined as string | undefined,
  listThreads: null as null | (() => Promise<unknown>),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" && state.locale !== undefined
        ? { value: state.locale }
        : undefined,
  }),
}));

vi.mock("../../../lib/session-context", () => {
  const roleRank: Record<string, number> = {
    viewer: 10,
    operator: 20,
    reviewer: 30,
    admin: 40,
    owner: 50,
  };
  return {
    authSessionContext: { resolve: async () => state.session },
    requireWorkspaceRole: (required: string, actual: string) =>
      (roleRank[actual] ?? 0) >= (roleRank[required] ?? 0),
  };
});

vi.mock("../../../lib/intake-runtime", () => ({
  getDatabase: () => ({
    forWorkspace: async (
      _workspaceId: string,
      callback: (repos: unknown) => unknown,
    ) => {
      const repos = {
        studio: {
          settings: {
            get: async () => {
              if (state.settingsError) throw state.settingsError;
              return state.settings;
            },
          },
        },
      };
      return callback(repos);
    },
  }),
}));

vi.mock("../workspace-chrome", () => ({
  resolveWorkspaceChrome: async () => ({
    workspaceName: "Opak Cellar",
    roleLabel: { zh: "管理員", en: "Admin" },
  }),
}));

vi.mock("./studio-service", () => ({
  studioService: () => ({
    listThreads: () =>
      state.listThreads === null
        ? Promise.resolve({ items: [], truncated: false })
        : state.listThreads(),
  }),
  studioAiEnabled: async () => false,
}));

import StudioLayout from "./layout";

function children() {
  return <p data-testid="studio-child">home slot</p>;
}

async function render() {
  return renderToStaticMarkup(await StudioLayout({ children: children() }));
}

beforeEach(() => {
  state.session = { workspaceId: "workspace", actorId: "actor", role: "admin" };
  state.settings = { enabled: true, defaultHome: false, ai: null };
  state.settingsError = null;
  state.locale = undefined;
  state.listThreads = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("StudioLayout gate", () => {
  it("redirects a missing session to sign-in", async () => {
    state.session = null;

    await expect(StudioLayout({ children: children() })).rejects.toThrow(
      "redirect:/signin",
    );
  });

  it("404s when the env flag is absent, even if the workspace row is enabled", async () => {
    await expect(render()).rejects.toThrow("notFound");
  });

  it.each(["1", "true ", "TRUE", "yes", "false"])(
    "404s on the malformed env value %j",
    async (value) => {
      vi.stubEnv("CONVERSATION_STUDIO_ENABLED", value);

      await expect(render()).rejects.toThrow("notFound");
    },
  );

  it("404s when the workspace settings row is not enabled", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.settings = { enabled: false, defaultHome: true, ai: null };

    await expect(render()).rejects.toThrow("notFound");
  });

  it("404s when no workspace row exists (disabled defaults)", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.settings = null;

    await expect(render()).rejects.toThrow("notFound");
  });

  it("fails closed to 404 when the settings read throws", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.settingsError = new Error("connection string must never be rendered");

    await expect(render()).rejects.toThrow("notFound");
  });

  it("renders the shell and page slot when env and workspace row both enable Studio", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");

    const html = await render();

    expect(html).toContain("Opak Cellar");
    expect(html).toContain("新對話");
    expect(html).toContain("最近的對話");
    expect(html).toContain("還沒有對話");
    expect(html).toContain("home slot");
  });

  it("passes the recent threads the service returned to the rail", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.listThreads = async () => ({
      items: [
        {
          threadId: "thread-1",
          title: "Synthetic recent conversation",
          skillKey: "catalog.find",
          visibility: "workspace",
          status: "open",
          createdBy: "actor",
          lastMessageAt: "2026-11-08T00:00:00.000Z",
          createdAt: "2026-11-08T00:00:00.000Z",
          updatedAt: "2026-11-08T00:00:00.000Z",
        },
      ],
      truncated: true,
    });

    const html = await render();

    expect(html).toContain("Synthetic recent conversation");
    expect(html).toContain('href="/studio/t/thread-1"');
    expect(html).toContain("只顯示最近更新的對話。");
  });

  it("fails closed to the empty rail when the threads read throws, logging no content", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    state.listThreads = async () => {
      throw new Error("connection string must never be rendered");
    };

    const html = await render();

    expect(html).toContain("還沒有對話");
    expect(html).not.toContain("connection string");
    const logged = info.mock.calls.map((call) => String(call[0]));
    expect(
      logged.some((line) => line.includes("studio_layout_threads_read_failed")),
    ).toBe(true);
    for (const line of logged) {
      expect(line).not.toContain("connection string");
    }
  });

  it("renders English rail copy when the locale cookie says en", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.locale = "en";

    const html = await render();

    expect(html).toContain("New conversation");
    expect(html).toContain("Studio navigation");
    expect(html).toContain("No conversations yet");
  });

  it("disables New conversation for a viewer with the stated reason", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.locale = "en";
    state.session = {
      workspaceId: "workspace",
      actorId: "viewer",
      role: "viewer",
    };

    const html = await render();

    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>New conversation<\/button>/,
    );
    expect(html).toContain(
      "An operator or higher role is required to create conversations.",
    );
  });
});
