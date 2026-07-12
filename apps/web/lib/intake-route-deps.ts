import type { AssetStore } from "@wukong/assets";
import type { Database } from "@wukong/db";

import type { SessionContextPort } from "./session-context-port";

export type IntakeRouteDeps = {
  sessionContext: SessionContextPort;
  getAssetStore(): AssetStore;
  getDatabase(): Database;
};
