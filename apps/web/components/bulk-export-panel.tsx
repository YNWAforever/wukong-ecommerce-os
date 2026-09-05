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
      setResult(body);
      if (body.exportAttemptId) {
        await loadDetail(body.exportAttemptId);
      } else if (!response.ok) {
        throw new Error(
          body.message ?? `Unable to generate export (${response.status})`,
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
      {result && !result.exportAttemptId ? (
        <div className="manifest-summary">
          <p>
            No artifact was created because every requested listing was excluded
            or unchanged.
          </p>
          <ul>
            {result.manifest?.map((item) => (
              <li key={item.listingId}>
                {item.listingId}: {item.reason ?? item.outcome}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail ? <ExportReconciliationPanel detail={detail} /> : null}
    </section>
  );
}
