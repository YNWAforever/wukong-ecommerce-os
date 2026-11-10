import Link from "next/link";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import type { ProductShotHandoff } from "../lib/studio/types";
import styles from "./studio.module.css";

/**
 * Read-only product-shot prepare card (C1, skill v1.1).
 *
 * The deterministic turn only *prepares* a handoff: it records the usable
 * source images and the persisted image-review state, and links to the existing
 * gated screen. This card never calls the image provider, mints no signed URL
 * and offers no confirmation that would write anything; the operator's next
 * action is the same image review they already use.
 */

const STATE_KEYS: Readonly<Record<string, StudioCopyKey>> = {
  queued: "studio.productShotHandoff.stateLabel.queued",
  processing: "studio.productShotHandoff.stateLabel.processing",
  cutout_ready: "studio.productShotHandoff.stateLabel.cutout_ready",
  candidate_ready: "studio.productShotHandoff.stateLabel.candidate_ready",
  approved: "studio.productShotHandoff.stateLabel.approved",
  failed: "studio.productShotHandoff.stateLabel.failed",
  outcome_unknown: "studio.productShotHandoff.stateLabel.outcome_unknown",
};

export function stateLabel(locale: Locale, state: string | null): string {
  if (state === null)
    return studioCopy(locale, "studio.productShotHandoff.stateUnknown");
  const key = STATE_KEYS[state];
  return key
    ? studioCopy(locale, key)
    : studioCopy(locale, "studio.productShotHandoff.stateLabel.other").replace(
        "{state}",
        state,
      );
}

export function StudioProductShotHandoff({
  locale,
  dispatch,
}: {
  readonly locale: Locale;
  readonly dispatch: ProductShotHandoff;
}) {
  const sourceCount = dispatch.assetIds.length;
  return (
    <section
      className={styles["studio-dispatch"]}
      data-kind="product_shot_handoff"
      data-ready={dispatch.ready ? "true" : "false"}
      aria-label={studioCopy(locale, "studio.productShotHandoff.title")}
    >
      <header className={styles["studio-dispatch-header"]}>
        <h4 className={styles["studio-dispatch-title"]}>
          {studioCopy(locale, "studio.productShotHandoff.title")}
        </h4>
        <span className={styles["studio-dispatch-badge"]}>
          {studioCopy(locale, "studio.productShotHandoff.note")}
        </span>
      </header>
      <p className={styles["studio-dispatch-note"]}>
        {studioCopy(locale, "studio.productShotHandoff.intro")}
      </p>
      <p className={styles["studio-dispatch-meta"]}>
        {studioCopy(locale, "studio.productShotHandoff.sources").replace(
          "{count}",
          String(sourceCount),
        )}
        {" · "}
        {studioCopy(locale, "studio.productShotHandoff.state").replace(
          "{state}",
          stateLabel(locale, dispatch.state),
        )}
      </p>
      <p className={styles["studio-dispatch-note"]}>
        {studioCopy(
          locale,
          dispatch.ready
            ? "studio.productShotHandoff.ready"
            : "studio.productShotHandoff.notReady",
        )}
      </p>
      <div className={styles["studio-output-actions"]}>
        <Link
          className={styles["studio-output-action"]}
          href={`/listings/${encodeURIComponent(dispatch.listingId)}`}
        >
          {studioCopy(locale, "studio.productShotHandoff.open")}
        </Link>
      </div>
    </section>
  );
}
