import { cookies } from "next/headers";

import { StudioAgents } from "../../../../components/studio-agents";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";

/**
 * `/studio/agents` — static agent catalogue inside the Studio shell.
 *
 * The layout enforces the Studio session and flag; this page only resolves the
 * current role so a reader below operator sees "ask an operator" instead of a
 * composer action their role cannot use. No records are read.
 */
export default async function StudioAgentsPage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
  const session = await authSessionContext.resolve();
  const canCreateThread = session
    ? requireWorkspaceRole("operator", session.role)
    : false;

  return <StudioAgents locale={locale} canCreateThread={canCreateThread} />;
}
