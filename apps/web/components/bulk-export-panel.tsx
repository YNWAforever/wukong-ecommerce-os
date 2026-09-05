"use client";

import { useMemo, useRef, useState } from "react";
import {
  ExportReconciliationPanel,
  type WireExportReconciliationDetail,
} from "./export-reconciliation-panel";

type ExportResponse = {
  exportAttemptId: string | null;
  artifactStatus?: "pending" | "ready" | "failed";
  manifest?: Array<{
    listingId: string;
    versionId: string | null;
    outcome: string;
    reason?: string;
  }>;
  rowCount?: number;
  message?: string;
};

function isCompletedZeroRowResponse(
  response: ExportResponse,
): response is ExportResponse & {
  exportAttemptId: null;
  rowCount: 0;
  manifest: NonNullable<ExportResponse["manifest"]>;
} {
  return (
    response.exportAttemptId === null &&
    response.rowCount === 0 &&
    Array.isArray(response.manifest)
  );
}

function selectionIdentity(listingIds: readonly string[]): string {
  return [...listingIds].sort().join("\u001f");
}

export function BulkExportPanel({
  listingIds,
  canGenerate,
}: {
  listingIds: readonly string[];
  canGenerate: boolean;
}) {
  const currentSelection = useMemo(
    () => selectionIdentity(listingIds),
    [listingIds],
  );
  const [attestedSelection, setAttestedSelection] = useState<string | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResponse | null>(null);
  const [detail, setDetail] = useState<WireExportReconciliationDetail | null>(
    null,
  );
  const inFlight = useRef(false);
  const attested =
    currentSelection.length > 0 && attestedSelection === currentSelection;

  async function loadDetail(attemptId: string) {
    setDetailBusy(true);
    try {
      const response = await fetch(`/api/listings/export/${attemptId}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`Unable to load export status (${response.status})`);
      setDetail((await response.json()) as WireExportReconciliationDetail);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load export status",
      );
    } finally {
      setDetailBusy(false);
    }
  }

  async function generate() {
    if (
      inFlight.current ||
      !canGenerate ||
      !attested ||
      listingIds.length === 0
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    setDetail(null);
    const submittedIds = [...listingIds];
    try {
      const response = await fetch("/api/listings/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listingIds: submittedIds,
          freshnessAttested: true,
        }),
      });
      const body = (await response.json()) as ExportResponse;
      if (!response.ok) {
        if (body.exportAttemptId) {
          setResult(body);
          await loadDetail(body.exportAttemptId);
          return;
        }
        throw new Error(
          body.message ?? `Unable to generate export (${response.status})`,
        );
      }
      if (body.exportAttemptId) {
        setResult(body);
        await loadDetail(body.exportAttemptId);
      } else if (isCompletedZeroRowResponse(body)) {
        setResult(body);
      } else {
        throw new Error(
          "The export response was incomplete; retry the export.",
        );
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to generate export",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const completedZeroRow =
    result && isCompletedZeroRowResponse(result) ? result : null;
  const completedCounts = completedZeroRow
    ? {
        requested: completedZeroRow.manifest.length,
        included: completedZeroRow.manifest.filter(
          (item) => item.outcome === "included",
        ).length,
        noOp: completedZeroRow.manifest.filter(
          (item) => item.outcome === "excluded_no_op",
        ).length,
      }
    : null;
  const excludedCount = completedCounts
    ? completedCounts.requested -
      completedCounts.included -
      completedCounts.noOp
    : 0;

  return (
    <section className="bulk-export-panel" aria-label="Bulk Update XLSX export">
      <p>
        <strong>{listingIds.length}</strong> listing(s) selected for this
        export.
      </p>
      <label className="freshness-attestation">
        <input
          type="checkbox"
          checked={attested}
          onChange={(event) =>
            setAttestedSelection(event.target.checked ? currentSelection : null)
          }
        />{" "}
        I confirm this SHOPLINE source export is still current.
      </label>
      <button
        className="primary-button"
        type="button"
        disabled={!canGenerate || !attested || listingIds.length === 0 || busy}
        onClick={() => void generate()}
      >
        Generate Bulk Update XLSX
      </button>
      {!canGenerate ? (
        <p className="helper-copy">Reviewer access required.</p>
      ) : null}
      {error ? (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      ) : null}
      {result?.exportAttemptId && !detail ? (
        <article
          className="reconciliation-panel"
          data-export-attempt-id={result.exportAttemptId}
        >
          <h3>Bulk Update XLSX export attempt</h3>
          <p className="jobs-row-meta">
            Attempt <code>{result.exportAttemptId}</code>
          </p>
          <p>Artifact status: {result.artifactStatus ?? "pending"}</p>
          <button
            className="secondary-button"
            type="button"
            disabled={detailBusy}
            onClick={() => void loadDetail(result.exportAttemptId!)}
          >
            Retry attempt details
          </button>
        </article>
      ) : null}
      {completedZeroRow && completedCounts ? (
        <div className="manifest-summary" data-zero-row-export-summary>
          <h3>Bulk Update XLSX export completed</h3>
          <p>
            No artifact was created because every requested listing was excluded
            or unchanged.
          </p>
          <p>
            Requested: {completedCounts.requested} · Included:{" "}
            {completedCounts.included} · Excluded: {excludedCount} · No-op:{" "}
            {completedCounts.noOp}
          </p>
          <ul>
            {completedZeroRow.manifest.map((item) => (
              <li key={item.listingId} data-listing-id={item.listingId}>
                Listing <code>{item.listingId}</code> · Version{" "}
                <code>{item.versionId ?? "not available"}</code> · Outcome{" "}
                <code>{item.outcome}</code> · Reason{" "}
                {item.reason ?? "No reason provided"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail ? <ExportReconciliationPanel detail={detail} /> : null}
    </section>
  );
}
