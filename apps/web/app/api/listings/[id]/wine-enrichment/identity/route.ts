import { createWineOperationHandler } from "../../../../../../lib/wine-operation-route";
import { getDatabase } from "../../../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../../../lib/session-context";
import { listingPublisher } from "../../../../../../lib/listing-queue-runtime";
export const POST = createWineOperationHandler(
  {
    sessionContext: authSessionContext,
    getDatabase,
    publisher: listingPublisher,
  },
  "identity",
);
