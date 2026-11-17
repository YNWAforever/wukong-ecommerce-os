import Link from "next/link";

import type { Locale } from "../lib/locale";
import {
  AGENT_GROUP_KEYS,
  AGENT_GROUP_ORDER,
  AVAILABILITY_KEY,
  agentsInGroup,
  type StudioAgent,
} from "../lib/studio/agents";
import { studioCopy } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * `/studio/agents` — the reviewed agent catalogue.
 *
 * This is a packaging surface, not a second runtime: the card order, maturity
 * badges and interactive state all come from `lib/studio/agents.ts`, whose
 * availability mirrors the reviewed skill registry. Nothing here calls a model
 * or the database, and nothing offers a dead action: planned and unavailable
 * agents have no link, and readers below operator see who can use a pilot agent
 * instead of a control that would fail.
 */
export function StudioAgents({
  locale,
  canCreateThread,
}: {
  readonly locale: Locale;
  readonly canCreateThread: boolean;
}) {
  return (
    <div className={styles["studio-agents-page"]}>
      <header className={styles["studio-agents-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.agents.eyebrow")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.agents.title")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.agents.lede")}
        </p>
        <p className={styles["studio-notice"]}>
          {studioCopy(locale, "studio.agents.rule")}
        </p>
      </header>

      {AGENT_GROUP_ORDER.map((group) => (
        <section key={group} className={styles["studio-agents-group"]}>
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, AGENT_GROUP_KEYS[group])}
          </h2>
          <ul className={styles["studio-agent-grid"]}>
            {agentsInGroup(group).map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                locale={locale}
                canCreateThread={canCreateThread}
              />
            ))}
          </ul>
        </section>
      ))}

      <p className={styles["studio-agent-truth"]}>
        {studioCopy(locale, "studio.agents.truthNote")}
      </p>
    </div>
  );
}

function AgentCard({
  agent,
  locale,
  canCreateThread,
}: {
  readonly agent: StudioAgent;
  readonly locale: Locale;
  readonly canCreateThread: boolean;
}) {
  const usable =
    agent.availability === "pilot" && agent.starterKey !== undefined;

  return (
    <li
      className={styles["studio-agent-card"]}
      data-availability={agent.availability}
      data-interactive={usable && canCreateThread ? "true" : "false"}
    >
      <div className={styles["studio-template-header"]}>
        <h3 className={styles["studio-template-title"]}>
          {studioCopy(locale, agent.titleKey)}
        </h3>
        <span
          className={styles["studio-badge"]}
          data-availability={agent.availability}
        >
          {studioCopy(locale, AVAILABILITY_KEY[agent.availability])}
        </span>
      </div>

      <p className={styles["studio-agent-label"]}>
        {studioCopy(locale, "studio.agents.outcomeLabel")}
      </p>
      <p className={styles["studio-agent-outcome"]}>
        {studioCopy(locale, agent.outcomeKey)}
      </p>

      <p className={styles["studio-agent-label"]}>
        {studioCopy(locale, "studio.agents.limitLabel")}
      </p>
      <p className={styles["studio-agent-limit"]}>
        {studioCopy(locale, agent.limitationKey)}
      </p>

      {usable && canCreateThread ? (
        <Link
          className={styles["studio-agent-action"]}
          href={`/studio?agent=${encodeURIComponent(agent.id)}`}
        >
          {studioCopy(locale, "studio.agents.use")}
        </Link>
      ) : usable ? (
        <p className={styles["studio-agent-unavailable"]}>
          {studioCopy(locale, "studio.agents.askOperator")}
        </p>
      ) : (
        <p className={styles["studio-agent-unavailable"]}>
          {studioCopy(locale, "studio.honest.notYetAvailable")}
        </p>
      )}
    </li>
  );
}
