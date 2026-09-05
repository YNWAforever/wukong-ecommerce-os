"use client";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  formatHkDate,
  formatNumber,
  stateLabel,
} from "../lib/ui-copy";
import { outcomeLabel, manifestReasonLabel } from "../lib/export-ui-copy";

import { useState } from "react";
import {
  ImportResultForm,
  ImportResultHistory,
  type ImportResultReceipt,
} from "./import-result-form";

type ManifestMember = {
  listingId: string;
  versionId: string | null;
  outcome: string;
  reason?: string;
  latestResult: ImportResultReceipt | null;
  history: ImportResultReceipt[];
};
export type WireExportReconciliationDetail = {
  attempt: {
    id: string;
    artifactStatus?: "pending" | "ready" | "failed" | null;
    artifactErrorCode?: string | null;
    rowCount: number;
    specVersion: string;
    createdAt: string;
  };
  reconciliation: {
    counts: {
      requested: number;
      included: number;
      excluded: number;
      noOp: number;
      accepted: number;
      rejected: number;
      unreported: number;
    };
    members: ManifestMember[];
    verificationStatus: "unverified";
  };
  capabilities: {
    canGenerateBulkUpdate: boolean;
    canRecordImportResult: boolean;
  };
};

export function ExportReconciliationPanel({
  detail: initialDetail,
}: {
  detail: WireExportReconciliationDetail;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [detail, setDetail] = useState(initialDetail);
  async function reload() {
    const response = await fetch(`/api/listings/export/${detail.attempt.id}`, {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Unable to reload export status (${response.status})`);
    setDetail((await response.json()) as WireExportReconciliationDetail);
  }
  const { attempt, reconciliation, capabilities } = detail;
  const ready = attempt.artifactStatus === "ready";
  return (
    <article
      className="reconciliation-panel"
      data-export-attempt-id={attempt.id}
    >
      <div className="jobs-row-header">
        <h3>
          {t("批量更新 XLSX 結果對帳", "Bulk Update XLSX reconciliation")}
        </h3>
        <span
          className={`connection-status status-${ready ? "succeeded" : attempt.artifactStatus === "failed" ? "failed" : "pending"}`}
        >
          {attempt.artifactStatus
            ? stateLabel(attempt.artifactStatus, locale)
            : t("歷史記錄", "Historical")}
        </span>
      </div>
      <p className="jobs-row-meta">
        {t("匯出記錄", "Attempt")} <code>{attempt.id}</code> ·{" "}
        {t("格式版本", "Spec")} {attempt.specVersion} ·{" "}
        <time dateTime={attempt.createdAt}>
          {formatHkDate(attempt.createdAt, locale)}
        </time>
      </p>
      <dl className="reconciliation-counts">
        <div>
          <dt>{t("要求", "Requested")}</dt>
          <dd>{formatNumber(reconciliation.counts.requested, locale)}</dd>
        </div>
        <div>
          <dt>{t("納入", "Included")}</dt>
          <dd>{formatNumber(reconciliation.counts.included, locale)}</dd>
        </div>
        <div>
          <dt>{t("排除", "Excluded")}</dt>
          <dd>{formatNumber(reconciliation.counts.excluded, locale)}</dd>
        </div>
        <div>
          <dt>{t("無變更", "No-op")}</dt>
          <dd>{formatNumber(reconciliation.counts.noOp, locale)}</dd>
        </div>
        <div>
          <dt>{t("操作員回報接受", "Accepted")}</dt>
          <dd>{formatNumber(reconciliation.counts.accepted, locale)}</dd>
        </div>
        <div>
          <dt>{t("操作員回報拒絕", "Rejected")}</dt>
          <dd>{formatNumber(reconciliation.counts.rejected, locale)}</dd>
        </div>
        <div>
          <dt>{t("未回報", "Unreported")}</dt>
          <dd>{formatNumber(reconciliation.counts.unreported, locale)}</dd>
        </div>
      </dl>
      <p className="helper-copy">
        {t(
          "驗證：未獨立核實 — 操作員回報並未與最新 SHOPLINE 匯出資料核對。",
          "Verification: Unverified — operator reports do not verify against a fresh SHOPLINE export.",
        )}
      </p>
      {ready ? (
        <a
          className="secondary-button"
          href={`/api/listings/export/${attempt.id}/download`}
        >
          {t("下載批量更新 XLSX", "Download Bulk Update XLSX")}
        </a>
      ) : (
        <p className="helper-copy">
          {t(
            "檔案尚未準備好，無法下載或回報結果。",
            "Artifact is not ready. Download and reporting are unavailable.",
          )}
        </p>
      )}
      <ul className="reconciliation-members">
        {reconciliation.members.map((member) => (
          <li key={member.listingId} data-listing-id={member.listingId}>
            <p>
              <strong>{member.listingId}</strong> ·{" "}
              {member.versionId ?? t("未有版本", "No version")} ·{" "}
              {outcomeLabel(member.outcome, locale)}
            </p>
            {member.reason ? (
              <p className="helper-copy">
                {manifestReasonLabel(member.reason, member.outcome, locale)}
              </p>
            ) : null}
            {member.latestResult ? (
              <div>
                <p>
                  {t("操作員回報", "Operator reported")}{" "}
                  {stateLabel(member.latestResult.outcome, locale)} ·{" "}
                  {t("修訂", "revision")}{" "}
                  {formatNumber(member.latestResult.revision, locale)}
                </p>
                {member.latestResult.rejectReason ? (
                  <p className="helper-copy">
                    {t("拒絕原因：", "Rejection reason:")}{" "}
                    {member.latestResult.rejectReason}
                  </p>
                ) : null}
              </div>
            ) : member.outcome === "included" ? (
              <p>{t("未回報", "Unreported")}</p>
            ) : null}
            <ImportResultHistory
              label={t("更正記錄", "Correction history")}
              results={member.history}
            />
            {ready &&
            member.outcome === "included" &&
            member.versionId &&
            capabilities.canRecordImportResult ? (
              <ImportResultForm
                listingId={member.listingId}
                mode="export"
                versionId={member.versionId}
                exportAttemptId={attempt.id}
                latestResult={member.latestResult}
                onRecorded={reload}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
