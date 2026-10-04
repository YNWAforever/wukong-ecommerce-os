"use client";
import { BulkExportPanel } from "./bulk-export-panel";
import type {
  ExportRepair,
  RepairSourceObservation,
} from "../lib/bulk-export-contract";
import { FreshExportVerificationPanel } from "./fresh-export-verification-panel";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  formatHkDate,
  formatNumber,
  stateLabel,
} from "../lib/ui-copy";
import { outcomeLabel, manifestReasonLabel } from "../lib/export-ui-copy";

import { useEffect, useRef, useState } from "react";
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
  repairSourceObservations?: RepairSourceObservation[];
  attempt: {
    id: string;
    sourceAttestation?: Array<{
      listingId: string;
      contentDigest: string;
    }> | null;
    artifactStatus?: "pending" | "ready" | "failed" | null;
    artifactErrorCode?: string | null;
    rowCount: number;
    specVersion: string;
    createdAt: string;
  };
  reconciliation: {
    repairOf?: ExportRepair | null;
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

// Receipts are append-only and revisions increase within an exact manifest member.
// Merge evidence rather than response arrival order: parent reads and report reloads
// can overlap, and each may contain a newer receipt for a different member.
function mergeDetail(
  current: WireExportReconciliationDetail,
  incoming: WireExportReconciliationDetail,
): WireExportReconciliationDetail {
  if (current.attempt.id !== incoming.attempt.id) return incoming;
  const members = incoming.reconciliation.members.map((member) => {
    const previous = current.reconciliation.members.find(
      (candidate) =>
        candidate.listingId === member.listingId &&
        candidate.versionId === member.versionId &&
        candidate.outcome === member.outcome,
    );
    if (
      !previous ||
      (previous.latestResult?.revision ?? 0) <=
        (member.latestResult?.revision ?? 0)
    )
      return member;
    return {
      ...member,
      latestResult: previous.latestResult,
      history: previous.history,
    };
  });
  const included = members.filter((member) => member.outcome === "included");
  const accepted = included.filter(
    (member) => member.latestResult?.outcome === "accepted",
  ).length;
  const rejected = included.filter(
    (member) => member.latestResult?.outcome === "rejected",
  ).length;
  return {
    ...incoming,
    repairSourceObservations:
      incoming.repairSourceObservations ?? current.repairSourceObservations,
    reconciliation: {
      ...incoming.reconciliation,
      members,
      counts: {
        ...incoming.reconciliation.counts,
        accepted,
        rejected,
        unreported: included.length - accepted - rejected,
      },
    },
  };
}

export function ExportReconciliationPanel({
  detail: initialDetail,
}: {
  detail: WireExportReconciliationDetail;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [view, setView] = useState({
    detail: initialDetail,
    parent: initialDetail,
  });
  const latestReload = useRef(0);
  const [showRepair, setShowRepair] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairError, setRepairError] = useState(false);
  const active = useRef(true);
  const repairRequest = useRef(0);
  const currentParent = useRef(initialDetail);
  currentParent.current = initialDetail;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    setRepairBusy(false);
    repairRequest.current += 1;
  }, [initialDetail]);
  useEffect(() => {
    setShowRepair(false);
    setRepairError(false);
    repairRequest.current += 1;
  }, [
    initialDetail.attempt.id,
    initialDetail.capabilities.canGenerateBulkUpdate,
  ]);
  const { detail } = view;
  // Update during render so children never commit stale predecessor props. This
  // retains the same form instance and its in-flight/idempotency refs.
  if (view.parent !== initialDetail) {
    setView((current) => ({
      parent: initialDetail,
      detail: mergeDetail(current.detail, initialDetail),
    }));
  }
  async function reload() {
    const request = ++latestReload.current;
    const response = await fetch(`/api/listings/export/${detail.attempt.id}`, {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Unable to reload export status (${response.status})`);
    const incoming = (await response.json()) as WireExportReconciliationDetail;
    if (
      incoming.attempt?.id !== detail.attempt.id ||
      !incoming.reconciliation ||
      !incoming.capabilities
    )
      throw new Error("Incomplete export status");
    setView((current) => {
      if (
        current.detail.attempt.id !== detail.attempt.id ||
        incoming.attempt.id !== detail.attempt.id
      )
        return current;
      // Metadata has no receipt revision. A parent refresh supersedes callbacks
      // bound to older props; a later local request supersedes earlier requests.
      // Obsolete reads can still contribute independently newer receipt evidence.
      const ownsMetadata =
        current.parent === initialDetail && request === latestReload.current;
      return {
        ...current,
        detail: ownsMetadata
          ? mergeDetail(current.detail, incoming)
          : mergeDetail(incoming, current.detail),
      };
    });
  }
  async function prepareRepair() {
    if (showRepair) {
      setShowRepair(false);
      return;
    }
    if (repairBusy || !detail.capabilities.canGenerateBulkUpdate) return;
    const parent = currentParent.current,
      request = ++repairRequest.current;
    const owns = () =>
      active.current &&
      currentParent.current === parent &&
      repairRequest.current === request;
    setRepairBusy(true);
    setRepairError(false);
    try {
      await reload();
      if (owns()) setShowRepair(true);
    } catch {
      if (owns()) setRepairError(true);
    } finally {
      if (owns()) setRepairBusy(false);
    }
  }
  const { attempt, reconciliation, capabilities } = detail;
  const ready = attempt.artifactStatus === "ready";
  const rejectedMembers = reconciliation.members.filter(
    (member) =>
      member.outcome === "included" &&
      member.latestResult?.outcome === "rejected",
  );
  const repairListings = rejectedMembers.flatMap((member) => {
    const attested = detail.repairSourceObservations?.find(
      (listing) => listing.listingId === member.listingId,
    );
    return attested
      ? [
          {
            listingId: attested.listingId,
            contentDigest: attested.contentDigest,
          },
        ]
      : [];
  });
  const repair: ExportRepair = {
    exportAttemptId: attempt.id,
    members: rejectedMembers.map((member) => ({
      listingId: member.listingId,
      resultId: member.latestResult!.id,
      revision: member.latestResult!.revision,
    })),
  };
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
      {reconciliation.repairOf ? (
        <p>
          {t("修復來源匯出", "Repair of export attempt")}{" "}
          <code>{reconciliation.repairOf.exportAttemptId}</code>
        </p>
      ) : null}
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
      {ready &&
      capabilities.canGenerateBulkUpdate &&
      rejectedMembers.length > 0 ? (
        <section aria-label={t("修復被拒絕項目", "Repair rejected items")}>
          <p>
            {t(
              "先開啟被拒絕商品修正內容並重新批准，再預覽修復檔案。已接受項目不會重送。",
              "Repair and reapprove the rejected listings before previewing a repair file. Accepted items are not resent.",
            )}
          </p>
          <ul>
            {rejectedMembers.map((member) => (
              <li key={member.listingId}>
                <a href={"/listings/" + member.listingId + "?returnTo=%2Fjobs"}>
                  {t("審核被拒絕商品", "Review rejected listing")}{" "}
                  {member.listingId}
                </a>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="secondary-button"
            disabled={repairBusy}
            onClick={() => void prepareRepair()}
          >
            {t(
              "預覽只含拒絕項目的修復 XLSX",
              "Preview rejected-only repair XLSX",
            )}
          </button>
          {showRepair ? (
            <ul>
              {detail.repairSourceObservations?.map((source) => (
                <li key={source.listingId}>
                  {source.listingId} ·{" "}
                  {t("目前來源匯入", "Current source import")}{" "}
                  <code>{source.sourceImportId}</code> ·{" "}
                  <code>{source.remoteProductId}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {repairError ? (
            <p role="alert">
              {t(
                "未能載入目前的修復來源，請重試。",
                "Current repair sources could not be loaded. Retry.",
              )}
            </p>
          ) : null}
          {showRepair && repairListings.length === rejectedMembers.length ? (
            <BulkExportPanel
              listings={repairListings}
              canGenerate={capabilities.canGenerateBulkUpdate}
              repair={repair}
            />
          ) : null}
          {showRepair && repairListings.length !== rejectedMembers.length ? (
            <p>
              {t(
                "目前來源身份不完整或已變更，請開啟商品核實來源。",
                "Current source identity is incomplete or changed. Open the listing and check its source.",
              )}
            </p>
          ) : null}
        </section>
      ) : null}
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
                  {member.latestResult.outcome === "accepted"
                    ? t("操作員回報接受", "Operator reported accepted")
                    : t("操作員回報拒絕", "Operator reported rejected")}{" "}
                  · {t("修訂", "revision")}{" "}
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
            {ready && member.outcome === "included" && member.versionId ? (
              <ImportResultForm
                key={JSON.stringify([
                  attempt.id,
                  member.listingId,
                  member.versionId,
                ])}
                unavailable={!capabilities.canRecordImportResult}
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
      {ready && capabilities.canGenerateBulkUpdate ? (
        <FreshExportVerificationPanel key={attempt.id} attemptId={attempt.id} />
      ) : null}
    </article>
  );
}
