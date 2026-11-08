import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { TOOL_DEFINITIONS } from "@wukong/core";

import { StudioSettingsView } from "../../../../components/studio-settings-view";
import { getDatabase } from "../../../../lib/intake-runtime";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { ApiError } from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import { isStudioEnabled } from "../../../../lib/studio-flags";
import { createMcpConnectionService } from "../../../../lib/studio/mcp-connections";
import { createMcpTokenService } from "../../../../lib/studio/mcp-tokens";
import { requireStudioSession } from "../../../../lib/studio/session";
import { studioSettingsAdminView } from "../../../../lib/studio/settings-admin";

/**
 * `/studio/settings` — admin-only Studio administration (plan Task 13 + A1).
 *
 * The shared `requireStudioSession(deps, "admin")` gate runs first: no
 * session redirects to sign-in, a disabled Studio or a non-admin membership
 * answers `notFound()` so the surface never reveals itself to a reader who
 * cannot administer it. Token, connection and settings reads all use the same
 * services the APIs use, so what this page renders is exactly what the routes
 * enforce; the workspace card edits through `PATCH /api/studio/settings` and
 * shows only the server readback.
 */
export default async function StudioSettingsPage() {
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin");

  const studioSession = await requireStudioSession(
    {
      sessionContext: authSessionContext,
      getDatabase,
      isStudioEnabled,
    },
    "admin",
  ).catch((error: unknown) => {
    // A not-admin or disabled-Studio workspace sees the same 404: the settings
    // surface does not advertise itself to a reader who cannot administer it.
    if (error instanceof ApiError && error.status === 401) redirect("/signin");
    notFound();
  });

  const deps = {
    sessionContext: authSessionContext,
    getDatabase,
    isStudioEnabled,
  } as const;
  const tokenService = createMcpTokenService(deps);
  const connectionService = createMcpConnectionService(deps);
  const [tokens, connections] = await Promise.all([
    tokenService.listTokens(),
    connectionService.listConnections(),
  ]);

  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <StudioSettingsView
      locale={locale}
      settingsAdmin={studioSettingsAdminView(studioSession.settings)}
      tokens={tokens.items}
      connections={connections}
      tools={TOOL_DEFINITIONS.map((tool) => ({
        id: tool.id,
        label: {
          "zh-Hant": tool.label["zh-Hant"],
          en: tool.label.en,
        },
        kind: tool.kind,
        minRole: tool.minRole,
        costClass: tool.costClass,
      }))}
    />
  );
}
