import Link from "next/link";

import type { Locale } from "../lib/locale";
import type { StudioCopyKey } from "../lib/studio-copy";
import { studioCopy } from "../lib/studio-copy";
import {
  type StudioOnboardingOwner,
  type StudioOnboardingResult,
  type StudioOnboardingStep,
  type StudioOnboardingStepKey,
} from "../lib/studio/onboarding";
import styles from "./studio.module.css";

/**
 * "Getting started" card on the Studio home (P2).
 *
 * The card is a projection of `readStudioOnboarding`; it never writes a step
 * and never marks one complete from a click. It hides once every durable step
 * is done, stays collapsed after the first step, and shows an honest
 * unavailable/partial line instead of zeroes when a source could not be read.
 */
const STEP_LABEL_KEYS: Record<StudioOnboardingStepKey, StudioCopyKey> = {
  store: "studio.setup.step.store",
  reviewer: "studio.setup.step.reviewer",
  catalog: "studio.setup.step.catalog",
  review: "studio.setup.step.review",
  signoff: "studio.setup.step.signoff",
  export: "studio.setup.step.export",
};

const OWNER_LABEL_KEYS: Record<StudioOnboardingOwner, StudioCopyKey> = {
  admin: "studio.setup.owner.admin",
  operator: "studio.setup.owner.operator",
  reviewer: "studio.setup.owner.reviewer",
};

const STATE_LABEL_KEYS: Record<StudioOnboardingStep["state"], StudioCopyKey> = {
  done: "studio.setup.state.done",
  todo: "studio.setup.state.todo",
  unknown: "studio.setup.state.unknown",
};

const ASK_KEYS: Record<StudioOnboardingOwner, StudioCopyKey> = {
  admin: "studio.setup.askAdmin",
  operator: "studio.setup.askOperator",
  reviewer: "studio.setup.askReviewer",
};

export function StudioOnboarding({
  locale,
  result,
}: {
  readonly locale: Locale;
  readonly result: StudioOnboardingResult;
}) {
  if (result.status === "unavailable") {
    return (
      <p role="status" className={styles["studio-notice"]}>
        {studioCopy(locale, "studio.setup.unavailable")}
      </p>
    );
  }

  if (result.done === result.total) return null;

  return (
    <details
      className={styles["studio-setup"]}
      open={result.done === 0 ? true : undefined}
      aria-label={studioCopy(locale, "studio.setup.title")}
    >
      <summary className={styles["studio-setup-summary"]}>
        {studioCopy(locale, "studio.setup.summary")
          .replace("{done}", String(result.done))
          .replace("{total}", String(result.total))}
      </summary>
      <div className={styles["studio-setup-body"]}>
        <p className={styles["studio-section-lede"]}>
          {studioCopy(locale, "studio.setup.lede")}
        </p>
        {result.unknown > 0 ? (
          <p className={styles["studio-setup-partial"]}>
            {studioCopy(locale, "studio.setup.partial")}
          </p>
        ) : null}
        <ol className={styles["studio-setup-list"]}>
          {result.steps.map((step) => (
            <li
              key={step.key}
              className={styles["studio-setup-item"]}
              data-state={step.state}
            >
              <span
                className={styles["studio-setup-state"]}
                data-state={step.state}
              >
                {studioCopy(locale, STATE_LABEL_KEYS[step.state])}
              </span>
              <span className={styles["studio-setup-label"]}>
                {studioCopy(locale, STEP_LABEL_KEYS[step.key])}
              </span>
              <span className={styles["studio-setup-owner"]}>
                {studioCopy(locale, OWNER_LABEL_KEYS[step.owner])}
              </span>
              {step.state === "todo" && step.href !== null ? (
                <Link
                  className={styles["studio-setup-action"]}
                  href={step.href}
                >
                  {studioCopy(locale, "studio.setup.open")}
                </Link>
              ) : step.state === "todo" ? (
                <span className={styles["studio-setup-hint"]}>
                  {studioCopy(locale, ASK_KEYS[step.owner])}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
