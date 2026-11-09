"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import type { Locale } from "../lib/locale";
import {
  STUDIO_ATTACHMENT_ACCEPT,
  type StudioComposerAttachment,
  type StudioComposerAttachmentState,
} from "../lib/studio/attachments";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

/**
 * The Studio composer (design spec §2.2 and §2.3 step 7).
 *
 * A controlled textarea plus Send/Attach. The component owns no network state:
 * the caller passes the draft, the send callback, the in-flight/error states
 * and the attachment chips, so a failed send can keep the exact text and offer
 * a retry (the caller also keeps the client message id and the already
 * finalized attachment ids for that retry).
 *
 * Behaviours pinned here:
 *  - `maxlength=2000`, matching the API contract's `text` bound;
 *  - Enter sends and Shift+Enter inserts a newline, but an Enter that confirms
 *    an IME composition never sends (zh-Hant operators use IMEs, and the
 *    `isComposing`/keyCode 229 guard is the standard fix);
 *  - Send is disabled with a visible reason (empty draft, sending, viewer
 *    role, too long, or an attachment still uploading) and Attach is available
 *    only when the caller wired an upload handler and the control is not
 *    otherwise disabled; the file input accepts exactly the MIME types the
 *    presign/finalize routes accept;
 *  - each attachment chip shows its real state (uploading/uploaded/failed/
 *    unsupported/empty/too large/cancelled) with remove (and retry where a
 *    retry can help); nothing says "uploaded" before finalize succeeded;
 *  - the permanent disclaimer is always present.
 */

const MAX_TEXT_LENGTH = 2000;

const ATTACHMENT_STATE_KEY: Record<
  StudioComposerAttachmentState,
  StudioCopyKey
> = {
  uploading: "studio.composer.attachment.uploading",
  uploaded: "studio.composer.attachment.uploaded",
  failed: "studio.composer.attachment.failed",
  cancelled: "studio.composer.attachment.cancelled",
  unsupported_type: "studio.composer.attachment.unsupported",
  empty_file: "studio.composer.attachment.empty",
  too_large: "studio.composer.attachment.tooLarge",
};

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
  /** Attachment chips owned by `useStudioAttachments`. */
  readonly attachments?: readonly StudioComposerAttachment[];
  readonly onAttachFiles?: (files: File[]) => void;
  readonly onRemoveAttachment?: (id: string) => void;
  readonly onRetryAttachment?: (id: string) => void;
  readonly attachmentNotice?: StudioCopyKey | null;
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
  attachments = [],
  onAttachFiles,
  onRemoveAttachment,
  onRetryAttachment,
  attachmentNotice = null,
}: StudioComposerProps) {
  const inputId = `${id}-input`;
  const hintId = `${id}-hint`;
  const disclaimerId = `${id}-disclaimer`;
  const errorId = `${id}-error`;
  const filesId = `${id}-files`;
  const attachmentHintId = `${id}-attachment-hint`;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Honest elapsed timer while the synchronous turn runs. It shows duration
  // only; it never invents per-step progress the server did not report.
  useEffect(() => {
    if (!sending) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [sending]);

  const trimmed = value.trim();
  const tooLong = value.length > MAX_TEXT_LENGTH;
  const uploadsPending = attachments.some(
    (attachment) => attachment.state === "uploading",
  );
  const canSend =
    !disabled &&
    !sendDisabled &&
    !sending &&
    !uploadsPending &&
    trimmed.length > 0 &&
    !tooLong;

  let reasonKey: StudioCopyKey | null = null;
  if (disabled) reasonKey = disabledReason ?? "studio.error.forbidden";
  else if (sendDisabled)
    reasonKey = sendDisabledReason ?? "studio.error.forbidden";
  else if (sending) reasonKey = "studio.composer.working";
  else if (uploadsPending)
    reasonKey = "studio.composer.attachment.waitForUploads";
  else if (trimmed.length === 0) reasonKey = "studio.composer.empty";
  else if (tooLong) reasonKey = "studio.composer.tooLong";

  const attachAvailable =
    Boolean(onAttachFiles) && !disabled && !sendDisabled && !sending;
  const attachDisabledReason: StudioCopyKey | null = !onAttachFiles
    ? "studio.composer.attachUnavailable"
    : sendDisabled
      ? "studio.composer.attachment.viewerNote"
      : null;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    const native = event.nativeEvent;
    // An Enter that confirms an IME candidate must not send.
    if (native.isComposing || native.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    // A native FileList is live, so copy it before the input is cleared.
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length > 0) onAttachFiles?.(files);
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

      {attachments.length > 0 ? (
        <ul
          className={styles["studio-composer-attachments"]}
          aria-label={studioCopy(
            locale,
            "studio.composer.attachment.listLabel",
          )}
        >
          {attachments.map((attachment) => {
            const retryable =
              attachment.state === "failed" || attachment.state === "cancelled";
            return (
              <li
                key={attachment.id}
                className={styles["studio-composer-attachment"]}
                data-state={attachment.state}
              >
                <span
                  className={styles["studio-composer-attachment-name"]}
                  title={attachment.fileName}
                >
                  {attachment.fileName}
                </span>
                <span
                  className={styles["studio-composer-attachment-state"]}
                  role="status"
                >
                  {studioCopy(locale, ATTACHMENT_STATE_KEY[attachment.state])}
                </span>
                {attachment.errorKey &&
                (attachment.state === "failed" ||
                  attachment.state === "cancelled") ? (
                  <span className={styles["studio-composer-attachment-error"]}>
                    {studioCopy(locale, attachment.errorKey)}
                  </span>
                ) : null}
                <span className={styles["studio-composer-attachment-actions"]}>
                  {retryable && onRetryAttachment ? (
                    <button
                      type="button"
                      className={styles["studio-skill-chip-clear"]}
                      onClick={() => onRetryAttachment(attachment.id)}
                      disabled={sending}
                    >
                      {studioCopy(locale, "studio.composer.attachment.retry")}
                    </button>
                  ) : null}
                  {onRemoveAttachment ? (
                    <button
                      type="button"
                      className={styles["studio-skill-chip-clear"]}
                      onClick={() => onRemoveAttachment(attachment.id)}
                      disabled={sending}
                    >
                      {studioCopy(locale, "studio.composer.attachment.remove")}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {attachmentNotice ? (
        <p
          className={styles["studio-composer-hint"]}
          role="status"
          aria-live="polite"
        >
          {studioCopy(locale, attachmentNotice)}
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
          disabled={!attachAvailable}
          onClick={() => fileInputRef.current?.click()}
          aria-describedby={`${hintId} ${attachmentHintId}`}
          {...(attachDisabledReason
            ? { title: studioCopy(locale, attachDisabledReason) }
            : {})}
        >
          {studioCopy(locale, "studio.composer.attach")}
        </button>
        <input
          ref={fileInputRef}
          id={filesId}
          className={styles["studio-visually-hidden"]}
          type="file"
          multiple
          accept={STUDIO_ATTACHMENT_ACCEPT}
          onChange={handleFiles}
          disabled={!attachAvailable}
          tabIndex={-1}
          aria-hidden="true"
        />
        <p
          id={hintId}
          className={styles["studio-composer-hint"]}
          role={sending ? "status" : undefined}
          aria-live={sending ? "polite" : undefined}
        >
          {sending
            ? `${studioCopy(locale, "studio.composer.working")}${elapsedSeconds > 0 ? ` · ${elapsedSeconds}s` : ""}`
            : reasonKey
              ? studioCopy(locale, reasonKey)
              : studioCopy(locale, "studio.composer.hint")}
        </p>
      </div>

      {sending ? (
        <p
          className={styles["studio-composer-hint"]}
          role="status"
          aria-live="polite"
        >
          {studioCopy(locale, "studio.composer.progressNote")}
        </p>
      ) : null}

      <p id={attachmentHintId} className={styles["studio-composer-hint"]}>
        {studioCopy(locale, "studio.composer.attachment.hint")}
      </p>

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
