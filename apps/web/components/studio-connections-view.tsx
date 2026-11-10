import Link from "next/link";

import type { StudioRole } from "@wukong/core";
import { TOOL_DEFINITIONS } from "@wukong/core";

import type { Locale } from "../lib/locale";
import { hasStudioMcpEncryptionKey } from "../lib/studio/mcp-credentials";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The honest tools-and-connections page (design spec §2.1, plan Task 7).
 *
 * Internal tools come from the reviewed `@wukong/core` registry, so this page
 * cannot drift from what the turn service may actually execute: id, kind,
 * minimum role and capability id are the definition's own values, and the
 * state column distinguishes read tools (skills plus the flag-gated hosted MCP
 * endpoint) from propose/dispatch tools that are advertised but not executable
 * through the tool plane.
 *
 * Hosted and external MCP are reported from the deployment's actual flags, not
 * from a hard-coded snapshot: the hosted endpoint and admin-managed tokens are
 * implemented and flag-gated, and external MCP is admin-only and off by
 * default. There is no "Connect" control, no fake green status and no toggle on
 * this page — the settings page is where an admin manages tokens and external
 * connections, and this page links there instead of implying a connection.
 */

export type ConnectionsRuntimeState = {
  /** `STUDIO_MCP_SERVER_ENABLED === "true"`. */
  readonly hostedMcpEnabled: boolean;
  /** `STUDIO_EXTERNAL_MCP_ENABLED === "true"` (per-connection approval still applies). */
  readonly externalMcpEnabled: boolean;
  /** `STUDIO_MCP_ENCRYPTION_KEY` present and well-formed. */
  readonly mcpEncryptionKeyPresent: boolean;
};

const RUNTIME_OFF: ConnectionsRuntimeState = {
  hostedMcpEnabled: false,
  externalMcpEnabled: false,
  mcpEncryptionKeyPresent: false,
};

/** Resolve the flag-gated runtime state this page reports. */
export function resolveConnectionsRuntime(
  env: NodeJS.ProcessEnv = process.env,
): ConnectionsRuntimeState {
  return {
    hostedMcpEnabled: env.STUDIO_MCP_SERVER_ENABLED === "true",
    externalMcpEnabled: env.STUDIO_EXTERNAL_MCP_ENABLED === "true",
    mcpEncryptionKeyPresent: hasStudioMcpEncryptionKey(env),
  };
}

const TOOL_KIND_KEYS = {
  read: "studio.connections.kind.read",
  propose: "studio.connections.kind.propose",
  dispatch: "studio.connections.kind.dispatch",
} as const satisfies Record<string, StudioCopyKey>;

const TOOL_STATE_KEYS = {
  read: "studio.connections.toolState.read",
  propose: "studio.connections.toolState.propose",
  dispatch: "studio.connections.toolState.dispatch",
} as const satisfies Record<string, StudioCopyKey>;

const ROLE_KEYS = {
  viewer: "studio.role.viewer",
  operator: "studio.role.operator",
  reviewer: "studio.role.reviewer",
  admin: "studio.role.admin",
  owner: "studio.role.owner",
} as const satisfies Record<StudioRole, StudioCopyKey>;

export type StudioConnectionsViewProps = {
  readonly locale: Locale;
  readonly runtime?: ConnectionsRuntimeState;
};

export function StudioConnectionsView({
  locale,
  runtime = RUNTIME_OFF,
}: StudioConnectionsViewProps) {
  return (
    <div className={styles["studio-connections"]}>
      <header className={styles["studio-home-header"]}>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.connections.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.connections.intro")}
        </p>
      </header>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.connections.internalTitle")}
      >
        <div className={styles["studio-section-header"]}>
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.connections.internalTitle")}
          </h2>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.internalIntro")}
          </p>
        </div>
        <div className={styles["studio-table-scroll"]}>
          <table className={styles["studio-tools-table"]}>
            <thead>
              <tr>
                <th scope="col">
                  {studioCopy(locale, "studio.connections.table.tool")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.connections.table.kind")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.connections.table.minRole")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.connections.table.capability")}
                </th>
                <th scope="col">
                  {studioCopy(locale, "studio.connections.table.state")}
                </th>
              </tr>
            </thead>
            <tbody>
              {TOOL_DEFINITIONS.map((tool) => (
                <tr
                  key={tool.id}
                  data-tool-id={tool.id}
                  data-tool-kind={tool.kind}
                >
                  <td>
                    <span className={styles["studio-tool-name"]}>
                      {tool.label[locale]}
                    </span>
                    <code className={styles["studio-tool-id"]}>{tool.id}</code>
                  </td>
                  <td>{studioCopy(locale, TOOL_KIND_KEYS[tool.kind])}</td>
                  <td>{studioCopy(locale, ROLE_KEYS[tool.minRole])}</td>
                  <td>
                    <code className={styles["studio-tool-id"]}>
                      {tool.capabilityId}
                    </code>
                  </td>
                  <td>
                    <span
                      className={styles["studio-connection-state"]}
                      data-state={tool.kind}
                    >
                      {studioCopy(locale, TOOL_STATE_KEYS[tool.kind])}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.connections.hostedTokens")}
      >
        <div
          className={styles["studio-connection-card"]}
          data-state={runtime.hostedMcpEnabled ? "configured" : "blocked"}
        >
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.connections.hostedTokens")}
          </h2>
          <p
            className={styles["studio-badge"]}
            data-availability={
              runtime.hostedMcpEnabled ? "pilot" : "unavailable"
            }
          >
            {studioCopy(
              locale,
              runtime.hostedMcpEnabled
                ? "studio.connections.hostedState.enabled"
                : "studio.connections.hostedState.disabled",
            )}
          </p>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(
              locale,
              runtime.hostedMcpEnabled
                ? "studio.connections.hostedBody.enabled"
                : "studio.connections.hostedBody.disabled",
            )}
          </p>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.hostedTokensManaged")}{" "}
            <Link href="/studio/settings">
              {studioCopy(locale, "studio.connections.settingsLink")}
            </Link>
          </p>
        </div>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.connections.external")}
      >
        <div
          className={styles["studio-connection-card"]}
          data-state={runtime.externalMcpEnabled ? "configured" : "blocked"}
        >
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.connections.external")}
          </h2>
          <p
            className={styles["studio-badge"]}
            data-availability={
              runtime.externalMcpEnabled ? "pilot" : "unavailable"
            }
          >
            {studioCopy(
              locale,
              runtime.externalMcpEnabled
                ? "studio.connections.externalState.flagOn"
                : "studio.connections.externalState.disabled",
            )}
          </p>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.externalBody")}
          </p>
          {runtime.externalMcpEnabled && !runtime.mcpEncryptionKeyPresent ? (
            <p className={styles["studio-section-lede"]}>
              {studioCopy(locale, "studio.connections.externalKeyMissing")}
            </p>
          ) : null}
          <p className={styles["studio-section-lede"]}>
            <Link href="/studio/settings">
              {studioCopy(locale, "studio.connections.settingsLink")}
            </Link>
          </p>
        </div>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.connections.blockedTitle")}
      >
        <div className={styles["studio-section-header"]}>
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.connections.blockedTitle")}
          </h2>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.empty")}
          </p>
        </div>
        <ul className={styles["studio-connection-list"]}>
          {[
            "studio.connections.whatsapp",
            "studio.connections.customerService",
            "studio.connections.logistics",
          ].map((key) => (
            <li key={key} className={styles["studio-connection-blocked"]}>
              <span
                className={styles["studio-badge"]}
                data-availability="unavailable"
              >
                {studioCopy(locale, "studio.connections.disabled")}
              </span>
              <span>{studioCopy(locale, key as StudioCopyKey)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
