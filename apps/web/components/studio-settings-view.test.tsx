import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  McpConnectionView,
  McpConnectionsSnapshot,
} from "../lib/studio/mcp-connections";
import type { McpTokenView } from "../lib/studio/mcp-tokens";
import { studioSettingsAdminView } from "../lib/studio/settings-admin";
import { StudioSettingsView } from "./studio-settings-view";

/**
 * Settings-view rendering tests (plan Task 13 + A1): the editable workspace
 * card, token and connection panels, and the reviewed tool catalogue. Static
 * render only — interactive save behaviour is covered by the workspace panel's
 * own test.
 */

const SETTINGS_ROW = {
  workspaceId: "ws_test",
  enabled: true,
  allowedSkills: [] as string[],
  monthlyBudgetUsd: null,
  runCeilingUsd: null,
  retentionDays: null,
  defaultHome: false,
  ai: null,
  updatedBy: "actor_ops",
  updatedAt: new Date("2026-11-08T10:00:00.000Z"),
};

function adminView() {
  return studioSettingsAdminView(SETTINGS_ROW, {
    CONVERSATION_STUDIO_ENABLED: "true",
  } as unknown as NodeJS.ProcessEnv);
}

function connection(
  overrides: Partial<McpConnectionView> = {},
): McpConnectionView {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    label: "External catalogue",
    endpointUrl: "https://mcp.example.test/rpc",
    transport: "http",
    status: "draft",
    generation: 1,
    toolAllowlist: ["catalog.search"],
    schemaHashes: { "catalog.search": "a".repeat(64) },
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<McpConnectionsSnapshot> = {},
): McpConnectionsSnapshot {
  return {
    items: [],
    externalFlagOn: false,
    workspaceEnabled: true,
    encryptionKeyPresent: false,
    approvable: false,
    ...overrides,
  };
}

const tokens: McpTokenView[] = [
  {
    tokenId: "22222222-2222-4222-8222-222222222222",
    label: "Automation",
    prefix: "abcdefghijkl",
    scopes: ["read"],
    createdBy: "actor_ops",
    revokedAt: null,
    lastUsedAt: null,
    rateLimitPerMinute: 60,
    monthlyCallQuota: 1000,
    usage: { minuteCalls: 2, monthCalls: 41 },
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
  },
];

const tools = [
  {
    id: "catalog.search",
    label: { "zh-Hant": "搜尋商品目錄", en: "Search catalog" },
    kind: "read" as const,
    minRole: "operator",
    costClass: "free" as const,
  },
  {
    id: "listing.propose_copy",
    label: { "zh-Hant": "建立文案建議", en: "Propose listing copy" },
    kind: "propose" as const,
    minRole: "operator",
    costClass: "free" as const,
  },
];

function render(
  overrides: {
    locale?: "en" | "zh-Hant";
    tokens?: readonly McpTokenView[];
    connections?: McpConnectionsSnapshot;
  } = {},
) {
  return renderToStaticMarkup(
    <StudioSettingsView
      locale={overrides.locale ?? "en"}
      settingsAdmin={adminView()}
      tokens={overrides.tokens ?? tokens}
      connections={overrides.connections ?? snapshot()}
      tools={tools}
    />,
  );
}

describe("StudioSettingsView", () => {
  it("renders the editable workspace settings card and readiness flags", () => {
    const html = render();
    expect(html).toContain("Studio settings");
    expect(html).toContain("Workspace settings");
    expect(html).toContain("Monthly model budget (USD)");
    expect(html).toContain("Save settings");
    // Missing values are stated as blank/not set, never invented as zero.
    expect(html).toContain("Readiness");
    expect(html).toContain("Deployment flag");
    expect(html).toContain("No live model (deterministic only)");
  });

  it("renders token rows without any token value and revoked state", () => {
    const html = render({
      tokens: [
        ...tokens,
        {
          ...tokens[0]!,
          tokenId: "33333333-3333-4333-8333-333333333333",
          label: "Old token",
          revokedAt: "2026-11-08T09:00:00.000Z",
        },
      ],
    });
    expect(html).toContain("Automation");
    expect(html).toContain("abcdefghijkl");
    expect(html).toContain("Active");
    expect(html).toContain("Revoked");
    expect(html).not.toContain("wuk_");
  });

  it("states the external MCP disabled-by-default reality with honest reasons", () => {
    const html = render({
      connections: snapshot({ items: [connection()] }),
    });
    expect(html).toContain("External MCP connections");
    expect(html).toContain("External MCP is disabled by default");
    expect(html).toContain("STUDIO_EXTERNAL_MCP_ENABLED");
    expect(html).toContain("STUDIO_MCP_ENCRYPTION_KEY");
    expect(html).toContain("never connects to or probes an endpoint");
    expect(html).toContain("External catalogue");
    expect(html).toContain("Draft");
    // The approve action is disabled while the gates are closed.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve<\/button>/);
  });

  it("lists the reviewed tool catalogue with kind and role floors", () => {
    const html = render();
    expect(html).toContain("Tool catalogue (read-only)");
    expect(html).toContain("catalog.search");
    expect(html).toContain("listing.propose_copy");
    expect(html).toContain("Read");
    expect(html).toContain("Propose");
    expect(html).toContain("operator");
    expect(html).toContain("Free");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render({ locale: "zh-Hant" });
    expect(html).toContain("工作室設定");
    expect(html).toContain("工作區設定");
    expect(html).toContain("外部 MCP 連線");
    expect(html).toContain("預設停用");
  });
});
