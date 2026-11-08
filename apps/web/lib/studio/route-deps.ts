import type { StudioModel } from "@wukong/ai";
import type { StudioSettings } from "@wukong/db";

import type { SessionContextPort } from "../session-context-port";
import { isStudioAiEnabled, isStudioEnabled } from "../studio-flags";
import type { StudioDatabase } from "./session";
import type { StudioServiceDeps } from "./turn-service";

/**
 * Route-handler dependency shape (plan Task 6).
 *
 * A route binds the two production ports at the bottom of its file and tests
 * inject fakes for everything, including the clock and the model factory. The
 * flag parsers are the real fail-closed ones from `../studio-flags`; only
 * `env` is injectable so a test never has to mutate `process.env`.
 */
export type StudioRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => StudioDatabase;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createModel?: (settings: StudioSettings) => StudioModel | null;
};

/** Fill in the production flags module around a route's injected ports. */
export function studioServiceDeps(deps: StudioRouteDeps): StudioServiceDeps {
  return {
    sessionContext: deps.sessionContext,
    getDatabase: deps.getDatabase,
    isStudioEnabled,
    isStudioAiEnabled,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.createModel ? { createModel: deps.createModel } : {}),
  };
}
