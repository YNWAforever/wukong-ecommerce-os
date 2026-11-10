import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TOOL_DEFINITIONS } from "@wukong/core";

import {
  resolveConnectionsRuntime,
  StudioConnectionsView,
  type ConnectionsRuntimeState,
} from "./studio-connections-view";

const KEY = Buffer.alloc(32, 0x01).toString("base64");

const OFF: ConnectionsRuntimeState = {
  hostedMcpEnabled: false,
  externalMcpEnabled: false,
  mcpEncryptionKeyPresent: false,
};

function render(
  locale: "zh-Hant" | "en",
  runtime: ConnectionsRuntimeState = OFF,
) {
  return renderToStaticMarkup(
    <StudioConnectionsView locale={locale} runtime={runtime} />,
  );
}

describe("StudioConnectionsView", () => {
  it("lists the reviewed internal tools with kind, minimum role and capability", () => {
    const html = render("en");

    expect(html).toContain("Internal tools");
    for (const tool of TOOL_DEFINITIONS) {
      expect(html).toContain(tool.id);
      expect(html).toContain(tool.capabilityId);
    }
    // One row per registered tool, no invented extra tool.
    expect((html.match(/<tr data-tool-id=/g) ?? []).length).toBe(
      TOOL_DEFINITIONS.length,
    );
    expect(html).toContain("conversation-studio");
    expect(html).toContain("Read");
    expect(html).toContain("Propose");
  });

  it("does not claim a connection or render a connect control", () => {
    const html = render("en");

    expect(html).toContain(
      "Read tool; executed by enabled skills and, when its flag is on, the hosted MCP endpoint.",
    );
    expect(html).toContain(
      "Registered and advertised over hosted MCP; execution returns unavailable until a reviewed skill wires it.",
    );
    expect(html).toContain(
      "Registered; never exposed over MCP. Dispatch runs only through the explicit confirmed Studio route.",
    );
    expect(html).not.toMatch(/\bconnected\b/i);
    expect(html).not.toMatch(/>Connect</);
    expect(html).not.toContain("<button");
  });

  it("states the hosted MCP endpoint as off when its flag is off", () => {
    const html = render("en");
    expect(html).toContain("Hosted MCP tokens");
    expect(html).toContain("Off on this deployment");
    expect(html).toContain("STUDIO_MCP_SERVER_ENABLED is off");
    expect(html).not.toContain("The hosted MCP server is not implemented");
    expect(html).toContain("Open Studio settings");
  });

  it("states the hosted MCP endpoint as flag-enabled without claiming a token exists", () => {
    const html = render("en", { ...OFF, hostedMcpEnabled: true });
    expect(html).toContain("Flag enabled");
    expect(html).toContain("admin-issued workspace tokens can call");
    expect(html).toContain("/api/mcp");
    expect(html).toContain("Tokens are created, rotated and revoked");
  });

  it("states external MCP as admin-only and off by default", () => {
    const html = render("en");
    expect(html).toContain("External MCP connections");
    expect(html).toContain("Disabled by default");
    expect(html).toContain("admin-only and off by default");
    expect(html).toContain("probe advertised schemas");
    expect(html).toContain(
      "a user-supplied endpoint or credential is never accepted at call time",
    );
  });

  it("reports a flag-enabled external registry and an unreadable encryption key honestly", () => {
    const withoutKey = render("en", { ...OFF, externalMcpEnabled: true });
    expect(withoutKey).toContain("Flag enabled; per-connection approval");
    expect(withoutKey).toContain("STUDIO_MCP_ENCRYPTION_KEY is not configured");

    const withKey = render("en", {
      ...OFF,
      externalMcpEnabled: true,
      mcpEncryptionKeyPresent: true,
    });
    expect(withKey).toContain("Flag enabled; per-connection approval");
    expect(withKey).not.toContain(
      "STUDIO_MCP_ENCRYPTION_KEY is not configured",
    );
  });

  it("states WhatsApp, customer service and logistics as blocked for a stated reason", () => {
    const html = render("en");
    expect(html).toContain("Blocked connections");
    expect(html).toContain("WhatsApp: no supported channel exists");
    expect(html).toContain("Customer-service inbox: no data source exists");
    expect(html).toContain("Logistics and orders: no data source exists");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");
    expect(html).toContain("工具與連線");
    expect(html).toContain("內部工具");
    expect(html).toContain("此部署停用");
    expect(html).toContain("預設停用");
  });

  it("resolves the runtime state only from exact flag strings and a valid key", () => {
    expect(
      resolveConnectionsRuntime({
        STUDIO_MCP_SERVER_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "true",
        STUDIO_MCP_ENCRYPTION_KEY: KEY,
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      hostedMcpEnabled: true,
      externalMcpEnabled: true,
      mcpEncryptionKeyPresent: true,
    });
    for (const env of [
      {},
      { STUDIO_MCP_SERVER_ENABLED: "TRUE", STUDIO_EXTERNAL_MCP_ENABLED: "1" },
      {
        STUDIO_MCP_SERVER_ENABLED: "true",
        STUDIO_EXTERNAL_MCP_ENABLED: "true",
        STUDIO_MCP_ENCRYPTION_KEY: "not-a-key",
      },
    ]) {
      expect(
        resolveConnectionsRuntime(env as unknown as NodeJS.ProcessEnv),
      ).toEqual({
        hostedMcpEnabled:
          (env as Record<string, string>).STUDIO_MCP_SERVER_ENABLED === "true",
        externalMcpEnabled:
          (env as Record<string, string>).STUDIO_EXTERNAL_MCP_ENABLED ===
          "true",
        mcpEncryptionKeyPresent: false,
      });
    }
  });
});
