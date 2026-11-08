import type { Locale } from "../lib/locale";
import type { McpConnectionsSnapshot } from "../lib/studio/mcp-connections";
import type { McpTokenView } from "../lib/studio/mcp-tokens";
import type { StudioSettingsAdminView } from "../lib/studio/settings-admin";
import {
  studioSettingsCopy,
  type StudioSettingsCopyKey,
} from "../lib/studio-settings-copy";
import { StudioMcpConnectionsPanel } from "./studio-mcp-connections-panel";
import { StudioTokenPanel } from "./studio-token-panel";
import { StudioWorkspaceSettingsPanel } from "./studio-workspace-settings-panel";
import styles from "./studio.module.css";

/**
 * Admin Studio settings view (plan Task 13 + A1).
 *
 * Editable workspace settings, the two admin panels (API tokens, external MCP
 * registry) and the reviewed tool catalogue. The page gates on admin and has
 * already resolved every value server-side; the view never fetches on its own
 * beyond the workspace card's explicit save action, and shows no fabricated
 * connection or model status.
 */

export type StudioToolRow = {
  id: string;
  label: { "zh-Hant": string; en: string };
  kind: "read" | "propose" | "dispatch";
  minRole: string;
  costClass: "free" | "model" | "paid";
};

export type StudioSettingsViewProps = {
  locale: Locale;
  settingsAdmin: StudioSettingsAdminView;
  tokens: readonly McpTokenView[];
  connections: McpConnectionsSnapshot;
  tools: readonly StudioToolRow[];
};

const KIND_KEYS: Record<StudioToolRow["kind"], StudioSettingsCopyKey> = {
  read: "studio.settings.tools.kind.read",
  propose: "studio.settings.tools.kind.propose",
  dispatch: "studio.settings.tools.kind.dispatch",
};

const COST_KEYS: Record<StudioToolRow["costClass"], StudioSettingsCopyKey> = {
  free: "studio.settings.tools.cost.free",
  model: "studio.settings.tools.cost.model",
  paid: "studio.settings.tools.cost.paid",
};

export function StudioSettingsView({
  locale,
  settingsAdmin,
  tokens,
  connections,
  tools,
}: StudioSettingsViewProps) {
  const copy = (key: StudioSettingsCopyKey) => studioSettingsCopy(locale, key);

  return (
    <div className={styles["studio-section"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {copy("studio.settings.eyebrow")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {copy("studio.settings.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {copy("studio.settings.lede")}
        </p>
        <p className={styles["studio-notice"]}>
          {copy("studio.settings.noLiveConnection")}
        </p>
      </header>

      <StudioWorkspaceSettingsPanel locale={locale} initial={settingsAdmin} />

      <StudioTokenPanel locale={locale} initialTokens={tokens} />
      <StudioMcpConnectionsPanel locale={locale} snapshot={connections} />

      <section
        className={styles["studio-section"]}
        aria-labelledby="studio-settings-tools"
      >
        <header className={styles["studio-section-header"]}>
          <h2
            id="studio-settings-tools"
            className={styles["studio-section-title"]}
          >
            {copy("studio.settings.tools.title")}
          </h2>
          <p className={styles["studio-section-lede"]}>
            {copy("studio.settings.tools.lede")}
          </p>
        </header>
        <div className={styles["studio-table-scroll"]}>
          <table className={styles["studio-tools-table"]}>
            <thead>
              <tr>
                <th scope="col">{copy("studio.settings.tools.name")}</th>
                <th scope="col">{copy("studio.settings.tools.kind")}</th>
                <th scope="col">{copy("studio.settings.tools.minRole")}</th>
                <th scope="col">{copy("studio.settings.tools.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id}>
                  <td>
                    <span className={styles["studio-tool-name"]}>
                      {tool.label[locale]}
                    </span>{" "}
                    <code className={styles["studio-tool-id"]}>{tool.id}</code>
                  </td>
                  <td>{copy(KIND_KEYS[tool.kind])}</td>
                  <td>{tool.minRole}</td>
                  <td>{copy(COST_KEYS[tool.costClass])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
