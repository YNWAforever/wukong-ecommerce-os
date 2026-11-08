import { describe, expect, it } from "vitest";

import type { StudioMcpConnection } from "@wukong/db";

import { isStudioEnabled } from "../studio-flags";
import {
  createMcpConnectionBodySchema,
  createMcpConnectionService,
  externalMcpEnabled,
  externalMcpTransportAllowed,
  updateMcpConnectionBodySchema,
  type McpConnectionServiceDeps,
} from "./mcp-connections.js";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "./test-fakes.js";

/**
 * External MCP registry tests (plan Task 13).
 *
 * Fakes only: no transport is created here, and every disabled path asserts
 * that no approval/transport gate can open. Endpoint URLs and credentials are
 * synthetic.
 */

const WORKSPACE = "ws_test";
const KEY = Buffer.alloc(32, 0x01).toString("base64");
const HASH = "a".repeat(64);
const ENDPOINT = "https://mcp.example.test/rpc";
const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
  STUDIO_MCP_SERVER_ENABLED: "true",
  STUDIO_EXTERNAL_MCP_ENABLED: "true",
  STUDIO_MCP_ENCRYPTION_KEY: KEY,
} as unknown as NodeJS.ProcessEnv;

type Role = "viewer" | "operator" | "reviewer" | "admin" | "owner";

function fakeConnection(
  overrides: Partial<StudioMcpConnection> = {},
): StudioMcpConnection {
  const createdAt = new Date("2026-11-08T10:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: WORKSPACE,
    label: "External catalogue",
    endpointUrl: ENDPOINT,
    transport: "http",
    status: "draft",
    generation: 1,
    toolAllowlist: ["catalog.search"],
    schemaHashes: { "catalog.search": HASH },
    credentialEnvelope: "v1.iv.ciphertext",
    createdBy: "actor_ops",
    approvedBy: null,
    approvedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function fixture(input: {
  role?: Role;
  env?: NodeJS.ProcessEnv;
  options?: FakeStudioOptions;
} = {}) {
  const options = input.options ?? {};
  const fake = createFakeStudio({
    ...options,
    settings: {
      workspaceId: WORKSPACE,
      enabled: true,
      ...(options.settings ?? {}),
    },
  });
  const session = fakeSessionContext(input.role ?? "admin", {
    workspaceId: WORKSPACE,
  });
  const deps: McpConnectionServiceDeps = {
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    isStudioEnabled,
    env: input.env ?? ON_ENV,
  };
  return { service: createMcpConnectionService(deps), fake };
}

const createBody = {
  label: "External catalogue",
  endpointUrl: ENDPOINT,
  transport: "http" as const,
  toolAllowlist: ["catalog.search"],
  schemaHashes: { "catalog.search": HASH },
};

describe("external MCP request schemas", () => {
  it("validates the draft body and the status patch", () => {
    expect(createMcpConnectionBodySchema.safeParse(createBody).success).toBe(
      true,
    );
    expect(
      createMcpConnectionBodySchema.safeParse({
        ...createBody,
        toolAllowlist: [],
      }).success,
    ).toBe(false);
    expect(
      createMcpConnectionBodySchema.safeParse({
        ...createBody,
        schemaHashes: { "catalog.search": "not-a-hash" },
      }).success,
    ).toBe(false);
    expect(
      createMcpConnectionBodySchema.safeParse({
        ...createBody,
        extra: true,
      }).success,
    ).toBe(false);
    expect(updateMcpConnectionBodySchema.safeParse({ status: "approved" }).success).toBe(true);
    expect(updateMcpConnectionBodySchema.safeParse({ status: "draft" }).success).toBe(false);
  });

  it("keeps the deployment gates fail-closed", () => {
    const enabled = {
      CONVERSATION_STUDIO_ENABLED: "true",
      STUDIO_EXTERNAL_MCP_ENABLED: "true",
      STUDIO_MCP_ENCRYPTION_KEY: KEY,
    } as unknown as NodeJS.ProcessEnv;
    expect(externalMcpEnabled(enabled, { enabled: true })).toBe(true);
    expect(
      externalMcpEnabled({} as unknown as NodeJS.ProcessEnv, { enabled: true }),
    ).toBe(false);
    expect(externalMcpEnabled(enabled, { enabled: false })).toBe(false);
    expect(
      externalMcpEnabled(
        { ...enabled, STUDIO_EXTERNAL_MCP_ENABLED: "TRUE" } as NodeJS.ProcessEnv,
        { enabled: true },
      ),
    ).toBe(false);
    expect(externalMcpTransportAllowed({
      env: enabled,
      settings: { enabled: true },
      status: "approved",
    })).toBe(true);
    expect(externalMcpTransportAllowed({
      env: enabled,
      settings: { enabled: true },
      status: "draft",
    })).toBe(false);
    expect(externalMcpTransportAllowed({
      env: enabled,
      settings: { enabled: true },
      status: "disabled",
    })).toBe(false);
    expect(externalMcpTransportAllowed({
      env: { ...enabled, STUDIO_MCP_ENCRYPTION_KEY: "" } as NodeJS.ProcessEnv,
      settings: { enabled: true },
      status: "approved",
    })).toBe(false);
  });
});

describe("external MCP connection service", () => {
  it("creates a draft without a credential envelope and audits it", async () => {
    const { service, fake } = fixture();
    const created = await service.createDraftConnection(createBody);
    expect(created).toMatchObject({
      label: "External catalogue",
      endpointUrl: ENDPOINT,
      transport: "http",
      status: "draft",
      toolAllowlist: ["catalog.search"],
      schemaHashes: { "catalog.search": HASH },
    });
    expect(JSON.stringify(created)).not.toContain("credentialEnvelope");
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.created",
    ]);
    // The endpoint may carry a query string; none of it reaches the audit row.
    expect(JSON.stringify(fake.state.audits)).not.toContain(ENDPOINT);
  });

  it("rejects non-https endpoints, embedded credentials and foreign schema keys", async () => {
    const { service, fake } = fixture();
    for (const endpointUrl of [
      "http://mcp.example.test/rpc",
      "https://user:pass@mcp.example.test/rpc",
      "not a url",
    ]) {
      await expect(
        service.createDraftConnection({ ...createBody, endpointUrl }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_endpoint" });
    }
    await expect(
      service.createDraftConnection({
        ...createBody,
        schemaHashes: { "other.tool": HASH },
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_schema_hashes" });
    expect(fake.state.audits).toEqual([]);
  });

  it("lists snapshots for an admin and never returns credential envelopes", async () => {
    const { service } = fixture({
      options: { mcpConnections: [fakeConnection()] },
    });
    const snapshot = await service.listConnections();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot).toMatchObject({
      externalFlagOn: true,
      workspaceEnabled: true,
      encryptionKeyPresent: true,
      approvable: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("credentialEnvelope");
    expect(JSON.stringify(snapshot)).not.toContain("v1.iv.ciphertext");
  });

  it("approves only with the flag, workspace, key and schema hashes present", async () => {
    const connection = fakeConnection();
    const { service, fake } = fixture({
      options: { mcpConnections: [connection] },
    });
    const approved = await service.approveConnection(connection.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("actor_ops");
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.approved",
    ]);

    const flagOff = fixture({
      env: { ...ON_ENV, STUDIO_EXTERNAL_MCP_ENABLED: "" } as NodeJS.ProcessEnv,
      options: { mcpConnections: [fakeConnection({ id: "22222222-2222-4222-8222-222222222222" })] },
    });
    await expect(
      flagOff.service.approveConnection(
        "22222222-2222-4222-8222-222222222222",
      ),
    ).rejects.toMatchObject({ status: 409, code: "external_mcp_disabled" });

    const workspaceOff = fixture({
      options: {
        settings: { enabled: false },
        mcpConnections: [fakeConnection({ id: "33333333-3333-4333-8333-333333333333" })],
      },
    });
    // A disabled Studio workspace never reaches the approve path at all: the
    // shared session gate answers 404 before any connection read.
    await expect(
      workspaceOff.service.approveConnection(
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const noKey = fixture({
      env: { ...ON_ENV, STUDIO_MCP_ENCRYPTION_KEY: "" } as NodeJS.ProcessEnv,
      options: { mcpConnections: [fakeConnection({ id: "44444444-4444-4444-8444-444444444444" })] },
    });
    await expect(
      noKey.service.approveConnection("44444444-4444-4444-8444-444444444444"),
    ).rejects.toMatchObject({
      status: 409,
      code: "mcp_encryption_unavailable",
    });

    const noHash = fixture({
      options: {
        mcpConnections: [
          fakeConnection({
            id: "55555555-5555-4555-8555-555555555555",
            schemaHashes: {},
          }),
        ],
      },
    });
    await expect(
      noHash.service.approveConnection("55555555-5555-4555-8555-555555555555"),
    ).rejects.toMatchObject({ status: 400, code: "schema_hash_required" });
  });

  it("disables a connection and audits it; unknown ids are 404", async () => {
    const connection = fakeConnection({ status: "approved" });
    const { service, fake } = fixture({
      options: { mcpConnections: [connection] },
    });
    const disabled = await service.disableConnection(connection.id);
    expect(disabled.status).toBe("disabled");
    expect(fake.state.audits.map((event) => event.action)).toEqual([
      "studio.mcp.connection.disabled",
    ]);

    await expect(
      service.disableConnection("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(service.disableConnection("not-a-uuid")).rejects.toMatchObject(
      { status: 404, code: "not_found" },
    );
  });

  it("requires admin for every connection operation", async () => {
    for (const role of ["viewer", "operator", "reviewer"] as const) {
      const { service } = fixture({ role });
      await expect(
        service.createDraftConnection(createBody),
      ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
      await expect(service.listConnections()).rejects.toMatchObject({
        status: 403,
        code: "insufficient_role",
      });
    }
  });
});
