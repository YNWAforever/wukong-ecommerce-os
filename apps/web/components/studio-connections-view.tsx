import type { StudioRole } from "@wukong/core";
import { TOOL_DEFINITIONS } from "@wukong/core";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The honest tools-and-connections page (design spec §2.1, plan Task 7).
 *
 * Internal tools come from the reviewed `@wukong/core` registry, so this page
 * cannot drift from what the turn service may actually execute: id, kind,
 * minimum role and capability id are the definition's own values, and the
 * state column distinguishes a read tool the pilot skills use from propose and
 * dispatch tools that are registered but not executable yet.
 *
 * Everything else is a stated non-connection. Hosted MCP tokens are not
 * implemented; external MCP is disabled by default and accepts no user-supplied
 * endpoint or credential; WhatsApp, a customer-service inbox and logistics have
 * no data source and stay blocked. There is no "Connect" control, no fake green
 * status and no toggle — this page only reports the source tree's real state.
 */

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
};

export function StudioConnectionsView({ locale }: StudioConnectionsViewProps) {
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
        <div className={styles["studio-connection-card"]} data-state="planned">
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.connections.hostedTokens")}
          </h2>
          <p className={styles["studio-badge"]} data-availability="planned">
            {studioCopy(locale, "studio.connections.notConfigured")}
          </p>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.hostedBody")}
          </p>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.planned")}
          </p>
        </div>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.connections.external")}
      >
        <div className={styles["studio-connection-card"]} data-state="blocked">
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.connections.external")}
          </h2>
          <p className={styles["studio-badge"]} data-availability="unavailable">
            {studioCopy(locale, "studio.connections.disabled")}
          </p>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.connections.externalBody")}
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
