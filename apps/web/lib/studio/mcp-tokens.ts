import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import type { StudioApiToken } from "@wukong/db";
import { z } from "zod";

import { ApiError } from "../route-support";
import { requireStudioSession, type StudioSessionDeps } from "./session.js";

/**
 * Workspace-scoped hosted-MCP tokens (plan Task 12, spec §3.7).
 *
 * A token is `wuk_<prefix>.<secret>`: the prefix is an indexed, non-secret
 * lookup label, while only `sha256(secret)` is stored. The plaintext is
 * returned exactly once at creation and is never listed, logged or audited.
 * Creation and revocation are admin-only and audited; both run inside the
 * workspace session, so a token can only ever belong to the caller's own
 * workspace.
 */

export const MCP_TOKEN_SCOPES = ["read", "propose"] as const;
export type McpTokenScope = (typeof MCP_TOKEN_SCOPES)[number];

export const MCP_TOKEN_PLAINTEXT_PREFIX = "wuk_";
/** 9 random bytes -> 12 base64url chars. */
export const MCP_TOKEN_PREFIX_BYTES = 9;
/** 32 random bytes -> 43 base64url chars (256-bit secret). */
export const MCP_TOKEN_SECRET_BYTES = 32;

export const createMcpTokenBodySchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(MCP_TOKEN_SCOPES))
    .min(1)
    .max(MCP_TOKEN_SCOPES.length),
});
export type CreateMcpTokenBody = z.infer<typeof createMcpTokenBodySchema>;

const UUID = z.string().uuid();

export type McpTokenView = {
  tokenId: string;
  label: string;
  /** Non-secret lookup label only; the full token is never returned again. */
  prefix: string;
  scopes: string[];
  createdBy: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The one response that carries plaintext. Shown once, never persisted. */
export type CreateMcpTokenResult = McpTokenView & { token: string };

export type McpTokenServiceDeps = StudioSessionDeps & {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
};

export function hashMcpTokenSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function tokenView(row: StudioApiToken): McpTokenView {
  return {
    tokenId: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: [...row.scopes],
    createdBy: row.createdBy,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createMcpTokenService(deps: McpTokenServiceDeps) {
  const random = deps.randomBytes ?? nodeRandomBytes;
  const clock = (): Date => deps.now?.() ?? new Date();
  const database = () => deps.getDatabase();

  return {
    /** Admin-only list. Never returns a hash or plaintext. */
    async listTokens(): Promise<{ items: McpTokenView[] }> {
      const { session } = await requireStudioSession(deps, "admin");
      const rows = await database().forWorkspace(
        session.workspaceId,
        (repos) => repos.studio.apiTokens.list({ limit: 100 }),
      );
      return { items: rows.map(tokenView) };
    },

    /**
     * Create a token for the caller's workspace. The plaintext value exists
     * only in this response; storage keeps the prefix and the sha256 hash.
     */
    async createToken(body: CreateMcpTokenBody): Promise<CreateMcpTokenResult> {
      const { session } = await requireStudioSession(deps, "admin");
      const label = body.label.trim();
      const scopes = [...new Set(body.scopes)];
      if (scopes.length === 0) {
        throw new ApiError(400, "invalid_body", "Request body is invalid.");
      }
      const prefix = random(MCP_TOKEN_PREFIX_BYTES).toString("base64url");
      const secret = random(MCP_TOKEN_SECRET_BYTES).toString("base64url");
      const token = `${MCP_TOKEN_PLAINTEXT_PREFIX}${prefix}.${secret}`;
      const tokenHash = hashMcpTokenSecret(secret);
      const created = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const row = await repos.studio.apiTokens.create({
            label,
            tokenHash,
            prefix,
            scopes,
            createdBy: session.actorId,
          });
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.token.created",
            metadata: { tokenId: row.id, prefix, scopes },
          });
          return row;
        },
      );
      return { ...tokenView(created), token };
    },

    /** Revoke one token in the caller's workspace. Unknown/foreign is a 404. */
    async revokeToken(
      tokenId: string,
    ): Promise<{ tokenId: string; revokedAt: string }> {
      const { session } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(tokenId).success) {
        throw new ApiError(404, "not_found", "Not found.");
      }
      const revoked = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const applied = await repos.studio.apiTokens.revoke(tokenId);
          if (!applied) return false;
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: tokenId,
            action: "studio.mcp.token.revoked",
            metadata: { tokenId },
          });
          return true;
        },
      );
      if (!revoked) throw new ApiError(404, "not_found", "Not found.");
      return { tokenId, revokedAt: clock().toISOString() };
    },
  };
}

export type McpTokenService = ReturnType<typeof createMcpTokenService>;
