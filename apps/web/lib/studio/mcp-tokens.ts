import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import type { StudioApiToken } from "@wukong/db";
import { z } from "zod";

import { ApiError } from "../route-support";
import { requireStudioSession, type StudioSessionDeps } from "./session";

/**
 * Workspace-scoped hosted-MCP tokens (plan Task 12, spec §3.7; B4 hardening).
 *
 * A token is `wuk_<prefix>.<secret>`: the prefix is an indexed, non-secret
 * lookup label, while only `sha256(secret)` is stored. The plaintext is
 * returned exactly once at creation (or rotation) and is never listed, logged
 * or audited. Creation, quota updates, rotation and revocation are admin-only
 * and audited; all run inside the workspace session, so a token can only ever
 * belong to the caller's own workspace.
 *
 * Quotas are optional per token: `rateLimitPerMinute` is a rolling 60-second
 * window and `monthlyCallQuota` is a UTC calendar month. Both are nullable and
 * NULL means unlimited. The transport enforces them; this service only stores,
 * validates and reads them back, together with the per-token usage counts.
 */

export const MCP_TOKEN_SCOPES = ["read", "propose"] as const;
export type McpTokenScope = (typeof MCP_TOKEN_SCOPES)[number];

export const MCP_TOKEN_PLAINTEXT_PREFIX = "wuk_";
/** 9 random bytes -> 12 base64url chars. */
export const MCP_TOKEN_PREFIX_BYTES = 9;
/** 32 random bytes -> 43 base64url chars (256-bit secret). */
export const MCP_TOKEN_SECRET_BYTES = 32;

/** Bounds shared with migration 0057's CHECK constraints. */
export const MCP_TOKEN_RATE_LIMIT_MIN = 1;
export const MCP_TOKEN_RATE_LIMIT_MAX = 600;
export const MCP_TOKEN_MONTHLY_QUOTA_MIN = 1;
export const MCP_TOKEN_MONTHLY_QUOTA_MAX = 1_000_000;

const rateLimitSchema = z
  .number()
  .int()
  .min(MCP_TOKEN_RATE_LIMIT_MIN)
  .max(MCP_TOKEN_RATE_LIMIT_MAX)
  .nullable();
const monthlyQuotaSchema = z
  .number()
  .int()
  .min(MCP_TOKEN_MONTHLY_QUOTA_MIN)
  .max(MCP_TOKEN_MONTHLY_QUOTA_MAX)
  .nullable();

export const createMcpTokenBodySchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(MCP_TOKEN_SCOPES)).min(1).max(MCP_TOKEN_SCOPES.length),
  rateLimitPerMinute: rateLimitSchema.optional(),
  monthlyCallQuota: monthlyQuotaSchema.optional(),
});
export type CreateMcpTokenBody = z.infer<typeof createMcpTokenBodySchema>;

/** Both keys are required: `null` explicitly clears a limit to unlimited. */
export const updateMcpTokenLimitsBodySchema = z.strictObject({
  rateLimitPerMinute: rateLimitSchema,
  monthlyCallQuota: monthlyQuotaSchema,
});
export type UpdateMcpTokenLimitsBody = z.infer<
  typeof updateMcpTokenLimitsBodySchema
>;

const UUID = z.string().uuid();

/** Per-token usage computed from the append-only MCP call ledger. */
export type McpTokenUsage = {
  /** Calls at or after (now - 60s), matching the rolling-minute limit. */
  minuteCalls: number;
  /** Calls at or after the start of the current UTC month. */
  monthCalls: number;
};

export type McpTokenView = {
  tokenId: string;
  label: string;
  /** Non-secret lookup label only; the full token is never returned again. */
  prefix: string;
  scopes: string[];
  createdBy: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Rolling-minute call limit; null means unlimited. */
  rateLimitPerMinute: number | null;
  /** UTC-month call quota; null means unlimited. */
  monthlyCallQuota: number | null;
  usage: McpTokenUsage;
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

/** Start of the current UTC month, for the monthly quota window. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the rolling 60-second window. */
export function rollingMinuteStart(now: Date): Date {
  return new Date(now.getTime() - 60_000);
}

function tokenView(
  row: StudioApiToken,
  usage: McpTokenUsage = { minuteCalls: 0, monthCalls: 0 },
): McpTokenView {
  return {
    tokenId: row.id,
    label: row.label,
    prefix: row.prefix,
    scopes: [...row.scopes],
    createdBy: row.createdBy,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    rateLimitPerMinute: row.rateLimitPerMinute,
    monthlyCallQuota: row.monthlyCallQuota,
    usage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createMcpTokenService(deps: McpTokenServiceDeps) {
  const random = deps.randomBytes ?? nodeRandomBytes;
  const clock = (): Date => deps.now?.() ?? new Date();
  const database = () => deps.getDatabase();

  async function usageFor(tokenId: string): Promise<McpTokenUsage> {
    const now = clock();
    return database().forWorkspace(
      (await requireStudioSession(deps, "admin")).session.workspaceId,
      async (repos) => ({
        minuteCalls: await repos.studio.mcpCalls.countForTokenSince(
          tokenId,
          rollingMinuteStart(now),
        ),
        monthCalls: await repos.studio.mcpCalls.countForTokenSince(
          tokenId,
          utcMonthStart(now),
        ),
      }),
    );
  }

  return {
    /** Admin-only list. Never returns a hash or plaintext. */
    async listTokens(): Promise<{ items: McpTokenView[] }> {
      const { session } = await requireStudioSession(deps, "admin");
      const now = clock();
      const listed = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const rows = await repos.studio.apiTokens.list({ limit: 100 });
          const usages = await Promise.all(
            rows.map(async (row) => ({
              minuteCalls: await repos.studio.mcpCalls.countForTokenSince(
                row.id,
                rollingMinuteStart(now),
              ),
              monthCalls: await repos.studio.mcpCalls.countForTokenSince(
                row.id,
                utcMonthStart(now),
              ),
            })),
          );
          return rows.map((row, index) => ({
            row,
            usage: usages[index] ?? { minuteCalls: 0, monthCalls: 0 },
          }));
        },
      );
      return {
        items: listed.map(({ row, usage }) => tokenView(row, usage)),
      };
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
      const rateLimitPerMinute = body.rateLimitPerMinute ?? null;
      const monthlyCallQuota = body.monthlyCallQuota ?? null;
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
            rateLimitPerMinute,
            monthlyCallQuota,
          });
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: row.id,
            action: "studio.mcp.token.created",
            metadata: {
              tokenId: row.id,
              prefix,
              scopes,
              rateLimitPerMinute,
              monthlyCallQuota,
            },
          });
          return row;
        },
      );
      return { ...tokenView(created), token };
    },

    /** Admin-only quota update. Unknown/foreign/revoked ids are 404/409. */
    async updateLimits(
      tokenId: string,
      body: UpdateMcpTokenLimitsBody,
    ): Promise<McpTokenView> {
      const { session } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(tokenId).success) {
        throw new ApiError(404, "not_found", "Not found.");
      }
      const updated = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const existing = await repos.studio.apiTokens.get(tokenId);
          if (!existing) throw new ApiError(404, "not_found", "Not found.");
          if (existing.revokedAt !== null)
            throw new ApiError(
              409,
              "token_revoked",
              "A revoked token cannot be updated.",
            );
          // Capture the previous values before the write: the fake repository
          // returns the same object it mutates, and a real row read is only a
          // snapshot anyway.
          const previousRateLimitPerMinute = existing.rateLimitPerMinute;
          const previousMonthlyCallQuota = existing.monthlyCallQuota;
          const applied = await repos.studio.apiTokens.updateLimits(tokenId, {
            rateLimitPerMinute: body.rateLimitPerMinute,
            monthlyCallQuota: body.monthlyCallQuota,
          });
          if (!applied) throw new ApiError(404, "not_found", "Not found.");
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: tokenId,
            action: "studio.mcp.token.limits_updated",
            metadata: {
              tokenId,
              rateLimitPerMinute: body.rateLimitPerMinute,
              monthlyCallQuota: body.monthlyCallQuota,
              previousRateLimitPerMinute,
              previousMonthlyCallQuota,
            },
          });
          const readback = await repos.studio.apiTokens.get(tokenId);
          if (!readback) throw new ApiError(404, "not_found", "Not found.");
          return readback;
        },
      );
      return tokenView(updated, await usageFor(tokenId));
    },

    /**
     * Rotate one token: create a replacement with the same label, scopes and
     * quotas, then revoke the old token in the same transaction. The old
     * plaintext is unrecoverable; the replacement plaintext is returned once.
     */
    async rotateToken(tokenId: string): Promise<CreateMcpTokenResult> {
      const { session } = await requireStudioSession(deps, "admin");
      if (!UUID.safeParse(tokenId).success) {
        throw new ApiError(404, "not_found", "Not found.");
      }
      const prefix = random(MCP_TOKEN_PREFIX_BYTES).toString("base64url");
      const secret = random(MCP_TOKEN_SECRET_BYTES).toString("base64url");
      const token = `${MCP_TOKEN_PLAINTEXT_PREFIX}${prefix}.${secret}`;
      const tokenHash = hashMcpTokenSecret(secret);
      const created = await database().forWorkspace(
        session.workspaceId,
        async (repos) => {
          const existing = await repos.studio.apiTokens.get(tokenId);
          if (!existing) throw new ApiError(404, "not_found", "Not found.");
          if (existing.revokedAt !== null)
            throw new ApiError(
              409,
              "token_revoked",
              "A revoked token cannot be rotated.",
            );
          const replacement = await repos.studio.apiTokens.create({
            label: existing.label,
            tokenHash,
            prefix,
            scopes: existing.scopes,
            createdBy: session.actorId,
            rateLimitPerMinute: existing.rateLimitPerMinute,
            monthlyCallQuota: existing.monthlyCallQuota,
          });
          const revoked = await repos.studio.apiTokens.revoke(tokenId);
          if (!revoked)
            throw new ApiError(
              409,
              "token_revoked",
              "The token could not be rotated.",
            );
          await repos.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: tokenId,
            action: "studio.mcp.token.rotated",
            metadata: {
              tokenId,
              replacementTokenId: replacement.id,
              rateLimitPerMinute: replacement.rateLimitPerMinute,
              monthlyCallQuota: replacement.monthlyCallQuota,
            },
          });
          return replacement;
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
