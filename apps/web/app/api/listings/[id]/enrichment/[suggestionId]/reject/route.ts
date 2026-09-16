import { createListingEnrichmentHandler } from "../../../../../../../lib/listing-enrichment-route";
import { getDatabase } from "../../../../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../../../../lib/session-context";
export const POST = createListingEnrichmentHandler(
  { getDatabase, sessionContext: authSessionContext },
  "reject",
);
