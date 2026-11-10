import type { McpClient, McpClientDeps, StudioModel } from "@wukong/ai";
import type { StudioSettings } from "@wukong/db";

import type { SessionContextPort } from "../session-context-port";
import { isStudioAiEnabled, isStudioEnabled } from "../studio-flags";
import type { StudioDatabase } from "./session";
import type { StudioServiceDeps } from "./turn-service";

/**
 * Route-handler dependency shape (plan Task 6).
 *
 * A route binds the two production ports at the bottom of its file and tests
 * inject fakes for everything, including the clock, the model factory and the
 * external MCP client used by the admin probe.
 */
export type StudioRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => StudioDatabase;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createModel?: (settings: StudioSettings) => StudioModel | null;
  createClient?: (input: McpClientDeps) => McpClient;
};

/** Fill in the production flags module around a route's injected ports. */
export function studioServiceDeps(
  deps: StudioRouteDeps,
): StudioServiceDeps & { createClient?: (input: McpClientDeps) => McpClient } {
  return {
    sessionContext: deps.sessionContext,
    getDatabase: deps.getDatabase,
    isStudioEnabled,
    isStudioAiEnabled,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.createModel ? { createModel: deps.createModel } : {}),
    ...(deps.createClient ? { createClient: deps.createClient } : {}),
  };
}
