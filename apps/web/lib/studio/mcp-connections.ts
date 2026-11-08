import type { StudioMcpConnection } from "@wukong/db";
import { approvedEndpoint } from "@wukong/ai";
import { z } from "zod";

import { ApiError } from "../route-support";
import {
  hasStudioMcpEncryptionKey,
  STUDIO_MCP_ENCRYPTION_KEY_ENV,
} from "./mcp-credentials.js";
import {
  requireStudioSession,
  studioNotFound,
  type StudioSessionDeps,
} from "./session.js";

/**
 * External MCP connection registry (plan Task 13, spec §3.8).
 *
 * The registry is the reviewed place where an admin records an external
 * server, its allowlisted tools and the sha256 hashes of the schemas that were
 * pinned at activation. It is deliberately inert in v1:
 *
 *  - `STUDIO_EXTERNAL_MCP_ENABLED` must be exactly `"true"` AND the workspace
 *    Studio row must be enabled before a connection may be approved;
 *  - the credential-encryption key must be configured before approval;
 *  - every allowlisted tool must have a recorded schema hash;
 *  - nothing in this module performs a transport call. The outbound client
 *    (`@wukong/ai` `createMcpClient`) additionally takes a computed `enabled`
 *    gate and pins the schema hash again before every call.
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

export type McpConnectionView = {
  connectionId: string;
  label: string;
  endpointUrl: string;
  transport: "http" | "sse";
  status: "draft" | "approved" | "disabled";
  generation: number;
  toolAllowlist: string[];
  schemaHashes: Record<string, unknown>;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  };
}

export type McpConnectionServiceDeps = StudioSessionDeps & {
  now?: () => Date;
};

export function createMcpConnectionService(
  deps: McpConnectionServiceDeps,
) {
  const environment = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const database = () => deps.getDatabase();

  function validatedEndpoint(raw: string): string {
    const endpoint = approvedEndpoint(raw);
    if (!endpoint) {
      // http:, embedded credentials and malformed URLs all fail the same way.
      throw new ApiError(
        400,
        "invalid_endpoint",
        "An HTTPS endpoint without credentials is required.",
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

  return {
    async listConnections(): Promise<McpConnectionsSnapshot> {
      const { session, settings } = await requireStudioSession(deps, "admin");
      const rows = await database().forWorkspace(
        session.workspaceId,
        (repos) => repos.studio.mcpConnections.list(),
      );
      return snapshotFor(rows.map(connectionView), settings, environment());
    },

    async getConnection(connectionId: string): Promise<McpConnectionView> {
      const { session } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(connectionId).success) throw studioNotFound();
      const row = await database().forWorkspace(
        session.workspaceId,
        (repos) => repos.studio.mcpConnections.get(connectionId),
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
    async approveConnection(
      connectionId: string,
    ): Promise<McpConnectionView> {
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

    async disableConnection(
      connectionId: string,
    ): Promise<McpConnectionView> {
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
  };
}

export type McpConnectionService = ReturnType<
  typeof createMcpConnectionService
>;
