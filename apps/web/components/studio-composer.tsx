"use client";

import type { KeyboardEvent, RefObject } from "react";

import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The Studio composer (design spec §2.2 and §2.3 step 7).
 *
 * A controlled textarea plus Send/Attach. The component owns no network state:
 * the caller passes the draft, the send callback and the in-flight/error
 * states, so a failed send can keep the exact text and offer a retry (the
 * caller also keeps the client message id for that retry).
 *
 * Behaviours pinned here:
 *  - `maxlength=2000`, matching the API contract's `text` bound;
 *  - Enter sends and Shift+Enter inserts a newline, but an Enter that confirms
 *    an IME composition never sends (zh-Hant operators use IMEs, and the
 *    `isComposing`/keyCode 229 guard is the standard fix);
 *  - Send is disabled with a visible reason (empty draft, sending, viewer
 *    role, too long) and Attach is disabled with the reason that attachments
 *    are not available in this build;
 *  - the permanent disclaimer is always present.
 */

const MAX_TEXT_LENGTH = 2000;

export type StudioComposerProps = {
  readonly locale: Locale;
  /** Prefix for the element ids; two composers can share a page. */
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onRetry?: () => void;
  readonly sending?: boolean;
  /** Copy key for the last failed send; rendered as an alert with a retry. */
  readonly error?: StudioCopyKey | null;
  readonly disabled?: boolean;
  readonly disabledReason?: StudioCopyKey | null;
  /** Disables Send (not typing) when the role cannot send yet. */
  readonly sendDisabled?: boolean;
  readonly sendDisabledReason?: StudioCopyKey | null;
  readonly skillKey?: string | null;
  readonly onClearSkill?: () => void;
  readonly showNewThreadHint?: boolean;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
};

export function StudioComposer({
  locale,
  id,
  value,
  onChange,
  onSend,
  onRetry,
  sending = false,
  error = null,
  disabled = false,
  disabledReason = null,
  sendDisabled = false,
  sendDisabledReason = null,
  skillKey = null,
  onClearSkill,
  showNewThreadHint = false,
  textareaRef,
}: StudioComposerProps) {
  const inputId = `${id}-input`;
  const hintId = `${id}-hint`;
  const disclaimerId = `${id}-disclaimer`;
  const errorId = `${id}-error`;

  const trimmed = value.trim();
  const tooLong = value.length > MAX_TEXT_LENGTH;
  const canSend =
    !disabled && !sendDisabled && !sending && trimmed.length > 0 && !tooLong;

  let reasonKey: StudioCopyKey | null = null;
  if (disabled) reasonKey = disabledReason ?? "studio.error.forbidden";
  else if (sendDisabled) reasonKey = sendDisabledReason ?? "studio.error.forbidden";
  else if (sending) reasonKey = "studio.composer.working";
  else if (trimmed.length === 0) reasonKey = "studio.composer.empty";
  else if (tooLong) reasonKey = "studio.composer.tooLong";

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    const native = event.nativeEvent;
    // An Enter that confirms an IME candidate must not send.
    if (native.isComposing || native.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  return (
    <section
      className={styles["studio-composer"]}
      aria-label={studioCopy(locale, "studio.composer.label")}
      aria-busy={sending}
    >
      <label htmlFor={inputId} className={styles["studio-visually-hidden"]}>
        {studioCopy(locale, "studio.composer.label")}
      </label>
      <textarea
        ref={textareaRef}
        id={inputId}
        className={styles["studio-composer-textarea"]}
        value={value}
        rows={3}
        maxLength={MAX_TEXT_LENGTH}
        placeholder={studioCopy(locale, "studio.composer.placeholder")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-describedby={`${hintId} ${disclaimerId}`}
        disabled={disabled}
      />

      {skillKey ? (
        <p className={styles["studio-skill-chip"]}>
          <span className={styles["studio-skill-chip-label"]}>
            {studioCopy(locale, "studio.composer.skillLabel")}
          </span>
          <span className={styles["studio-skill-chip-value"]}>{skillKey}</span>
          {onClearSkill ? (
            <button
              type="button"
              className={styles["studio-skill-chip-clear"]}
              onClick={onClearSkill}
              disabled={sending}
            >
              {studioCopy(locale, "studio.composer.clearSkill")}
            </button>
          ) : null}
        </p>
      ) : null}

      <div className={styles["studio-composer-actions"]}>
        <button
          type="button"
          className={styles["studio-composer-send"]}
          onClick={onSend}
          disabled={!canSend}
          aria-describedby={hintId}
        >
          {studioCopy(locale, "studio.composer.send")}
        </button>
        <button
          type="button"
          className={styles["studio-composer-attach"]}
          disabled
          aria-describedby={hintId}
          title={studioCopy(locale, "studio.composer.attachUnavailable")}
        >
          {studioCopy(locale, "studio.composer.attach")}
        </button>
        <p
          id={hintId}
          className={styles["studio-composer-hint"]}
          role={sending ? "status" : undefined}
          aria-live={sending ? "polite" : undefined}
        >
          {reasonKey
            ? studioCopy(locale, reasonKey)
            : studioCopy(locale, "studio.composer.hint")}
        </p>
      </div>

      {showNewThreadHint ? (
        <p className={styles["studio-composer-hint"]}>
          {studioCopy(locale, "studio.composer.newThreadHint")}
        </p>
      ) : null}

      {error ? (
        <div
          id={errorId}
          className={styles["studio-composer-error"]}
          role="alert"
        >
          <p>{studioCopy(locale, error)}</p>
          {onRetry ? (
            <button
              type="button"
              className={styles["studio-composer-retry"]}
              onClick={onRetry}
              disabled={sending}
            >
              {studioCopy(locale, "studio.composer.retry")}
            </button>
          ) : null}
        </div>
      ) : null}

      <p id={disclaimerId} className={styles["studio-disclaimer"]}>
        {studioCopy(locale, "studio.composer.disclaimer")}
      </p>
      <p className={styles["studio-composer-hint"]}>
        {studioCopy(locale, "studio.composer.draftKept")}
      </p>
    </section>
  );
}
