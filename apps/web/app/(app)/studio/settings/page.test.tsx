import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio/settings` gate and honest-state tests (plan Task 13).
 *
 * The page uses the shared admin gate: no session redirects, a disabled Studio
 * row or a below-admin role 404s, and an admin sees the registry panels with
 * the disabled-by-default external MCP state. Fakes only; no network.
 */

type Role = "viewer" | "operator" | "reviewer" | "admin" | "owner";

const state = vi.hoisted(() => ({
  session: null as {
    workspaceId: string;
    actorId: string;
    role: Role;
  } | null,
  settings: null as Record<string, unknown> | null,
  tokens: [] as Array<Record<string, unknown>>,
  connections: [] as Array<Record<string, unknown>>,
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
      name === "locale" ? { value: "en" } : undefined,
  }),
}));

vi.mock("../../../../lib/session-context", () => {
  const rank: Record<string, number> = {
    viewer: 10,
    operator: 20,
    reviewer: 30,
    admin: 40,
    owner: 50,
  };
  return {
    authSessionContext: { resolve: async () => state.session },
    requireWorkspaceRole: (required: string, actual: string) =>
      (rank[actual] ?? 0) >= (rank[required] ?? 0),
  };
});

vi.mock("../../../../lib/intake-runtime", () => ({
  getDatabase: () => ({
    forWorkspace: async (
      _workspaceId: string,
      callback: (repos: unknown) => unknown,
    ) => {
      const repos = {
        studio: {
          settings: { get: async () => state.settings },
          apiTokens: { list: async () => state.tokens },
          mcpConnections: { list: async () => state.connections },
        },
      };
      return callback(repos);
    },
  }),
}));

import StudioSettingsPage from "./page";

beforeEach(() => {
  vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
  vi.stubEnv("STUDIO_EXTERNAL_MCP_ENABLED", "");
  state.session = {
    workspaceId: "workspace",
    actorId: "actor",
    role: "admin",
  };
  state.settings = {
    workspaceId: "workspace",
    enabled: true,
    allowedSkills: [],
    monthlyBudgetUsd: null,
    runCeilingUsd: null,
    retentionDays: null,
    defaultHome: false,
    ai: null,
    updatedBy: "actor",
    updatedAt: null,
  };
  state.tokens = [];
  state.connections = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function render() {
  return renderToStaticMarkup(await StudioSettingsPage());
}

describe("/studio/settings gate", () => {
  it("redirects a missing session to sign-in", async () => {
    state.session = null;
    await expect(StudioSettingsPage()).rejects.toThrow("redirect:/signin");
  });

  it.each(["viewer", "operator", "reviewer"] as const)(
    "404s for the %s role",
    async (role) => {
      state.session = { workspaceId: "workspace", actorId: "actor", role };
      await expect(StudioSettingsPage()).rejects.toThrow("notFound");
    },
  );

  it("404s when Studio is disabled by flag or workspace row", async () => {
    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "");
    await expect(StudioSettingsPage()).rejects.toThrow("notFound");

    vi.stubEnv("CONVERSATION_STUDIO_ENABLED", "true");
    state.settings = { ...state.settings, enabled: false };
    await expect(StudioSettingsPage()).rejects.toThrow("notFound");
  });
});

describe("/studio/settings content", () => {
  it("renders the admin registry surface with honest disabled states", async () => {
    const html = await render();
    expect(html).toContain("Studio settings");
    expect(html).toContain("Workspace Studio state");
    expect(html).toContain("API tokens");
    expect(html).toContain("No tokens yet.");
    expect(html).toContain("External MCP connections");
    expect(html).toContain("External MCP is disabled by default");
    expect(html).toContain("Tool catalogue (read-only)");
    expect(html).toContain("catalog.search");
    // No fabricated connection state or token value anywhere.
    expect(html).not.toContain("wuk_");
  });

  it("renders token metadata and connection registry rows for an owner", async () => {
    state.session = { workspaceId: "workspace", actorId: "actor", role: "owner" };
    state.tokens = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        workspaceId: "workspace",
        label: "Automation",
        prefix: "abcdefghijkl",
        scopes: ["read"],
        createdBy: "actor",
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date("2026-11-08T10:00:00.000Z"),
        updatedAt: new Date("2026-11-08T10:00:00.000Z"),
      },
    ];
    state.connections = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        workspaceId: "workspace",
        label: "External catalogue",
        endpointUrl: "https://mcp.example.test/rpc",
        transport: "http",
        status: "draft",
        generation: 1,
        toolAllowlist: ["catalog.search"],
        schemaHashes: { "catalog.search": "a".repeat(64) },
        credentialEnvelope: "v1.iv.ciphertext",
        createdBy: "actor",
        approvedBy: null,
        approvedAt: null,
        createdAt: new Date("2026-11-08T10:00:00.000Z"),
        updatedAt: new Date("2026-11-08T10:00:00.000Z"),
      },
    ];
    const html = await render();
    expect(html).toContain("Automation");
    expect(html).toContain("abcdefghijkl");
    expect(html).toContain("External catalogue");
    expect(html).toContain("Draft");
    expect(html).not.toContain("v1.iv.ciphertext");
  });
});

