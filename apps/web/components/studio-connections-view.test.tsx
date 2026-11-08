import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TOOL_DEFINITIONS } from "@wukong/core";

import { StudioConnectionsView } from "./studio-connections-view";

function render(locale: "zh-Hant" | "en") {
  return renderToStaticMarkup(<StudioConnectionsView locale={locale} />);
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

  it("does not claim a read tool is externally available or connected", () => {
    const html = render("en");

    expect(html).toContain("Read tool; used only by enabled skills.");
    expect(html).toContain("Registered; not executable yet.");
    expect(html).not.toMatch(/\bconnected\b/i);
    expect(html).not.toMatch(/\bConnect\b/);
    expect(html).not.toContain("<button");
  });

  it("states hosted MCP tokens as not configured and planned", () => {
    const html = render("en");
    expect(html).toContain("Hosted MCP tokens");
    expect(html).toContain("Not configured");
    expect(html).toContain("The hosted MCP server is not implemented");
    expect(html).toContain("Planned; not implemented yet.");
  });

  it("states external MCP as disabled by default with no user-supplied credentials", () => {
    const html = render("en");
    expect(html).toContain("External MCP connections");
    expect(html).toContain("Disabled");
    expect(html).toContain(
      "no user-supplied endpoint or credential is accepted",
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
    expect(html).toContain("未設定");
    expect(html).toContain("已停用");
  });
});
