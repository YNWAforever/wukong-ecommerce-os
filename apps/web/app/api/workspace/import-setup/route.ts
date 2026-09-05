import { assertShoplineEncryptionKey } from "@wukong/shopline";
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type ImportSetupDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
  getEncryptionKey: () => string | undefined;
};
export function createImportSetupHandler(deps: ImportSetupDeps) {
  return async (_request: Request): Promise<Response> => {
    const response = await withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      const connection = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.shoplineConnections.getDefault(),
        );
      let credentialStorageConfigured = false;
      try {
        assertShoplineEncryptionKey(deps.getEncryptionKey() ?? "");
        credentialStorageConfigured = true;
      } catch {
        // Only the capability is public. Never serialize key validation errors.
      }
      return jsonResponse(200, {
        connection: connection ? { shopDomain: connection.shopDomain } : null,
        canManageConnection: requireWorkspaceRole("admin", session.role),
        canImport: requireWorkspaceRole("operator", session.role),
        credentialStorageConfigured,
      });
    });
    response.headers.set("cache-control", "no-store");
    return response;
  };
}
export const GET = createImportSetupHandler({
  sessionContext: authSessionContext,
  getDatabase,
  getEncryptionKey: () => process.env.SHOPLINE_TOKEN_ENCRYPTION_KEY,
});
