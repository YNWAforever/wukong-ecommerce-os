// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  McpConnectionView,
  McpConnectionsSnapshot,
} from "../lib/studio/mcp-connections";
import { StudioMcpConnectionsPanel } from "./studio-mcp-connections-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * External-MCP registry panel tests (plan Task 13): the disabled-by-default
 * banner and honest reasons are always rendered, approval is disabled while a
 * gate is closed, and an approval only happens after the explicit click.
 */

const HASH = "a".repeat(64);

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
    schemaHashes: { "catalog.search": HASH },
    credentialPresent: false,
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
    probeAvailable: false,
    ...overrides,
  };
}

function render(value: McpConnectionsSnapshot) {
  return renderToStaticMarkup(
    <StudioMcpConnectionsPanel locale="en" snapshot={value} />,
  );
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(value: McpConnectionsSnapshot) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<StudioMcpConnectionsPanel locale="en" snapshot={value} />);
  });
  return container;
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  // React tracks the previous DOM value; go through the prototype setter so
  // the synthetic onChange sees a real change.
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitForm(container: HTMLElement) {
  container
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("StudioMcpConnectionsPanel", () => {
  it("renders the disabled banner, honest reasons and no live indicator", () => {
    const html = render(snapshot({ items: [connection()] }));
    expect(html).toContain("External MCP connections");
    expect(html).toContain("External MCP is disabled by default");
    expect(html).toContain("STUDIO_EXTERNAL_MCP_ENABLED");
    expect(html).toContain("STUDIO_MCP_ENCRYPTION_KEY");
    expect(html).toContain("No live connection indicator");
    expect(html).toContain("External catalogue");
    expect(html).toContain("Draft");
    expect(html).toContain("aaaaaaaaaaaaaaaa");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve<\/button>/);
  });

  it("renders the empty registry state and the draft form", () => {
    const html = render(snapshot());
    expect(html).toContain("No external connections are registered.");
    expect(html).toContain("Create draft connection");
    expect(html).toContain("HTTPS endpoint");
    expect(html).toContain("Tool allowlist (one per line)");
    expect(html).toContain("Schema hashes (JSON: tool name");
  });

  it("approves only after the explicit click and shows the honest notice", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(
          connection({ status: "approved", approvedBy: "actor_ops" }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount(
      snapshot({
        items: [connection()],
        externalFlagOn: true,
        encryptionKeyPresent: true,
        approvable: true,
      }),
    );
    const approve = findButton(container, "Approve");
    expect(approve?.disabled).toBe(false);

    await act(async () => {
      approve!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/studio/mcp-connections/11111111-1111-4111-8111-111111111111",
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      status: "approved",
    });
    expect(container.textContent).toContain(
      "Connection approved; external transport is still controlled by the deployment flag.",
    );
    expect(container.textContent).toContain("Approved");
  });

  it("creates a draft with the parsed allowlist and schema hashes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(connection({ label: "New server" }), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount(snapshot());
    const label = container.querySelector(
      'input[name="connection-label"]',
    ) as HTMLInputElement;
    const endpoint = container.querySelector(
      'input[name="connection-endpoint"]',
    ) as HTMLInputElement;
    const allowlist = container.querySelector(
      'textarea[name="connection-allowlist"]',
    ) as HTMLTextAreaElement;
    const hashes = container.querySelector(
      'textarea[name="connection-schema-hashes"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      setValue(label, "New server");
      setValue(endpoint, "https://new.example.test/rpc");
      setValue(allowlist, "catalog.search\njobs.list");
      setValue(hashes, JSON.stringify({ "catalog.search": HASH }));
    });
    await act(async () => {
      submitForm(container);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/studio/mcp-connections",
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      label: "New server",
      endpointUrl: "https://new.example.test/rpc",
      transport: "http",
      toolAllowlist: ["catalog.search", "jobs.list"],
      schemaHashes: { "catalog.search": HASH },
    });
    expect(container.textContent).toContain("Draft created.");
  });

  it("refuses an invalid schema-hash document without calling the API", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const container = await mount(snapshot());

    const label = container.querySelector(
      'input[name="connection-label"]',
    ) as HTMLInputElement;
    const allowlist = container.querySelector(
      'textarea[name="connection-allowlist"]',
    ) as HTMLTextAreaElement;
    const hashes = container.querySelector(
      'textarea[name="connection-schema-hashes"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      setValue(label, "New server");
      setValue(allowlist, "catalog.search");
      setValue(hashes, '{"catalog.search":"not-a-hash"}');
    });
    await act(async () => {
      submitForm(container);
      await Promise.resolve();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Schema hashes must be JSON mapping tool names to 64-character hex hashes.",
    );
  });

  it("stores a credential only after the explicit click and clears the field", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        connection({
          credentialPresent: true,
          generation: 2,
          status: "draft",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount(
      snapshot({
        items: [connection()],
        externalFlagOn: true,
        encryptionKeyPresent: true,
        approvable: true,
        probeAvailable: true,
      }),
    );
    const input = container.querySelector(
      'input[name="connection-credential-11111111-1111-4111-8111-111111111111"]',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    await act(async () => {
      setValue(input, "synthetic-bearer-secret");
    });
    expect(fetcher).not.toHaveBeenCalled();

    const save = findButton(container, "Save credential");
    await act(async () => {
      save!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/studio/mcp-connections/11111111-1111-4111-8111-111111111111/credential",
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      credential: "synthetic-bearer-secret",
    });
    expect(container.textContent).toContain("Credential stored");
    expect(input.value).toBe("");
    // The plaintext never appears in the rendered page.
    expect(container.textContent).not.toContain("synthetic-bearer-secret");
  });

  it("probes, shows unpinned advertised hashes and pins them explicitly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/probe")) {
        return Response.json({
          connectionId: "11111111-1111-4111-8111-111111111111",
          status: "ok",
          tools: [
            {
              name: "catalog.search",
              allowlisted: true,
              advertisedHash: HASH,
              pinnedHash: null,
              match: null,
            },
          ],
          missingPins: ["catalog.search"],
          drift: [],
          missingAllowlisted: [],
        });
      }
      return Response.json(
        connection({
          schemaHashes: { "catalog.search": HASH },
          generation: 2,
          status: "draft",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount(
      snapshot({
        items: [connection({ schemaHashes: {} })],
        externalFlagOn: true,
        encryptionKeyPresent: true,
        approvable: true,
        probeAvailable: true,
      }),
    );

    const probe = findButton(container, "Probe endpoint");
    expect(probe?.disabled).toBe(false);
    await act(async () => {
      probe!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/studio/mcp-connections/11111111-1111-4111-8111-111111111111/probe",
    );
    expect(container.textContent).toContain("Probe result");
    expect(container.textContent).toContain("Not pinned");
    expect(container.textContent).toContain("Pin advertised hashes");

    const pin = findButton(container, "Pin advertised hashes");
    await act(async () => {
      pin!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const pinCall = fetcher.mock.calls.find((call) =>
      String(call[0]).endsWith("/schemas"),
    );
    expect(pinCall?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(pinCall?.[1]?.body))).toEqual({
      schemaHashes: { "catalog.search": HASH },
    });
    expect(container.textContent).toContain("Advertised hashes pinned");
  });
});
