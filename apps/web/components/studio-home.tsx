import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The Conversation Studio conversation home, as a static P1 shell.
 *
 * Everything here is honest about what does not exist yet:
 *  - the deterministic overview strip shows "Not yet available" and never a
 *    number, because the records read surface is Task 5;
 *  - the composer renders with every action disabled and says so;
 *  - template cards are non-interactive until Task 7 wires "fill the composer";
 *  - no fetch, no model call, no click handler, no invented data.
 *
 * Availability states mirror the skill definitions Task 4 will land: only the
 * two v1 read skills (`catalog.find`, `catalog.gap_review`) are pilot; every
 * role workflow is planned, and the two with no data source are unavailable.
 */

export type StudioAvailability = "ready" | "pilot" | "planned" | "unavailable";

const AVAILABILITY_KEY: Record<StudioAvailability, StudioCopyKey> = {
  ready: "studio.availability.ready",
  pilot: "studio.availability.pilot",
  planned: "studio.availability.planned",
  unavailable: "studio.availability.unavailable",
};

export type StudioTemplate = {
  readonly id: string;
  readonly availability: StudioAvailability;
  readonly titleKey: StudioCopyKey;
  readonly outcomeKey: StudioCopyKey;
  readonly limitationKey: StudioCopyKey;
};

/**
 * The two v1 read skills first, then the eight role templates from the design
 * spec §1.2. No card is `ready`: nothing in Studio can run a skill yet.
 */
export const STUDIO_TEMPLATES: readonly StudioTemplate[] = [
  {
    id: "catalog.find",
    availability: "pilot",
    titleKey: "studio.template.catalogFind.title",
    outcomeKey: "studio.template.catalogFind.outcome",
    limitationKey: "studio.template.catalogFind.limitation",
  },
  {
    id: "catalog.gap_review",
    availability: "pilot",
    titleKey: "studio.template.standards.title",
    outcomeKey: "studio.template.standards.outcome",
    limitationKey: "studio.template.standards.limitation",
  },
  {
    id: "listing.draft_from_sources",
    availability: "planned",
    titleKey: "studio.template.listingDraft.title",
    outcomeKey: "studio.template.listingDraft.outcome",
    limitationKey: "studio.template.listingDraft.limitation",
  },
  {
    id: "product_shot.prepare",
    availability: "planned",
    titleKey: "studio.template.productShot.title",
    outcomeKey: "studio.template.productShot.outcome",
    limitationKey: "studio.template.productShot.limitation",
  },
  {
    id: "listing.copy_proposal",
    availability: "planned",
    titleKey: "studio.template.copyProposal.title",
    outcomeKey: "studio.template.copyProposal.outcome",
    limitationKey: "studio.template.copyProposal.limitation",
  },
  {
    id: "category.map_proposal",
    availability: "planned",
    titleKey: "studio.template.categoryMapping.title",
    outcomeKey: "studio.template.categoryMapping.outcome",
    limitationKey: "studio.template.categoryMapping.limitation",
  },
  {
    id: "supplier.intel_proposal",
    availability: "planned",
    titleKey: "studio.template.supplierIntel.title",
    outcomeKey: "studio.template.supplierIntel.outcome",
    limitationKey: "studio.template.supplierIntel.limitation",
  },
  {
    id: "customer.reply_draft",
    availability: "unavailable",
    titleKey: "studio.template.customerReply.title",
    outcomeKey: "studio.template.customerReply.outcome",
    limitationKey: "studio.template.customerReply.limitation",
  },
  {
    id: "merchant.audit",
    availability: "planned",
    titleKey: "studio.template.merchantAudit.title",
    outcomeKey: "studio.template.merchantAudit.outcome",
    limitationKey: "studio.template.merchantAudit.limitation",
  },
  {
    id: "logistics.followup",
    availability: "unavailable",
    titleKey: "studio.template.logistics.title",
    outcomeKey: "studio.template.logistics.outcome",
    limitationKey: "studio.template.logistics.limitation",
  },
];

/**
 * The six numbers the deterministic overview will show (design spec §2.2).
 * This build renders their labels with a "Not yet available" state instead of
 * a fabricated snapshot.
 */
const OVERVIEW_TILE_KEYS: readonly StudioCopyKey[] = [
  "studio.overview.openBlockingFlags",
  "studio.overview.unapprovedDrafts",
  "studio.overview.failedJobs",
  "studio.overview.qualityGaps",
  "studio.overview.lastImport",
  "studio.overview.lastExport",
];

export type StudioHomeProps = {
  readonly locale: Locale;
};

export function StudioHome({ locale }: StudioHomeProps) {
  return (
    <div className={styles["studio-home"]}>
      <header className={styles["studio-home-header"]}>
        <p className={styles["studio-eyebrow"]}>
          {studioCopy(locale, "studio.home.eyebrow")}
        </p>
        <h1 className={styles["studio-home-title"]}>
          {studioCopy(locale, "studio.home.greeting")}
        </h1>
        <p className={styles["studio-home-lede"]}>
          {studioCopy(locale, "studio.home.intro")}
        </p>
      </header>

      <p className={styles["studio-notice"]}>
        {studioCopy(locale, "studio.home.staticNotice")}
      </p>

      <section
        className={styles["studio-composer"]}
        aria-label={studioCopy(locale, "studio.composer.label")}
      >
        <label
          htmlFor="studio-composer-input"
          className={styles["studio-visually-hidden"]}
        >
          {studioCopy(locale, "studio.composer.label")}
        </label>
        <textarea
          id="studio-composer-input"
          className={styles["studio-composer-textarea"]}
          placeholder={studioCopy(locale, "studio.composer.placeholder")}
          rows={3}
          aria-describedby="studio-composer-hint studio-composer-disclaimer"
        />
        <div className={styles["studio-composer-actions"]}>
          <button
            type="button"
            className={styles["studio-composer-send"]}
            disabled
            aria-describedby="studio-composer-hint"
          >
            {studioCopy(locale, "studio.composer.send")}
          </button>
          <button
            type="button"
            className={styles["studio-composer-attach"]}
            disabled
            title={studioCopy(locale, "studio.composer.attachUnavailable")}
          >
            {studioCopy(locale, "studio.composer.attach")}
          </button>
          <p
            id="studio-composer-hint"
            className={styles["studio-composer-hint"]}
          >
            {studioCopy(locale, "studio.composer.sendingUnavailable")}
          </p>
        </div>
        <p
          id="studio-composer-disclaimer"
          className={styles["studio-disclaimer"]}
        >
          {studioCopy(locale, "studio.composer.disclaimer")}
        </p>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.overview.title")}
      >
        <div className={styles["studio-section-header"]}>
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.overview.title")}
          </h2>
          {/* The spec's exact rule for this strip: records only, no model. */}
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.overview.rule")}
          </p>
        </div>
        <ul className={styles["studio-overview-grid"]}>
          {OVERVIEW_TILE_KEYS.map((key) => (
            <li className={styles["studio-overview-tile"]} key={key}>
              <span className={styles["studio-overview-label"]}>
                {studioCopy(locale, key)}
              </span>
              <span className={styles["studio-overview-value"]}>
                {studioCopy(locale, "studio.overview.notYetAvailable")}
              </span>
            </li>
          ))}
        </ul>
        <p className={styles["studio-empty"]}>
          {studioCopy(locale, "studio.overview.pending")}
        </p>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.templates.title")}
      >
        <div className={styles["studio-section-header"]}>
          <h2 className={styles["studio-section-title"]}>
            {studioCopy(locale, "studio.templates.title")}
          </h2>
          <p className={styles["studio-section-lede"]}>
            {studioCopy(locale, "studio.templates.intro")}
          </p>
        </div>
        <p className={styles["studio-section-lede"]}>
          {studioCopy(locale, "studio.templates.unavailableHint")}
        </p>
        <ul className={styles["studio-template-grid"]}>
          {STUDIO_TEMPLATES.map((template) => (
            <li
              key={template.id}
              className={styles["studio-template-card"]}
              data-availability={template.availability}
            >
              <div className={styles["studio-template-header"]}>
                <h3 className={styles["studio-template-title"]}>
                  {studioCopy(locale, template.titleKey)}
                </h3>
                <span
                  className={styles["studio-badge"]}
                  data-availability={template.availability}
                >
                  {studioCopy(locale, AVAILABILITY_KEY[template.availability])}
                </span>
              </div>
              <p className={styles["studio-template-outcome"]}>
                {studioCopy(locale, template.outcomeKey)}
              </p>
              <p className={styles["studio-template-limitation"]}>
                {studioCopy(locale, template.limitationKey)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.home.recentTitle")}
      >
        <h2 className={styles["studio-section-title"]}>
          {studioCopy(locale, "studio.home.recentTitle")}
        </h2>
        <p className={styles["studio-empty"]}>
          {studioCopy(locale, "studio.home.recentEmpty")}
        </p>
      </section>
    </div>
  );
}
