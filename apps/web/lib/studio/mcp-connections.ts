import type { StudioMcpCallStatus, StudioMcpConnection } from "@wukong/db";
import {
  approvedEndpoint,
  createMcpClient,
  schemaHash,
  type ExternalMcpTool,
  type McpClient,
  type McpClientDeps,
  type McpClientStatus,
  type McpToolListResult,
} from "@wukong/ai";
import { z } from "zod";

import { ApiError } from "../route-support";
import {
  decryptStudioMcpCredential,
  encryptStudioMcpCredential,
  hasStudioMcpEncryptionKey,
  readStudioMcpEncryptionKey,
  STUDIO_MCP_ENCRYPTION_KEY_ENV,
} from "./mcp-credentials";
import {
  requireStudioSession,
  studioNotFound,
  type StudioSessionDeps,
} from "./session";

/**
 * External MCP connection registry and admin workflow (plan Task 13, spec
 * §3.8).
 *
 * The registry is the reviewed place where an admin records an external
 * server, its allowlisted tools and the sha256 hashes of the schemas that were
 * pinned at activation. It is disabled by default:
 *
 *  - `STUDIO_EXTERNAL_MCP_ENABLED` must be exactly `"true"` AND the workspace
 *    Studio row must be enabled before a connection may be approved;
 *  - the credential-encryption key must be configured before approval;
 *  - every allowlisted tool must have a recorded schema hash;
 *  - the only transport call is the explicit admin probe (`initialize` +
 *    `tools/list`), which requires flag + workspace + key but not approval.
 *    The outbound client (`@wukong/ai` `createMcpClient`) additionally takes a
 *    computed `enabled` gate and pins the schema hash again before every tool
 *    call, so an approved connection is still dormant without a reviewed call
 *    site.
 *
 * No method returns the credential envelope, and no audit/log line carries the
 * endpoint (which may hold a query string) or a credential.
 */

export const EXTERNAL_MCP_FLAG = "STUDIO_EXTERNAL_MCP_ENABLED";

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = z.string().uuid();

export const createMcpConnectionBodySchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  endpointUrl: z.string().trim().min(1).max(2000),
  transport: z.enum(["http", "sse"]).optional(),
  toolAllowlist: z.array(z.string().regex(TOOL_NAME)).min(1).max(20),
  schemaHashes: z
    .record(z.string().regex(TOOL_NAME), z.string().regex(SHA256_HEX))
    .optional(),
});
export type CreateMcpConnectionBody = z.infer<
  typeof createMcpConnectionBodySchema
>;

export const updateMcpConnectionBodySchema = z.strictObject({
  status: z.enum(["approved", "disabled"]),
});
export type UpdateMcpConnectionBody = z.infer<
  typeof updateMcpConnectionBodySchema
>;

/**
 * Set (or rotate) the workspace-owned bearer credential.
 *
 * The plaintext exists only inside this request and the encryption helper; it
 * is never returned, audited, logged or stored. An empty credential is a 400 —
 * clearing is a separate explicit action.
 */
export const setMcpCredentialBodySchema = z.strictObject({
  credential: z.string().min(1).max(4096),
});
export type SetMcpCredentialBody = z.infer<typeof setMcpCredentialBodySchema>;

/** Pin (or re-pin) the advertised input-schema hashes for allowlisted tools. */
export const pinMcpSchemaHashesBodySchema = z.strictObject({
  schemaHashes: z.record(
    z.string().regex(TOOL_NAME),
    z.string().regex(SHA256_HEX),
  ),
});
export type PinMcpSchemaHashesBody = z.infer<
  typeof pinMcpSchemaHashesBodySchema
>;

export type McpConnectionView = {
  connectionId: string;
  label: string;
  endpointUrl: string;
  transport: "http" | "sse";
  status: "draft" | "approved" | "disabled";
  generation: number;
  toolAllowlist: string[];
  schemaHashes: Record<string, unknown>;
  /** True when an encrypted credential envelope is stored (never the value). */
  credentialPresent: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One tool advertised by the endpoint, compared with the pinned snapshot. */
export type McpProbeTool = {
  name: string;
  allowlisted: boolean;
  /** sha256 of the live advertised input schema (computed by the client). */
  advertisedHash: string;
  pinnedHash: string | null;
  /** `null` means "not pinned yet"; otherwise advertised vs pinned equality. */
  match: boolean | null;
};

/**
 * Outcome of an explicit admin probe (`initialize` + `tools/list` only).
 *
 * `tools/list` is a read; this probe never calls a tool. Status is `ok` when
 * every allowlisted tool is advertised with a matching pinned hash, otherwise
 * `denied` (a tool is missing), `schema_drift` (a hash changed) or the client's
 * transport status. Unpinned tools are reported in `missingPins` so the admin
 * can pin exactly what the endpoint advertised.
 */
export type McpProbeResult = {
  connectionId: string;
  status: McpClientStatus;
  tools: McpProbeTool[];
  missingPins: string[];
  drift: string[];
  missingAllowlisted: string[];
};

export type McpConnectionsSnapshot = {
  items: McpConnectionView[];
  /** `STUDIO_EXTERNAL_MCP_ENABLED === "true"` (global rollback switch). */
  externalFlagOn: boolean;
  /** Workspace Studio row. */
  workspaceEnabled: boolean;
  /** `STUDIO_MCP_ENCRYPTION_KEY` present and well-formed. */
  encryptionKeyPresent: boolean;
  /** Approval is possible only when all three gates are true. */
  approvable: boolean;
  /** Probing (admin diagnostic) shares the same three deployment gates. */
  probeAvailable: boolean;
};

/**
 * The two deployment/workspace gates. A connection may only be approved (and
 * a future transport call may only run) when both are true.
 */
export function externalMcpEnabled(
  env: NodeJS.ProcessEnv,
  settings: { enabled: boolean } | null,
): boolean {
  return env[EXTERNAL_MCP_FLAG] === "true" && settings?.enabled === true;
}

/**
 * Full transport gate: flag + workspace + key + an approved connection. The
 * shipped state is false for every one of those, so no code path reaches the
 * external client by default.
 */
export function externalMcpTransportAllowed(input: {
  env: NodeJS.ProcessEnv;
  settings: { enabled: boolean } | null;
  status: StudioMcpConnection["status"];
}): boolean {
  return (
    externalMcpEnabled(input.env, input.settings) &&
    hasStudioMcpEncryptionKey(input.env) &&
    input.status === "approved"
  );
}

/**
 * Probe gate: flag + workspace + encryption key. Deliberately weaker than
 * `externalMcpTransportAllowed`: a draft may be probed so the admin can pin the
 * advertised schemas *before* approval. A disabled connection is never probed.
 * The shipped state is false on all three gates, so nothing calls out.
 */
export function externalMcpProbeAllowed(input: {
  env: NodeJS.ProcessEnv;
  settings: { enabled: boolean } | null;
  status: StudioMcpConnection["status"];
}): boolean {
  return (
    externalMcpEnabled(input.env, input.settings) &&
    hasStudioMcpEncryptionKey(input.env) &&
    input.status !== "disabled"
  );
}

function connectionView(row: StudioMcpConnection): McpConnectionView {
  return {
    connectionId: row.id,
    label: row.label,
    endpointUrl: row.endpointUrl,
    transport: row.transport,
    status: row.status,
    generation: row.generation,
    toolAllowlist: [...row.toolAllowlist],
    schemaHashes: { ...row.schemaHashes },
    credentialPresent: row.credentialEnvelope !== null,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshotFor(
  items: McpConnectionView[],
  settings: { enabled: boolean },
  env: NodeJS.ProcessEnv,
): McpConnectionsSnapshot {
  const externalFlagOn = env[EXTERNAL_MCP_FLAG] === "true";
  const workspaceEnabled = settings.enabled === true;
  const encryptionKeyPresent = hasStudioMcpEncryptionKey(env);
  return {
    items,
    externalFlagOn,
    workspaceEnabled,
    encryptionKeyPresent,
    approvable: externalFlagOn && workspaceEnabled && encryptionKeyPresent,
    probeAvailable: externalFlagOn && workspaceEnabled && encryptionKeyPresent,
  };
}

/** The MCP client's `timeout` is recorded as `unavailable` in the ledger. */
function ledgerStatus(status: McpClientStatus): StudioMcpCallStatus {
  return status === "timeout" ? "unavailable" : status;
}

/** Compare the live advertised tools with the pinned snapshot. */
function probeResult(
  row: StudioMcpConnection,
  advertised: readonly ExternalMcpTool[],
  pinned: Record<string, unknown>,
): McpProbeResult {
  const advertisedByName = new Map(
    advertised.map((tool) => [tool.name, tool] as const),
  );
  const tools: McpProbeTool[] = advertised.map((tool) => {
    const raw = pinned[tool.name];
    const pinnedHash = typeof raw === "string" ? raw : null;
    return {
      name: tool.name,
      allowlisted: row.toolAllowlist.includes(tool.name),
      advertisedHash: tool.schemaHash,
      pinnedHash,
      match: pinnedHash === null ? null : pinnedHash === tool.schemaHash,
    };
  });
  const missingPins = row.toolAllowlist.filter(
    (tool) => typeof pinned[tool] !== "string",
  );
  const drift = tools
    .filter((tool) => tool.match === false)
    .map((tool) => tool.name);
  const missingAllowlisted = row.toolAllowlist.filter(
    (tool) => !advertisedByName.has(tool),
  );
  const status: McpClientStatus =
    missingAllowlisted.length > 0
      ? "denied"
      : drift.length > 0
        ? "schema_drift"
        : "ok";
  return {
    connectionId: row.id,
    status,
    tools,
    missingPins,
    drift,
    missingAllowlisted,
  };
}

export type McpConnectionServiceDeps = StudioSessionDeps & {
  now?: () => Date;
  /** Injected for tests; production uses the reviewed `@wukong/ai` client. */
  createClient?: (input: McpClientDeps) => McpClient;
};

export function createMcpConnectionService(deps: McpConnectionServiceDeps) {
  const environment = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const database = () => deps.getDatabase();

  function validatedEndpoint(raw: string): string {
    const endpoint = approvedEndpoint(raw);
    if (!endpoint) {
      // http:, embedded credentials, malformed URLs and non-public hosts all
      // fail the same way.
      throw new ApiError(
        400,
        "invalid_endpoint",
        "An HTTPS endpoint on a public host, without credentials, is required.",
      );
    }
    return endpoint.href;
  }

  function validatedHashes(
    hashes: Record<string, string> | undefined,
    allowlist: readonly string[],
  ): Record<string, string> {
    if (!hashes) return {};
    const allowed = new Set(allowlist);
    const result: Record<string, string> = {};
    for (const [tool, hash] of Object.entries(hashes)) {
      if (!allowed.has(tool)) {
        throw new ApiError(
          400,
          "invalid_schema_hashes",
          "Schema hashes must belong to allowlisted tools.",
        );
      }
      result[tool] = hash;
    }
    return result;
  }

  /**
   * The shared admin + deployment gate for credential, pinning and probe
   * actions. Every one of these is unreachable while external MCP is disabled,
   * the workspace Studio row is off or the encryption key is absent.
   */
  async function requireExternalAdmin() {
    const { session, settings } = await requireStudioSession(deps, "admin");
    const env = environment();
    if (!externalMcpEnabled(env, settings)) {
      throw new ApiError(
        409,
        "external_mcp_disabled",
        "External MCP is disabled.",
      );
    }
    const key = readStudioMcpEncryptionKey(env);
    if (!key) {
      throw new ApiError(
        409,
        "mcp_encryption_unavailable",
        `External MCP requires ${STUDIO_MCP_ENCRYPTION_KEY_ENV}.`,
      );
    }
    return { session, key };
  }

  return {
    async listConnections(): Promise<McpConnectionsSnapshot> {
      const { session, settings } = await requireStudioSession(deps, "admin");
      const rows = await database().forWorkspace(session.workspaceId, (repos) =>
        repos.studio.mcpConnections.list(),
      );
      return snapshotFor(rows.map(connectionView), settings, environment());
    },

    async getConnection(connectionId: string): Promise<McpConnectionView> {
      const { session } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const row = await database().forWorkspace(session.workspaceId, (repos) =>
        repos.studio.mcpConnections.get(connectionId),
      );
      if (!row) throw studioNotFound();
      return connectionView(row);
    },

    /** Create a draft. A draft is never contacted, approved or enabled. */
    async createDraftConnection(
      body: CreateMcpConnectionBody,
    ): Promise<McpConnectionView> {
      const { session } = await requireStudioSession(deps, "admin");
      const endpointUrl = validatedEndpoint(body.endpointUrl);
      const allowlist = [...new Set(body.toolAllowlist)];
      if (allowlist.length === 0) {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const schemaHashes = validatedHashes(body.schemaHashes, allowlist);
      const created = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const row = await repos.studio.mcpConnections.create({
            label: body.label.trim(),
            endpointUrl,
            transport: body.transport ?? "http",
            toolAllowlist: allowlist,
            schemaHashes,
            credentialEnvelope: null,
            createdBy: session.actorId,
          });
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.connection.created",
            metadata: {
              connectionId: row.id,
              transport: row.transport,
              toolCount: allowlist.length,
            },
          });
          return row;
        },
      );
      return connectionView(created);
    },

    /**
     * Approve a draft after explicit admin action. Fails closed while the
     * global flag, the workspace row or the encryption key is missing, and
     * refuses a connection without a pinned schema hash for every tool.
     */
    async approveConnection(connectionId: string): Promise<McpConnectionView> {
      const { session, settings } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const env = environment();
      if (!externalMcpEnabled(env, settings)) {
        throw new ApiError(
          409,
          "external_mcp_disabled",
          "External MCP is disabled.",
        );
      }
      if (!hasStudioMcpEncryptionKey(env)) {
        throw new ApiError(
          409,
          "mcp_encryption_unavailable",
          `External MCP requires ${STUDIO_MCP_ENCRYPTION_KEY_ENV}.`,
        );
      }
      const approved = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const existing = await repos.studio.mcpConnections.get(connectionId);
          if (!existing) return null;
          const hashes = existing.schemaHashes;
          const complete = existing.toolAllowlist.every(
            (tool) => typeof hashes[tool] === "string",
          );
          if (!complete || existing.toolAllowlist.length === 0) {
            throw new ApiError(
              400,
              "schema_hash_required",
              "Every allowlisted tool needs a pinned schema hash.",
            );
          }
          const row = await repos.studio.mcpConnections.updateStatus(
            connectionId,
            "approved",
            session.actorId,
          );
          if (!row) return null;
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.connection.approved",
            metadata: {
              connectionId: row.id,
              toolCount: row.toolAllowlist.length,
              generation: row.generation,
            },
          });
          return row;
        },
      );
      if (!approved) throw studioNotFound();
      return connectionView(approved);
    },

    async disableConnection(connectionId: string): Promise<McpConnectionView> {
      const { session } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const disabled = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const row = await repos.studio.mcpConnections.updateStatus(
            connectionId,
            "disabled",
            null,
          );
          if (!row) return null;
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.connection.disabled",
            metadata: { connectionId: row.id, generation: row.generation },
          });
          return row;
        },
      );
      if (!disabled) throw studioNotFound();
      return connectionView(disabled);
    },

    /** PATCH dispatcher used by the route. */
    async updateConnectionStatus(
      connectionId: string,
      body: UpdateMcpConnectionBody,
    ): Promise<McpConnectionView> {
      return body.status === "approved"
        ? this.approveConnection(connectionId)
        : this.disableConnection(connectionId);
    },

    /**
     * Store (or rotate) the workspace-owned credential as an opaque envelope.
     *
     * Plaintext never leaves this call; the view only says whether one exists.
     * A rotation bumps the generation and an approved connection returns to
     * `draft` so the approval decision is repeated for the new generation.
     */
    async setCredential(
      connectionId: string,
      body: SetMcpCredentialBody,
    ): Promise<McpConnectionView> {
      const { session, key } = await requireExternalAdmin();
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const envelope = await encryptStudioMcpCredential(body.credential, key);
      const updated = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const existing = await repos.studio.mcpConnections.get(connectionId);
          if (!existing) return null;
          const row = await repos.studio.mcpConnections.updateCredential(
            connectionId,
            envelope,
          );
          if (!row) return null;
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.connection.credential_set",
            metadata: { connectionId: row.id, generation: row.generation },
          });
          return row;
        },
      );
      if (!updated) throw studioNotFound();
      return connectionView(updated);
    },

    /** Remove the stored credential; no plaintext or envelope is returned. */
    async clearCredential(connectionId: string): Promise<McpConnectionView> {
      const { session } = await requireExternalAdmin();
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const updated = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const existing = await repos.studio.mcpConnections.get(connectionId);
          if (!existing) return null;
          const row = await repos.studio.mcpConnections.updateCredential(
            connectionId,
            null,
          );
          if (!row) return null;
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.connection.credential_cleared",
            metadata: { connectionId: row.id, generation: row.generation },
          });
          return row;
        },
      );
      if (!updated) throw studioNotFound();
      return connectionView(updated);
    },

    /**
     * Pin the advertised schema hashes collected by an admin probe.
     *
     * Only allowlisted tools may be pinned. Pinning is a generation change and
     * an approved connection returns to `draft`, exactly like a credential
     * rotation.
     */
    async pinSchemaHashes(
      connectionId: string,
      body: PinMcpSchemaHashesBody,
    ): Promise<McpConnectionView> {
      const { session } = await requireExternalAdmin();
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const updated = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const existing = await repos.studio.mcpConnections.get(connectionId);
          if (!existing) return null;
          const hashes = validatedHashes(
            body.schemaHashes,
            existing.toolAllowlist,
          );
          const row = await repos.studio.mcpConnections.updateSchemaHashes(
            connectionId,
            hashes,
          );
          if (!row) return null;
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.connection.schemas_pinned",
            metadata: {
              connectionId: row.id,
              toolCount: Object.keys(hashes).length,
              generation: row.generation,
            },
          });
          return row;
        },
      );
      if (!updated) throw studioNotFound();
      return connectionView(updated);
    },

    /**
     * Explicit admin probe: call `initialize` + `tools/list` only.
     *
     * A draft may be probed so the admin can collect and pin the advertised
     * schema hashes before approving; a disabled connection never is. This is
     * the only outbound call in the module and it is unreachable while the
     * global flag, workspace row or encryption key is missing. The ledger
     * records digests, status and latency only; no endpoint, credential or
     * payload is written.
     */
    async probeConnection(connectionId: string): Promise<McpProbeResult> {
      const { session } = await requireExternalAdmin();
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const key = readStudioMcpEncryptionKey(environment());
      if (!key) {
        throw new ApiError(
          409,
          "mcp_encryption_unavailable",
          `External MCP requires ${STUDIO_MCP_ENCRYPTION_KEY_ENV}.`,
        );
      }
      const row = await database().forWorkspace(session.workspaceId, (repos) =>
        repos.studio.mcpConnections.get(connectionId),
      );
      if (!row) throw studioNotFound();
      if (row.status === "disabled") {
        throw new ApiError(
          409,
          "connection_disabled",
          "This connection is disabled.",
        );
      }
      let credential: string | null = null;
      if (row.credentialEnvelope) {
        try {
          credential = await decryptStudioMcpCredential(
            row.credentialEnvelope,
            key,
          );
        } catch {
          throw new ApiError(
            409,
            "mcp_credential_unreadable",
            "The stored credential could not be decrypted.",
          );
        }
      }
      const clock = deps.now ?? (() => new Date());
      const startedAt = clock();
      const client = (deps.createClient ?? createMcpClient)({
        endpointUrl: row.endpointUrl,
        toolAllowlist: row.toolAllowlist,
        schemaHashes: row.schemaHashes as Record<string, string>,
        credential,
        enabled: true,
      });
      let listed: McpToolListResult;
      try {
        listed = await client.listTools();
      } catch {
        listed = { status: "unavailable" };
      }
      const latencyMs = Math.max(0, clock().getTime() - startedAt.getTime());
      const pinned = row.schemaHashes;
      const result: McpProbeResult =
        listed.status === "ok"
          ? probeResult(row, listed.tools, pinned)
          : {
              connectionId: row.id,
              status: listed.status,
              tools: [],
              missingPins: [],
              drift: [],
              missingAllowlisted: [],
            };
      await database().forWorkspace(session.workspaceId, async (repos) => {
        await repos.studio.mcpCalls.append({
          connectionId: row.id,
          toolName: "tools/list",
          requestDigest: schemaHash({
            method: "tools/list",
            connectionId: row.id,
          }),
          responseDigest:
            listed.status === "ok"
              ? schemaHash(
                  listed.tools.map((tool) => ({
                    name: tool.name,
                    schemaHash: tool.schemaHash,
                  })),
                )
              : null,
          status:
            listed.status === "ok"
              ? ledgerStatus(result.status)
              : ledgerStatus(listed.status),
          errorCode: listed.status === "ok" ? null : listed.status,
          latencyMs,
          caller: "external_mcp",
        });
        await repos.audit.write({
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          entityId: row.id,
          action: "studio.mcp.connection.probed",
          metadata: {
            connectionId: row.id,
            generation: row.generation,
            outcome: result.status,
            toolCount: result.tools.length,
            driftCount: result.drift.length,
            missingPinCount: result.missingPins.length,
          },
        });
      });
      return result;
    },
  };
}

export type McpConnectionService = ReturnType<
  typeof createMcpConnectionService
>;
