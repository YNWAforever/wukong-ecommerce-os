"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { getSkill } from "@wukong/core";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import { useStudioAttachments } from "../lib/studio/attachments";
import type { StudioOverviewResult } from "../lib/studio/contracts";
import {
  createStudioClientMessageId,
  useStudioSession,
} from "../lib/use-studio-session";
import { StudioComposer } from "./studio-composer";
import { StudioHomeOverview } from "./studio-home-overview";
import styles from "./studio.module.css";

/**
 * The Conversation Studio home (design spec §2.2, plan Task 7).
 *
 * Three deterministic regions: the overview strip (server props from
 * `service.overview()`, records only), role-template cards, and the initial
 * composer. Nothing on this page calls a model while rendering; the exact rule
 * "From workspace records; no AI call." is printed beside the overview, and
 * `studio-home.test.tsx` renders the component with `fetch` stubbed to throw so
 * a silent fetch would fail the suite.
 *
 * A template card fills the composer and focuses it, but never sends. The first
 * send creates a thread (`POST /api/studio/threads`) and one message on it, then
 * navigates to the thread so the persisted reply renders from the server. A
 * failed send keeps the draft and the client message id: Retry reuses both, so
 * the server's replay path wins instead of creating a duplicate turn.
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
  /** Copy filled into the composer when a pilot card is used. */
  readonly starterKey?: StudioCopyKey;
};

/**
 * Availability is derived from the reviewed skill registry, never hard-coded:
 * a pilot skill is interactive, a planned skill states that it is planned, and
 * a blocked skill stays unavailable. The order is the design spec §1.2 role
 * template order, with the two read skills first.
 */
function templateAvailability(id: string): StudioAvailability {
  const skill = getSkill(id);
  if (skill?.status === "pilot") return "pilot";
  if (skill?.status === "planned") return "planned";
  return "unavailable";
}

type StudioTemplateDefinition = Omit<StudioTemplate, "availability">;

const STUDIO_TEMPLATE_DEFINITIONS: readonly StudioTemplateDefinition[] = [
  {
    id: "catalog.find",
    titleKey: "studio.template.catalogFind.title",
    outcomeKey: "studio.template.catalogFind.outcome",
    limitationKey: "studio.template.catalogFind.limitation",
    starterKey: "studio.template.catalogFind.starter",
  },
  {
    id: "catalog.gap_review",
    titleKey: "studio.template.standards.title",
    outcomeKey: "studio.template.standards.outcome",
    limitationKey: "studio.template.standards.limitation",
    starterKey: "studio.template.standards.starter",
  },
  {
    id: "listing.draft_from_sources",
    titleKey: "studio.template.listingDraft.title",
    outcomeKey: "studio.template.listingDraft.outcome",
    limitationKey: "studio.template.listingDraft.limitation",
    starterKey: "studio.template.listingDraft.starter",
  },
  {
    id: "product_shot.prepare",
    titleKey: "studio.template.productShot.title",
    outcomeKey: "studio.template.productShot.outcome",
    limitationKey: "studio.template.productShot.limitation",
    starterKey: "studio.template.productShot.starter",
  },
  {
    id: "listing.copy_proposal",
    titleKey: "studio.template.copyProposal.title",
    outcomeKey: "studio.template.copyProposal.outcome",
    limitationKey: "studio.template.copyProposal.limitation",
    starterKey: "studio.template.copyProposal.starter",
  },
  {
    id: "category.map_proposal",
    titleKey: "studio.template.categoryMapping.title",
    outcomeKey: "studio.template.categoryMapping.outcome",
    limitationKey: "studio.template.categoryMapping.limitation",
    starterKey: "studio.template.categoryMapping.starter",
  },
  {
    id: "supplier.intel_proposal",
    titleKey: "studio.template.supplierIntel.title",
    outcomeKey: "studio.template.supplierIntel.outcome",
    limitationKey: "studio.template.supplierIntel.limitation",
    starterKey: "studio.template.supplierIntel.starter",
  },
  {
    id: "customer.reply_draft",
    titleKey: "studio.template.customerReply.title",
    outcomeKey: "studio.template.customerReply.outcome",
    limitationKey: "studio.template.customerReply.limitation",
  },
  {
    id: "merchant.audit",
    titleKey: "studio.template.merchantAudit.title",
    outcomeKey: "studio.template.merchantAudit.outcome",
    limitationKey: "studio.template.merchantAudit.limitation",
    starterKey: "studio.template.merchantAudit.starter",
  },
  {
    id: "logistics.followup",
    titleKey: "studio.template.logistics.title",
    outcomeKey: "studio.template.logistics.outcome",
    limitationKey: "studio.template.logistics.limitation",
  },
];

export const STUDIO_TEMPLATES: readonly StudioTemplate[] =
  STUDIO_TEMPLATE_DEFINITIONS.map((template) => ({
    ...template,
    availability: templateAvailability(template.id),
  }));

type PendingHomeAttempt = {
  text: string;
  skillKey: string | null;
  clientMessageId: string;
  threadId: string | null;
  /** Finalized attachment ids captured when the send was first attempted. */
  attachmentAssetIds: readonly string[];
};

export type StudioHomeProps = {
  readonly locale: Locale;
  /** `null` when the deterministic overview read failed closed. */
  readonly overview?: StudioOverviewResult | null;
  readonly canCreateThread?: boolean;
};

export function StudioHome({
  locale,
  overview = null,
  canCreateThread = false,
}: StudioHomeProps) {
  const router = useRouter();
  const session = useStudioSession();
  const attachments = useStudioAttachments();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState("");
  const [skillKey, setSkillKey] = useState<string | null>(null);
  const [pendingClientMessageId, setPendingClientMessageId] = useState<
    string | null
  >(null);
  /** Thread created by a failed attempt, reused by Retry. */
  const [pendingAttempt, setPendingAttempt] =
    useState<PendingHomeAttempt | null>(null);

  const fillComposer = useCallback(
    (template: StudioTemplate) => {
      if (!template.starterKey) return;
      setDraft(studioCopy(locale, template.starterKey));
      setSkillKey(template.id);
      setPendingClientMessageId(null);
      setPendingAttempt(null);
      session.clearError();
      textareaRef.current?.focus();
    },
    [locale, session],
  );

  const runSend = useCallback(
    async (attempt: PendingHomeAttempt) => {
      const outcome = await session.send({
        threadId: attempt.threadId,
        text: attempt.text,
        skillKey: attempt.skillKey,
        locale,
        clientMessageId: attempt.clientMessageId,
        attachmentAssetIds: attempt.attachmentAssetIds,
      });
      if (outcome === null) return;
      if (!outcome.ok) {
        // The hook stored the error; remember the thread id (if any) so Retry
        // continues on the same thread instead of creating another one.
        const createdThreadId = outcome.error.threadId;
        if (createdThreadId !== null && createdThreadId !== attempt.threadId) {
          setPendingAttempt({ ...attempt, threadId: createdThreadId });
        }
        return;
      }
      const result = outcome.result;
      setDraft("");
      setSkillKey(null);
      setPendingClientMessageId(null);
      setPendingAttempt(null);
      attachments.clearAttachments();
      router.push(`/studio/t/${result.threadId}`);
    },
    [attachments, locale, router, session],
  );

  const handleSend = useCallback(() => {
    if (!canCreateThread || session.inFlight) return;
    if (attachments.uploading) return;
    const text = draft.trim();
    if (text.length === 0) return;
    const clientMessageId =
      pendingClientMessageId ?? createStudioClientMessageId();
    setPendingClientMessageId(clientMessageId);
    const attempt: PendingHomeAttempt = {
      text,
      skillKey,
      clientMessageId,
      threadId: pendingAttempt?.threadId ?? null,
      attachmentAssetIds: [...attachments.uploadedAssetIds],
    };
    setPendingAttempt(attempt);
    void runSend(attempt);
  }, [
    attachments,
    canCreateThread,
    draft,
    pendingAttempt,
    pendingClientMessageId,
    session.inFlight,
    skillKey,
    runSend,
  ]);

  const handleRetry = useCallback(() => {
    if (pendingAttempt === null || session.inFlight) return;
    void runSend(pendingAttempt);
  }, [pendingAttempt, runSend, session.inFlight]);

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
        className={styles["studio-section"]}
        aria-label={studioCopy(locale, "studio.home.composerTitle")}
      >
        <h2 className={styles["studio-section-title"]}>
          {studioCopy(locale, "studio.home.composerTitle")}
        </h2>
        <StudioComposer
          locale={locale}
          id="studio-home-composer"
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          {...(pendingAttempt ? { onRetry: handleRetry } : {})}
          sending={session.inFlight}
          error={
            pendingAttempt !== null ? (session.error?.copyKey ?? null) : null
          }
          sendDisabled={!canCreateThread}
          sendDisabledReason="studio.composer.viewerNote"
          skillKey={skillKey}
          onClearSkill={() => setSkillKey(null)}
          attachments={attachments.items}
          onAttachFiles={attachments.addFiles}
          onRemoveAttachment={attachments.removeAttachment}
          onRetryAttachment={attachments.retryAttachment}
          attachmentNotice={attachments.notice}
          showNewThreadHint
          textareaRef={textareaRef}
        />
      </section>

      <StudioHomeOverview locale={locale} overview={overview} />

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
          {STUDIO_TEMPLATES.map((template) => {
            const interactive =
              template.availability === "pilot" &&
              template.starterKey !== undefined;
            return (
              <li
                key={template.id}
                className={styles["studio-template-card"]}
                data-availability={template.availability}
                data-interactive={interactive ? "true" : "false"}
              >
                <div className={styles["studio-template-header"]}>
                  <h3 className={styles["studio-template-title"]}>
                    {studioCopy(locale, template.titleKey)}
                  </h3>
                  <span
                    className={styles["studio-badge"]}
                    data-availability={template.availability}
                  >
                    {studioCopy(
                      locale,
                      AVAILABILITY_KEY[template.availability],
                    )}
                  </span>
                </div>
                <p className={styles["studio-template-outcome"]}>
                  {studioCopy(locale, template.outcomeKey)}
                </p>
                <p className={styles["studio-template-limitation"]}>
                  {studioCopy(locale, template.limitationKey)}
                </p>
                {interactive ? (
                  <button
                    type="button"
                    className={styles["studio-template-fill"]}
                    onClick={() => fillComposer(template)}
                    disabled={session.inFlight}
                    title={studioCopy(locale, "studio.templates.fillHint")}
                  >
                    {studioCopy(locale, "studio.templates.fill")}
                  </button>
                ) : (
                  <p className={styles["studio-template-unavailable"]}>
                    {studioCopy(locale, "studio.honest.notYetAvailable")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
