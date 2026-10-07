import Link from "next/link";
import type { WorkbenchItem, WorkbenchReason } from "@wukong/db";
import type { Locale } from "../lib/locale";
import { formatHkDate, formatNumber } from "../lib/ui-copy";
import { workbenchCopy } from "../lib/workbench-copy";
import { workbenchDestination } from "../lib/workbench-actions";
import { StatusPill, type StatusTone } from "./status-pill";

const reasonTone: Record<WorkbenchReason, StatusTone> = {
  failed: "danger",
  needs_info: "warning",
  review: "info",
  delivery: "success",
  result_needed: "warning",
  processing: "neutral",
  published: "success",
  result_reported: "neutral",
  preview_ready: "info",
  preview_partial: "warning",
  imported: "success",
  unknown: "neutral",
};
export type WorkbenchCapabilities = {
  canImport: boolean;
  canReview: boolean;
  canRecordImportResult: boolean;
};
export function WorkbenchList({
  items,
  capabilities,
  locale,
  returnTo,
}: {
  items: WorkbenchItem[];
  capabilities: WorkbenchCapabilities;
  locale: Locale;
  returnTo: string;
}) {
  const copy = workbenchCopy[locale];
  return (
    <ul className="workbench-list">
      {items.map((item) => (
        <li key={item.key} className="workbench-row">
          <div className="workbench-row-content">
            <div className="workbench-row-title">
              <h3>
                {item.title ||
                  (item.kind === "export"
                    ? `${copy.exportAttempt} ${item.id.slice(0, 8)}`
                    : copy.untitled)}
              </h3>
              <StatusPill tone={reasonTone[item.reason]}>
                {copy.reasons[item.reason]}
              </StatusPill>
            </div>
            {item.reason === "result_reported" && (
              <p>{copy.reportedQualifier}</p>
            )}
            <div className="workbench-meta">
              <span className="workbench-kind">{copy.kinds[item.kind]} · </span>
              {item.sourceLabel && <span>{item.sourceLabel} · </span>}
              {item.productCount !== null ? (
                <span>
                  {formatNumber(item.productCount, locale)}{" "}
                  {item.productCount === 1 ? copy.product : copy.products}{" "}
                  ·{" "}
                </span>
              ) : (
                <span>{copy.countUnavailable} · </span>
              )}
              <span>
                {item.timestampKind === "recorded"
                  ? copy.recorded
                  : copy.updated}
                :{" "}
                <time dateTime={item.occurredAt}>
                  {formatHkDate(item.occurredAt, locale)}
                </time>
              </span>
            </div>
          </div>
          <Link
            className="workbench-action"
            href={workbenchDestination(item, returnTo)}
          >
            {item.reason === "review" && capabilities.canReview
              ? copy.review
              : item.reason === "result_needed" &&
                  capabilities.canRecordImportResult
                ? copy.result
                : copy.view}
          </Link>
        </li>
      ))}
    </ul>
  );
}
