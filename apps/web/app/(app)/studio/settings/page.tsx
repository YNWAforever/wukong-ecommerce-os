import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { TOOL_DEFINITIONS } from "@wukong/core";

import { StudioSettingsView } from "../../../../components/studio-settings-view";
import styles from "../../../../components/studio.module.css";
import { getDatabase } from "../../../../lib/intake-runtime";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../lib/locale";
import { ApiError } from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";
import { isStudioEnabled } from "../../../../lib/studio-flags";
import { createMcpConnectionService } from "../../../../lib/studio/mcp-connections";
import { createMcpTokenService } from "../../../../lib/studio/mcp-tokens";
import { renderStudioLine } from "../../../../lib/studio-render";
import { requireStudioSession } from "../../../../lib/studio/session";
import { studioCopy, type StudioCopyKey } from "../../../../lib/studio-copy";
import { studioSettingsAdminView } from "../../../../lib/studio/settings-admin";
import type { StudioMetricsResult } from "../../../../lib/studio/contracts";
import { formatHkDate } from "../../../../lib/ui-copy";
import { studioService } from "../studio-service";

/**
 * Read-only admin usage rows (A5.2). Every value is rendered from the server
 * aggregate; a failed read replaces the rows with one honest note, not zeroes.
 */
function UsageStat({
  locale,
  labelKey,
  lineKey,
  values,
}: {
  readonly locale: Parameters<typeof studioCopy>[0];
  readonly labelKey: StudioCopyKey;
  readonly lineKey: StudioCopyKey;
  readonly values: Record<string, string | number>;
}) {
  return (
    <li className={styles["studio-overview-tile"]}>
      <span className={styles["studio-overview-label"]}>
        {studioCopy(locale, labelKey)}
      </span>
      <span className={styles["studio-overview-value"]}>
        {renderStudioLine(locale, { key: lineKey, values })}
      </span>
    </li>
  );
}

function UsageSection({
  locale,
  metrics,
}: {
  readonly locale: Parameters<typeof studioCopy>[0];
  readonly metrics: StudioMetricsResult | null;
}) {
  return (
    <section
      className={styles["studio-section"]}
      aria-label={studioCopy(locale, "studio.usage.title")}
    >
      <div className={styles["studio-section-header"]}>
        <h2 className={styles["studio-section-title"]}>
          {studioCopy(locale, "studio.usage.title")}
        </h2>
        <p className={styles["studio-section-lede"]}>
          {studioCopy(locale, "studio.usage.lede")}
        </p>
      </div>
      {metrics === null ? (
        <p className={styles["studio-notice"]} role="alert">
          {studioCopy(locale, "studio.usage.failure")}
        </p>
      ) : (
        <>
          <p className={styles["studio-section-lede"]}>
            {renderStudioLine(locale, {
              key: "studio.usage.window",
              values: {
                since: formatHkDate(metrics.since, locale),
                asOf: formatHkDate(metrics.asOf, locale),
              },
            })}
          </p>
          <ul className={styles["studio-overview-grid"]}>
            <UsageStat
              locale={locale}
              labelKey="studio.usage.turnsLabel"
              lineKey="studio.usage.turns"
              values={{
                total: metrics.runs.total,
                succeeded: metrics.runs.succeeded,
                failed: metrics.runs.failed,
              }}
            />
            <UsageStat
              locale={locale}
              labelKey="studio.usage.spendLabel"
              lineKey="studio.usage.spend"
              values={{
                settled: metrics.spendUsd.settled,
                reserved: metrics.spendUsd.reserved,
              }}
            />
            <UsageStat
              locale={locale}
              labelKey="studio.usage.tokensLabel"
              lineKey="studio.usage.tokens"
              values={{
                input: metrics.tokens.input,
                output: metrics.tokens.output,
              }}
            />
            <UsageStat
              locale={locale}
              labelKey="studio.usage.mcpLabel"
              lineKey="studio.usage.mcp"
              values={{
                total: metrics.mcpCalls.total,
                denied: metrics.mcpCalls.denied,
                error: metrics.mcpCalls.error,
              }}
            />
            <UsageStat
              locale={locale}
              labelKey="studio.usage.contentLabel"
              lineKey="studio.usage.content"
              values={{
                threads: metrics.threadsCreated,
                messages: metrics.messages,
              }}
            />
          </ul>
          <p className={styles["studio-evidence-note"]}>
            {studioCopy(locale, "studio.usage.note")}
          </p>
        </>
      )}
    </section>
  );
}

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

  // The usage summary is a read-only projection; its failure must never blank
  // or block the settings form, so it degrades to one honest localised note.
  const metrics = await studioService()
    .metrics()
    .catch((error: unknown) => {
      console.info(
        JSON.stringify({
          event: "studio_metrics_read_failed",
          outcome: "failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return null;
    });

  return (
    <>
      <UsageSection locale={locale} metrics={metrics} />
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
    </>
  );
}
