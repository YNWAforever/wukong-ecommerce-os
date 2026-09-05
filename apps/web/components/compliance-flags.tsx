"use client";
import { complianceLabel } from "../lib/review-ui-copy";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  commonCopy,
  formatNumber,
  safeUiError,
} from "../lib/ui-copy";

import { useId, useState } from "react";

import type { BlockingFlag } from "./listing-view-models";

type ComplianceFlagsProps = {
  flags: BlockingFlag[];
  canResolve?: boolean;
  onResolve?: (flagId: string, reason: string) => Promise<void> | void;
};

export function ComplianceFlags({
  flags,
  canResolve = false,
  onResolve,
}: ComplianceFlagsProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const errorId = useId();
  const [errorFlagId, setErrorFlagId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (flags.length === 0)
    return (
      <p className="success-note" role="status">
        {t("沒有需要處理的合規提示", "No open compliance flags")}
      </p>
    );

  async function resolve(flag: BlockingFlag) {
    const reason = (reasons[flag.id] ?? "").trim();
    if (reason.length < 10) {
      setError("reason_short");
      setErrorFlagId(flag.id);
      return;
    }
    setError(null);
    setPendingId(flag.id);
    try {
      await onResolve?.(flag.id, reason);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "action_failed");
      setErrorFlagId(flag.id);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="flags" aria-labelledby="flags-heading">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">{t("合規提示", "Compliance")}</p>
          <h2 id="flags-heading">
            {t("批准前需要處理", "Resolve before approval")}
          </h2>
        </div>
        <span className="flag-count">
          {formatNumber(
            flags.filter((flag) => flag.status === "open").length,
            locale,
          )}{" "}
          {t("項開放", "open")}
        </span>
      </div>
      {error ? (
        <p className="inline-warning" role="alert" id={errorId}>
          {error === "reason_short"
            ? t(
                "處理理由至少需要 10 個字元。",
                "Resolution reason must contain at least 10 characters.",
              )
            : safeUiError(error, locale, "action")}
        </p>
      ) : null}
      <ul className="flag-list">
        {flags.map((flag) => (
          <li className={`flag-item flag-${flag.status}`} key={flag.id}>
            <div className="flag-marker" aria-hidden="true" />
            <div className="flag-content">
              <h3>{complianceLabel(flag.code, locale, "label")}</h3>
              <p>{complianceLabel(flag.code, locale, "description")}</p>
              <span className="flag-status">
                {flag.status === "open"
                  ? t("待處理", "Open")
                  : t("已處理", "Resolved")}
              </span>
              {flag.status === "resolved" && flag.resolutionReason ? (
                <p className="helper-copy">
                  {t("處理理由：", "Resolution reason:")}
                  {flag.resolutionReason}
                </p>
              ) : null}
              {flag.status === "open" && canResolve && onResolve ? (
                <div className="flag-resolution">
                  <label htmlFor={`flag-reason-${flag.id}`}>
                    {t("處理理由", "Resolution reason")}
                  </label>
                  <textarea
                    id={`flag-reason-${flag.id}`}
                    value={reasons[flag.id] ?? ""}
                    minLength={10}
                    maxLength={1000}
                    rows={3}
                    placeholder={t(
                      "請記錄核對結果或修改內容（至少 10 個字元）",
                      "Record the checks or changes (at least 10 characters)",
                    )}
                    aria-invalid={errorFlagId === flag.id && !!error}
                    aria-describedby={
                      errorFlagId === flag.id && error ? errorId : undefined
                    }
                    onChange={(event) =>
                      setReasons((current) => ({
                        ...current,
                        [flag.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={pendingId === flag.id}
                    onClick={() => void resolve(flag)}
                  >
                    {pendingId === flag.id
                      ? commonCopy[locale].loading
                      : t("標記為已處理", "Resolve flag")}
                  </button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
