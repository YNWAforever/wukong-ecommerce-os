import { cookies } from "next/headers";

import {
  resolveConnectionsRuntime,
  StudioConnectionsView,
} from "../../../../components/studio-connections-view";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";

/**
 * `/studio/connections` — internal tool catalogue and honest connection states
 * (plan Task 7).
 *
 * The catalogue comes from the reviewed `@wukong/core` `TOOL_DEFINITIONS`
 * registry, so a tool that this build cannot execute cannot appear as
 * available. Hosted and external MCP are reported from the deployment's real
 * flags (`STUDIO_MCP_SERVER_ENABLED`, `STUDIO_EXTERNAL_MCP_ENABLED` and the
 * encryption key): no hard-coded "not implemented" or fake connected state. The
 * layout gate has already run for the workspace.
 */
export default async function StudioConnectionsPage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <StudioConnectionsView
      locale={locale}
      runtime={resolveConnectionsRuntime(process.env)}
    />
  );
}
