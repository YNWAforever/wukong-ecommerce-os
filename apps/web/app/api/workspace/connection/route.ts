import { z } from "zod";

import { ShoplineConnectionExistsError } from "@wukong/db";

import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type ConnectionRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
  getEncryptionKey: () => string;
};

const createBodySchema = z
  .object({ shopDomain: z.string().min(1), accessToken: z.string().min(1) })
  .strict();
const rotateBodySchema = z.object({ accessToken: z.string().min(1) }).strict();

async function requireAdmin(deps: ConnectionRouteDeps) {
  const session = await requireSessionContext(deps.sessionContext);
  if (!requireWorkspaceRole("admin", session.role)) {
    throw new ApiError(403, "insufficient_role", "Admin access is required.");
  }
  return session;
}

export function createConnectionHandler(deps: ConnectionRouteDeps) {
  return {
    async GET(_request: Request): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const connection = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, (repositories) =>
            repositories.shoplineConnections.getDefault(),
          );
        return jsonResponse(200, {
          connection: connection
            ? {
                shopDomain: connection.shopDomain,
                connectedAt: connection.createdAt ?? null,
              }
            : null,
        });
      });
    },

    async POST(request: Request): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const parsed = createBodySchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) {
          throw new ApiError(
            400,
            "invalid_body",
            "Invalid connection payload.",
          );
        }
        let created;
        try {
          created = await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, async (repositories) => {
              const connection = await repositories.shoplineConnections.create({
                shopDomain: parsed.data.shopDomain,
                accessToken: parsed.data.accessToken,
                base64Key: deps.getEncryptionKey(),
              });
              await repositories.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: connection.id,
                action: "workspace.connection_created",
                metadata: { shopDomain: connection.shopDomain },
              });
              return connection;
            });
        } catch (error) {
          // The repository throws a typed ShoplineConnectionExistsError
          // (single call site, not worth a centralized route-support
          // mapping) when a connection already exists for this workspace.
          // Map that common case to a clear 409 instead of letting it fall
          // through to the generic 500. The rare concurrent-insert race
          // still hits the DB's UNIQUE(workspace_id) constraint and is
          // handled by withRouteErrors's existing 23505 mapping.
          if (error instanceof ShoplineConnectionExistsError) {
            throw new ApiError(
              409,
              "already_exists",
              "A SHOPLINE connection already exists for this workspace.",
            );
          }
          throw error;
        }
        return jsonResponse(200, { shopDomain: created.shopDomain });
      });
    },

    async PATCH(request: Request): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const parsed = rotateBodySchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success) {
          throw new ApiError(
            400,
            "invalid_body",
            "Invalid connection payload.",
          );
        }
        await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const existing =
              await repositories.shoplineConnections.getDefault();
            if (!existing) {
              throw new ApiError(
                404,
                "not_found",
                "No SHOPLINE connection exists yet.",
              );
            }
            await repositories.shoplineConnections.update(existing.id, {
              accessToken: parsed.data.accessToken,
              base64Key: deps.getEncryptionKey(),
            });
            await repositories.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: existing.id,
              action: "workspace.connection_rotated",
              metadata: {},
            });
          });
        return jsonResponse(200, { ok: true });
      });
    },
  };
}

const handlers = createConnectionHandler({
  sessionContext: authSessionContext,
  getDatabase,
  getEncryptionKey: () => {
    const key = process.env.SHOPLINE_TOKEN_ENCRYPTION_KEY;
    if (!key) {
      throw new ApiError(
        503,
        "runtime_unavailable",
        "SHOPLINE credential storage is not configured.",
      );
    }
    return key;
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
