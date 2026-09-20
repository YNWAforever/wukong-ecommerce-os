import { createWineProposalHandlers } from "../../../../../../../../lib/wine-proposal-route";
import { getDatabase } from "../../../../../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../../../../../lib/session-context";
export const { POST } = createWineProposalHandlers({
  sessionContext: authSessionContext,
  getDatabase,
});
