import type { AssetStore } from "@wukong/assets";
import type { Database } from "@wukong/db";

import type { ListingPublisher } from "./listing-queue-runtime.js";
import type { SessionContextPort } from "./session-context-port";

type IntakeRouteBaseDeps = {
  sessionContext: SessionContextPort;
  getAssetStore(): AssetStore;
  getDatabase(): Database;
};

export type IntakeRouteDeps<WithPublisher extends boolean = false> =
  IntakeRouteBaseDeps &
    (WithPublisher extends true ? { publisher: ListingPublisher } : {});
