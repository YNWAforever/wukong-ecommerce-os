import { cookies } from "next/headers";

import { StudioConnectionsView } from "../../../../components/studio-connections-view";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";

/**
 * `/studio/connections` — internal tool catalogue and honest connection states
 * (plan Task 7).
 *
 * The catalogue comes from the reviewed `@wukong/core` `TOOL_DEFINITIONS`
 * registry, so a tool that this build cannot execute cannot appear as
 * available; hosted MCP, external MCP, WhatsApp, a customer-service inbox and
 * logistics are stated as not-configured/disabled/blocked. The layout gate has
 * already run for the workspace.
 */
export default async function StudioConnectionsPage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return <StudioConnectionsView locale={locale} />;
}
