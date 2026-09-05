"use client";

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
        <h3>Bulk Update XLSX reconciliation</h3>
        <span
          className={`connection-status status-${ready ? "succeeded" : attempt.artifactStatus === "failed" ? "failed" : "pending"}`}
        >
          {attempt.artifactStatus ?? "historical"}
        </span>
      </div>
      <p className="jobs-row-meta">
        Attempt <code>{attempt.id}</code> · Spec {attempt.specVersion}
      </p>
      <dl className="reconciliation-counts">
        <div>
          <dt>Requested</dt>
          <dd>{reconciliation.counts.requested}</dd>
        </div>
        <div>
          <dt>Included</dt>
          <dd>{reconciliation.counts.included}</dd>
        </div>
        <div>
          <dt>Excluded</dt>
          <dd>{reconciliation.counts.excluded}</dd>
        </div>
        <div>
          <dt>No-op</dt>
          <dd>{reconciliation.counts.noOp}</dd>
        </div>
        <div>
          <dt>Accepted</dt>
          <dd>{reconciliation.counts.accepted}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>{reconciliation.counts.rejected}</dd>
        </div>
        <div>
          <dt>Unreported</dt>
          <dd>{reconciliation.counts.unreported}</dd>
        </div>
      </dl>
      <p className="helper-copy">
        Verification: Unverified — operator reports do not verify against a
        fresh SHOPLINE export.
      </p>
      {ready ? (
        <a
          className="secondary-button"
          href={`/api/listings/export/${attempt.id}/download`}
        >
          Download Bulk Update XLSX
        </a>
      ) : (
        <p className="helper-copy">
          Artifact is not ready. Download and reporting are unavailable.
        </p>
      )}
      <ul className="reconciliation-members">
        {reconciliation.members.map((member) => (
          <li key={member.listingId} data-listing-id={member.listingId}>
            <p>
              <strong>{member.listingId}</strong> ·{" "}
              {member.versionId ?? "No version"} · {member.outcome}
            </p>
            {member.reason ? (
              <p className="helper-copy">{member.reason}</p>
            ) : null}
            {member.latestResult ? (
              <div>
                <p>
                  Operator reported {member.latestResult.outcome} · revision{" "}
                  {member.latestResult.revision}
                </p>
                {member.latestResult.rejectReason ? (
                  <p className="helper-copy">
                    Rejection reason: {member.latestResult.rejectReason}
                  </p>
                ) : null}
              </div>
            ) : member.outcome === "included" ? (
              <p>Unreported</p>
            ) : null}
            <ImportResultHistory
              label="Correction history"
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
