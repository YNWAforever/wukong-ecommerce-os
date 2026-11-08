import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio` gate tests.
 *
 * The layout is the security-adjacent UX gate (the APIs re-check everything):
 * session -> workspace settings row -> env flags, and every failure mode ends
 * in a 404 rather than a crash or a half-rendered shell.
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
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" && state.locale !== undefined
        ? { value: state.locale }
        : undefined,
  }),
}));

vi.mock("../../../lib/session-context", () => ({
  authSessionContext: { resolve: async () => state.session },
}));

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
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(html).toContain("還沒有對話。");
    expect(html).toContain("home slot");
  });

  it("renders English rail copy when the locale cookie says en", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.locale = "en";

    const html = await render();

    expect(html).toContain("New conversation");
    expect(html).toContain("Studio navigation");
    expect(html).toContain("No conversations yet.");
  });
});
